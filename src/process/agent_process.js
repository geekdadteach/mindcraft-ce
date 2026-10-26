import { spawn } from 'child_process';
import { logoutAgent } from '../mindcraft/mindserver.js';
import { bobRuntimePath } from '../utils/bob_runtime_paths.js';

// [ai-player] Reconnect: when the agent process exits (kick / connection end / crash) or the watchdog
// kills a hung one, restart it with backoff 30 s -> 60 -> 120 -> 240 -> 300 s (cap), retrying forever.
// Backoff resets after the agent ran 10+ minutes. Memory + self_prompt state reload from memory.json (-l true),
// no init_message, so a reconnect does not chat.
const MIN_RESTART_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const STABLE_RUN_MS = 10 * 60_000;
// Watchdog: the agent sends a heartbeat every 10 s with the time of its last server packet.
const HEARTBEAT_TIMEOUT_MS = 90_000;     // no heartbeat -> event loop hung
const PACKET_SILENCE_MS = 120_000;       // spawned but no packets from the server -> dead connection
const FIRST_HEARTBEAT_MS = 120_000;
const WATCHDOG_TICK_MS = 5_000;
const STACK_AFTER_MS = 30_000;           // heartbeat missing this long -> log the blocked JS stack once
const INSPECT_PORT = 9239;

// [ai-player] Pause the agent over the inspector (loopback), log where its JS is, resume. Best effort, 10 s cap.
async function captureBlockedStack(pid, blockedS) {
    let ws = null;
    const done = (msg) => { if (msg) console.error(msg); try { ws?.close(); } catch (_) {} };
    try {
        const ctl = AbortSignal.timeout(3000);
        const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`, { signal: ctl })).json();
        ws = new WebSocket(list[0].webSocketDebuggerUrl);
        let id = 0;
        const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
        const timer = setTimeout(() => done(`[ai-player] watchdog: blocked ${blockedS}s; stack capture timed out`), 10_000);
        ws.onopen = () => { send('Debugger.enable'); send('Debugger.pause'); };
        ws.onerror = () => { clearTimeout(timer); done(`[ai-player] watchdog: blocked ${blockedS}s; inspector connection failed`); };
        ws.onmessage = (m) => {
            const d = JSON.parse(m.data);
            if (d.method !== 'Debugger.paused') return;
            const frames = d.params.callFrames.slice(0, 25).map(f => `${f.functionName || '<anon>'}@${String(f.url).replace(/^.*\/mindcraft-ce[^/]*\//, '')}:${f.location.lineNumber + 1}`);
            console.error(`[ai-player] watchdog: agent ${pid} event loop blocked ${blockedS}s; JS stack: ${frames.join(' < ')}`);
            send('Debugger.resume'); send('Debugger.disable');
            clearTimeout(timer); setTimeout(() => done(null), 500);
        };
    } catch (e) { done(`[ai-player] watchdog: blocked ${blockedS}s; stack capture failed: ${e.message}`); }
}

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
        this.restart_attempts = 0;
        this.backoff_ms = MIN_RESTART_MS;
        this.gave_up = false;
        this.stop_requested = false;
        this.restart_timer = null;
        this.watchdog = null;
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;

        let args = ['src/process/init_agent.js', this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        // Never pass a restart/greeting init_message — empty join only.
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        this.stop_requested = false;
        if (this.restart_timer) { clearTimeout(this.restart_timer); this.restart_timer = null; }
        // [ai-player] diagnostics: the agent listens for the inspector on loopback only; when its event loop is blocked
        // for 30 s the watchdog pauses it once over CDP and logs the JS stack (the only way to see where a synchronous
        // loop is spinning), then resumes it. A fatal error (heap OOM) also writes a Node report to logs/node-reports.
        const diag = [`--inspect=127.0.0.1:${INSPECT_PORT}`, '--report-on-fatalerror', '--report-compact',
            `--report-directory=${bobRuntimePath('logs', 'node-reports')}`];
        const agentProcess = spawn(process.execPath, [...diag, ...args], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        });

        const started_at = Date.now();
        const hb = { first_at: 0, last_at: 0, spawned: false, last_packet_at: 0 };
        agentProcess.on('message', (m) => {
            if (m && m.type === 'ai-player-heartbeat') {
                const now = Date.now();
                if (!hb.first_at) hb.first_at = now;
                hb.last_at = now;
                hb.stack_taken = false;
                hb.spawned = !!m.spawned;
                hb.last_packet_at = Number(m.lastPacketAt) || 0;
            }
        });
        this._startWatchdog(agentProcess, started_at, hb);

        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            if (this.process === agentProcess) {
                this.running = false;
                this._stopWatchdog();
            }
            logoutAgent(this.name);

            if (code > 1) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (this.stop_requested) {
                console.log('[ai-player] reconnect: agent was stopped on purpose; not restarting.');
                return;
            }
            // [ai-player] any unplanned exit (also code 0, e.g. a spawn-handler error) reconnects
            if (signal !== 'SIGINT') {
                this._scheduleRestart(started_at, count_id);
            }
        });

        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    _startWatchdog(child, started_at, hb) {
        this._stopWatchdog();
        this.watchdog = setInterval(() => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const now = Date.now();
            let why = null;
            if (!hb.first_at && now - started_at > FIRST_HEARTBEAT_MS) why = `no heartbeat ${Math.round((now - started_at) / 1000)}s after start`;
            else if (hb.first_at && now - hb.last_at > HEARTBEAT_TIMEOUT_MS) why = `no heartbeat for ${Math.round((now - hb.last_at) / 1000)}s (agent hung)`;
            else if (hb.spawned && hb.last_packet_at && now - hb.last_packet_at > PACKET_SILENCE_MS) why = `no packets from the server for ${Math.round((now - hb.last_packet_at) / 1000)}s (connection dead)`;
            if (!why) {
                if (hb.first_at && now - hb.last_at > STACK_AFTER_MS && !hb.stack_taken) {
                    hb.stack_taken = true;
                    captureBlockedStack(child.pid, Math.round((now - hb.last_at) / 1000));
                }
                return;
            }
            console.error(`[ai-player] watchdog: ${why}; killing agent process ${child.pid} so it reconnects`);
            this._stopWatchdog();
            try { child.kill('SIGTERM'); } catch (_) {}
            setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    console.error(`[ai-player] watchdog: agent ${child.pid} ignored SIGTERM; SIGKILL`);
                    try { child.kill('SIGKILL'); } catch (_) {}
                }
            }, 10_000);
        }, WATCHDOG_TICK_MS);
    }

    _stopWatchdog() {
        if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    }

    _scheduleRestart(started_at, count_id) {
        const ran_ms = Date.now() - started_at;
        if (ran_ms >= STABLE_RUN_MS) {
            this.backoff_ms = MIN_RESTART_MS; // it had been up a while: start the backoff over
            this.restart_attempts = 0;
        }
        const delay = this.backoff_ms;
        this.restart_attempts++;
        console.log(`[ai-player] reconnect: attempt ${this.restart_attempts} in ${Math.round(delay / 1000)}s (agent ran ${Math.round(ran_ms / 1000)}s; next backoff ${Math.round(Math.min(this.backoff_ms * 2, MAX_BACKOFF_MS) / 1000)}s)`);
        this.backoff_ms = Math.min(this.backoff_ms * 2, MAX_BACKOFF_MS);

        if (this.restart_timer) clearTimeout(this.restart_timer);
        this.restart_timer = setTimeout(() => {
            this.restart_timer = null;
            if (this.stop_requested || this.running) return;
            console.log(`[ai-player] reconnect: starting agent (attempt ${this.restart_attempts})`);
            // load_memory true, NO init_message (null) - do not spam chat on reconnect
            this.start(true, null, count_id);
        }, delay);
    }

    stop() {
        this.stop_requested = true;
        const hadTimer = !!this.restart_timer;
        if (this.restart_timer) { clearTimeout(this.restart_timer); this.restart_timer = null; }
        console.log(`[ai-player] stop requested for ${this.name}: ${hadTimer ? 'pending reconnect cancelled' : 'no reconnect pending'}; agent ${this.running ? 'running, sending SIGINT' : 'not running'}`);
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    forceRestart() {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);

            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000);

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.start(true, null, this.count_id);
            });
            this.stop();
        } else {
             this.start(true, null, this.count_id);
        }
    }
}

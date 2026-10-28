import { HOME } from './bob_home.js';
// [ai-player] reset-recovery-20261026 (M4 port of the .60 ai-player-reset-watcher, Oct 20 2026).
// What it keeps from the old watcher: when an operator's /bobreset teleports Bob onto the door plate
// (-819.5 124 565.5), Bob gets ONE system note in memory.json and a `reset:<action>` lesson in lessons.json,
// and a "[ai-player] reset: ..." line goes to the Mindcraft log. Detector constants are unchanged
// (jump > 20 blocks within 3 s, landing within 1 block / 1.5 y of the door, 3 min cooldown).
// What changed: no process restart. The old watcher stopped/started the service to "start fresh"; here the
// current action and its resume are stopped in-process instead. Walking home or respawning at the bed never
// triggers (no 20-block jump onto the door plate).
// Also: a local operator inbox (run/recovery-inbox/*.json, written by run/bob-m4-ctl) to record a manual
// reset, a planned restart, or to walk home through the native !goToRememberedPlace command, plus a
// "[recovery]" note after every reconnect so Bob knows he was restarted. Notes only; never restarts anything.
import fs from 'fs';
import path from 'path';
import { navMemory } from './bob_nav_memory.js'; // nav-on-live-20261026

export const TARGET = HOME.entrance;
export const COOLDOWN_MS = 180000;
const SAMPLE_MS = 500, INBOX_POLL_MS = 3000, MAX_REQ_BYTES = 4096, MAX_NOTE = 300;
const KINDS = new Set(['reset', 'planned-restart', 'note', 'home', 'tphome']); // tphome: stuck-home-20261026

export const TELEPORT_NOTE = 'You got stuck and were brought back to your house. Start fresh: check your inventory, then choose a safe, reachable objective.';
export const MANUAL_NOTE = 'You were reset because you seemed stuck. Start fresh: check your inventory, then go back to gathering within ~60 blocks.';

export function createDetector({ target = TARGET, jump = 20, windowMs = 3000, land = 1.0, landDy = 1.5, cooldownMs = COOLDOWN_MS } = {}) {
    let prev = null, lastTrigger = -Infinity;
    return {
        reset() { prev = null; },
        setLastTrigger(t) { lastTrigger = t; },
        feed(t, pos, action = null) {
            if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null;
            let hit = null;
            if (prev && t - prev.t <= windowMs) {
                const moved = Math.hypot(pos.x - prev.pos.x, pos.y - prev.pos.y, pos.z - prev.pos.z);
                const atTarget = Math.hypot(pos.x - target.x, pos.z - target.z) <= land && Math.abs(pos.y - target.y) <= landDy;
                if (moved > jump && atTarget) {
                    if (t - lastTrigger >= cooldownMs) { lastTrigger = t; hit = { from: prev.pos, fromAction: prev.action, to: pos, moved, dt: t - prev.t }; }
                    else hit = { suppressed: 'cooldown', moved };
                }
            }
            prev = { t, pos: { x: pos.x, y: pos.y, z: pos.z }, action };
            return hit;
        },
    };
}

export function actionName(label) {
    const a = String(label || '').replace(/^action:/, '').replace(/^mode:/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    return a || 'unknown';
}
export function resetLesson(pos, label) {
    const a = actionName(label);
    const p = pos ? `${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}` : 'unknown';
    return { key: `reset:${a}`, text: `Got stuck and needed a reset near ${p} while doing ${a}; if an action keeps failing there, move elsewhere or switch task sooner.`, kind: 'fail' };
}
export function cleanText(s) {
    return String(s || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, MAX_NOTE);
}

// Validates one inbox file. Only regular, non-symlink files owned by this uid and not group/other writable.
export function readRequest(file, uid = process.getuid?.()) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('not a regular file');
    if (uid != null && st.uid !== uid) throw new Error('wrong owner');
    if (st.mode & 0o022) throw new Error('group/other writable');
    if (st.size > MAX_REQ_BYTES) throw new Error('too large');
    const req = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!req || typeof req !== 'object' || req.v !== 1 || !KINDS.has(req.kind)) throw new Error('bad request');
    return { v: 1, kind: req.kind, reason: cleanText(req.reason) || 'manual', note: cleanText(req.note), lesson: req.lesson === true,
        by: cleanText(req.by).slice(0, 40) || 'unknown', ts: Number.isFinite(req.ts) ? req.ts : 0, place: cleanText(req.place).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40) };
}

export class ResetRecovery {
    constructor(agent, { inboxDir = process.env.BOB_RECOVERY_INBOX || path.resolve('run/recovery-inbox'), now = Date.now } = {}) {
        this.agent = agent; this.now = now;
        this.inbox = inboxDir; this.done = path.join(inboxDir, 'done');
        this.detector = createDetector();
        this.startedAt = now();
        this.stats = { teleports: 0, suppressed: 0, inbox_ok: 0, inbox_bad: 0 };
        this.lastResetAt = -Infinity;
        this._busy = false;
    }
    log(msg) { console.log(`[ai-player] ${msg}`); }

    _pos() { const p = this.agent.bot?.entity?.position; return p ? { x: p.x, y: p.y, z: p.z } : null; }
    sample() {
        try {
            const hit = this.detector.feed(this.now(), this._pos(), this.agent.actions?.currentActionLabel || null);
            if (!hit) return;
            if (hit.suppressed) { this.stats.suppressed++; this.log(`reset: teleport to the door ignored (cooldown, moved ${hit.moved.toFixed(1)} blocks)`); return; }
            this.stats.teleports++;
            this.log(`reset: TELEPORT detected: moved ${hit.moved.toFixed(1)} blocks in ${hit.dt} ms from (${hit.from.x.toFixed(1)}, ${hit.from.y.toFixed(1)}, ${hit.from.z.toFixed(1)}) to the door; last action ${hit.fromAction || 'none'}`);
            this.recordReset({ reason: 'teleport', pos: hit.from, action: hit.fromAction }).catch(e => this.log(`reset: record failed (${e.message})`));
        } catch (e) { /* sampling must never throw */ }
    }

    // note + lesson + stop current action. No restart.
    async recordReset({ reason, pos, action, note }) {
        this.lastResetAt = this.now();
        this.detector.setLastTrigger(this.lastResetAt);
        const text = note || (reason === 'teleport' ? TELEPORT_NOTE : MANUAL_NOTE);
        this.log(`reset: ${reason === 'teleport' ? 'Bob was teleported home' : 'reset requested (' + reason + ')'}; stopping the current action and starting fresh (no restart)`);
        try { this.agent.actions?.cancelResume(); } catch (_) {}
        try { await this.agent.actions?.stop(); } catch (_) {}
        // nav-on-live-20261026: Bob is somewhere else now; drop the unreachable blacklist from the old spot
        try { if (this.agent.bot) { const n = navMemory(this.agent.bot).clear(); if (n) this.log(`reset: cleared ${n} unreachable nav entries`); } } catch (_) {}
        await this._note(text);
        const l = resetLesson(pos, action);
        if (this.agent.longMemory?._addLesson) { this.agent.longMemory._addLesson(l.key, l.text, l.kind); this.log(`reset: note+lesson written (${l.key})`); }
        else this.log('reset: note written; long memory unavailable, lesson skipped');
        return l;
    }
    async _note(text) {
        await this.agent.history.add('system', text);
        await this.agent.history.save();
    }

    async handle(req) {
        if (req.kind === 'reset') {
            if (this.now() - this.lastResetAt < COOLDOWN_MS && req.reason !== 'force') return 'cooldown: last reset < 180 s ago (reason "force" overrides)';
            const l = await this.recordReset({ reason: req.reason, pos: this._pos(), action: this.agent.actions?.currentActionLabel, note: req.note || null });
            return `reset recorded (${l.key})`;
        }
        if (req.kind === 'planned-restart') {
            this._plannedSeen = true;
            await this._note(`[recovery] You were restarted on purpose by the operator (${req.reason}). Check your inventory and surroundings, then carry on with your goal.`);
            return 'planned restart noted';
        }
        if (req.kind === 'note') {
            if (!req.note) return 'empty note ignored';
            await this._note(`[operator note] ${req.note}`);
            if (req.lesson) { const key = `recovery:${req.reason.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40)}`; this.agent.longMemory?._addLesson(key, req.note, 'fail'); return `note + lesson ${key}`; }
            return 'note recorded';
        }
        if (req.kind === 'home') {
            const { executeCommand } = await import('../commands/index.js');
            const place = req.place || 'house';
            const res = await executeCommand(this.agent, `!goToRememberedPlace("${place}")`);
            const p = this._pos();
            return `goToRememberedPlace(${place}) -> ${String(res ?? 'done').slice(0, 200)}; now at ${p ? [p.x, p.y, p.z].map(Math.round).join(' ') : '?'}`;
        }
        if (req.kind === 'tphome') { // stuck-home-20261026: fixed '/home house'; reason "force" only shortens the 10-min backoff to 35 s
            if (!this.agent.stuckHome) return 'not sent: stuck-home is not installed';
            return await this.agent.stuckHome.request({ force: req.reason === 'force', by: req.by });
        }
        return 'unknown kind';
    }

    // Process requests in name order. A planned-restart marker is only honored by a process that started after
    // it was written (so the process being stopped does not consume it).
    async pollInbox() {
        if (this._busy) return; this._busy = true;
        try {
            if (!fs.existsSync(this.inbox)) return;
            const names = fs.readdirSync(this.inbox).filter(n => n.endsWith('.json')).sort();
            for (const n of names) {
                const f = path.join(this.inbox, n);
                let req, result;
                try { req = readRequest(f); }
                catch (e) { this.stats.inbox_bad++; result = `rejected: ${e.message}`; }
                if (req && req.kind === 'planned-restart' && req.ts && req.ts > this.startedAt) continue; // for the next process
                if (req) {
                    try { result = await this.handle(req); this.stats.inbox_ok++; }
                    catch (e) { result = `failed: ${e.message}`; }
                }
                this.log(`recovery-inbox: ${n} ${req ? req.kind + ' by ' + req.by : ''} -> ${result}`);
                try {
                    fs.mkdirSync(this.done, { recursive: true, mode: 0o700 });
                    fs.writeFileSync(path.join(this.done, n.replace(/\.json$/, '.result.json')), JSON.stringify({ request: req || null, result, handled_at: new Date(this.now()).toISOString(), pid: process.pid }) + '\n', { mode: 0o600 });
                    fs.renameSync(f, path.join(this.done, n));
                } catch (e) { try { fs.unlinkSync(f); } catch (_) {} }
            }
        } finally { this._busy = false; }
    }

    async onSpawn() {
        await this.pollInbox();
        if (this._plannedSeen) return;
        await this._note('[recovery] You reconnected after a restart (process exit or server restart). Check your inventory and surroundings before continuing.');
        this.log('recovery: reconnect note recorded');
    }

    install() {
        const bot = this.agent.bot;
        bot.on('forcedMove', () => this.sample());
        bot.on('respawn', () => this.detector.reset());
        bot.on('death', () => this.detector.reset());
        this._t1 = setInterval(() => this.sample(), SAMPLE_MS);
        this._t2 = setInterval(() => this.pollInbox().catch(() => {}), INBOX_POLL_MS);
        try { fs.mkdirSync(this.inbox, { recursive: true, mode: 0o700 }); } catch (_) {}
        setTimeout(() => this.onSpawn().catch(e => this.log(`recovery: spawn note failed (${e.message})`)), 15000);
        this.log(`reset-recovery: watching for /bobreset teleports to the door; inbox ${this.inbox}`);
    }
}

export function installResetRecovery(agent) {
    if (agent.resetRecovery) return agent.resetRecovery;
    agent.resetRecovery = new ResetRecovery(agent);
    agent.resetRecovery.install();
    return agent.resetRecovery;
}

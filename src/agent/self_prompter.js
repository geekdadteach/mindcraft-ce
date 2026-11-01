import { GoalFailureCircuit } from './library/bob_goal_circuit.js';
import { harnessOf } from './library/bob_eval_harness.js';
import { isGuardBlockResult } from './library/bob_survival_gate.js';
import {
    AUTONOMY_IDLE_RESTART_MS, DEFAULT_SURVIVAL_GOAL, autonomyEnabled, canAutoRestart,
    playerStopHolding,
} from './library/autonomy.js';

const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent, { env = process.env } = {}) {
        this.agent = agent;
        // [ai-player] 2026-11-01: the autonomy flags are read through this env so a test can inject them.
        this.env = env;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
        this.goalCircuit = new GoalFailureCircuit();
        this._selfPromptIteration = false;
        // [ai-player] 2026-11-01: why he is stopped ('player' | 'model' | null) and when, so a player's stop
        // is a short pause (BOB_PLAYER_STOP_SEC) instead of a permanent stop.
        this.stopped_by = null;
        this.stopped_at = 0;
        this.stopped_idle = 0;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        // [ai-player] 2026-11-01: any transition out of STOPPED clears the stop record.
        this.stopped_by = null;
        this.stopped_at = 0;
        this.stopped_idle = 0;
        this.prompt = prompt;
        this.goalCircuit.continueGoal(prompt);
        harnessOf(this.agent).noteGoalChange(prompt, 'start');
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state, stopped_by, stopped_at) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        // [ai-player] 2026-11-01: a saved STOPPED with no stopped_by is a legacy save -> 'model', so the
        // watchdog restarts it instead of leaving him stopped forever.
        this.stopped_by = state === STOPPED ? (stopped_by === 'player' ? 'player' : 'model') : null;
        this.stopped_at = state === STOPPED && this.stopped_by === 'player' ? Number(stopped_at || 0) : 0;
        this.stopped_idle = 0;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
            return;
        }
        // [ai-player] 2026-11-01: boot never leaves him stopped when it may resume. A player's pause that has
        // already elapsed (or that has no timestamp) starts now; otherwise update() resumes him when it ends.
        if (this.canAutoRestart()) this.resumeAutonomy('boot');
    }

    // [ai-player] 2026-11-01: may autonomy be resumed right now (see library/autonomy.js)?
    canAutoRestart({ now = Date.now() } = {}) {
        return canAutoRestart({ state: this.state, stopped_by: this.stopped_by, stopped_at: this.stopped_at, now, env: this.env });
    }

    // True while a player's stop is still holding him.
    playerStopHolding({ now = Date.now() } = {}) {
        return playerStopHolding({ stopped_by: this.stopped_by, stopped_at: this.stopped_at, now, env: this.env });
    }

    // [ai-player] 2026-11-01: resume the saved goal, or the default survival goal when there is none.
    resumeAutonomy(why) {
        const prompt = this.prompt || DEFAULT_SURVIVAL_GOAL;
        console.log(`[ai-player] autonomy: resuming self-prompting (${why})`);
        this.start(prompt);
        return prompt;
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.goalCircuit.continueGoal(prompt);
        this.state = PAUSED;
        this.stopped_by = null; // [ai-player] 2026-11-01: paused is not stopped
        this.stopped_at = 0;
    }

    noteFailure(action, target, error) {
        if (this.isStopped())
            return null;
        if (isGuardBlockResult(error))
            return null;
        return this.goalCircuit.record(action, target, error);
    }

    noteSuccess(action, target) {
        if (!this.isStopped())
            this.goalCircuit.success(action, target);
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        const NO_COMMAND_PAUSE_MS = 60000;
        while (!this.interrupt) {
            const recent = (this.agent._recentTaskEvents || []).slice(-3);
            const taskNotes = recent.map(e =>
                '[' + e.type + '] task=' + e.taskId + ' state=' + (e.state || '?') +
                ' reason=' + (e.reason || '-') + '. A preempted task is NOT an objective failure.'
            ).join(' ');
            const msg = `You are self-prompting with the goal: '${this.prompt}'. ${taskNotes} Your next response MUST contain a command with this syntax: !commandName. Respond:`;
            
            this.agent.last_reply_was_model_error = false;
            let used_command;
            this._selfPromptIteration = true;
            try {
                used_command = await this.agent.handleMessage(
                    'system', msg, -1
                );
                // Events generated during this turn remain queued for the next turn.
                if (!this.agent.last_reply_was_model_error && recent.length && this.agent._recentTaskEvents) {
                    const through = recent[recent.length - 1].serial;
                    this.agent._recentTaskEvents = this.agent._recentTaskEvents.filter(e => e.serial > through);
                }
            } finally {
                this._selfPromptIteration = false;
            }

            if (this.goalCircuit.tripped &&
                this.state === ACTIVE &&
                !this.interrupt) {

                const incident = this.goalCircuit.tripped;
                const alternative =
                    this.goalCircuit.nextAutonomousGoal();

                if (alternative) {
                    console.warn(
                        '[ai-player] Repeated goal failure (' +
                        incident.count +
                        ' attempts). Switching autonomous objective.'
                    );

                    // No new self-prompt loop is started.
                    // The existing loop continues with a new goal.
                    this.prompt = alternative;
                    this.goalCircuit.reset(alternative);
                    harnessOf(this.agent).noteGoalChange(alternative, 'circuit_switch');
                    no_command_count = 0;
                    continue;
                }

                // All safe alternatives have recently failed.
                // Do not hammer the model or queue indefinitely.
                // Keep autonomy enabled and resume after recovery.
                console.warn(
                    '[ai-player] All fallback goals exhausted. ' +
                    'Entering 30-minute autonomous recovery.'
                );

                const oldGoal = this.prompt;
                const until = Date.now() + 30 * 60_000;

                while (!this.interrupt &&
                    this.state === ACTIVE &&
                    this.prompt === oldGoal &&
                    Date.now() < until) {
                    await new Promise(
                        resolve => setTimeout(resolve, 1000)
                    );
                }

                if (this.interrupt ||
                    this.state !== ACTIVE)
                    break;

                this.goalCircuit.reset(this.prompt);
                no_command_count = 0;
                continue;
            }

            if (!used_command) {
                // [ai-player] API placeholder replies ("No response data." etc.) are not the model ignoring
                // the goal, so they do not count toward MAX_NO_COMMAND.
                if (this.agent.last_reply_was_model_error) {
                    console.warn('[ai-player] self-prompt: model error reply, not counted toward no-command limit');
                    await new Promise(r => setTimeout(r, this.cooldown));
                    continue;
                }
                no_command_count++;
                if (no_command_count >= MAX_NO_COMMAND) {
                    // [ai-player] console only (never in-game chat); pause ~60s, reset and keep self-prompting.
                    console.warn(`[ai-player] Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Pausing self-prompting ${NO_COMMAND_PAUSE_MS/1000}s, then continuing.`);
                    const until = Date.now() + NO_COMMAND_PAUSE_MS;
                    while (!this.interrupt && Date.now() < until)
                        await new Promise(r => setTimeout(r, 1000));
                    no_command_count = 0;
                    continue;
                }
            }
            else {
                no_command_count = 0;
                await new Promise(r => setTimeout(r, this.cooldown));
            }
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
            return;
        }
        this.idle_time = 0;
        // [ai-player] 2026-11-01: a stop never sticks while autonomy is on (BOB_AUTONOMY=0 keeps the old
        // behaviour, where a stop sticks until someone starts it again).
        if (this.state !== STOPPED || !autonomyEnabled(this.env)) {
            this.stopped_idle = 0;
            return;
        }
        const free = this.agent.isIdle() && this.agent.autonomyBlocked?.() !== true;
        if (this.stopped_by === 'player') {
            // A player's stop is a short pause: resume as soon as it has passed, never the 2-minute watchdog.
            this.stopped_idle = 0;
            if (free && this.canAutoRestart()) this.resumeAutonomy('player pause over');
            return;
        }
        // A model (or legacy) stop: the idle watchdog.
        if (free)
            this.stopped_idle += delta;
        else
            this.stopped_idle = 0;
        if (this.stopped_idle >= AUTONOMY_IDLE_RESTART_MS && this.canAutoRestart()) {
            this.stopped_idle = 0;
            this.resumeAutonomy('idle watchdog');
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true, by='player') {
        harnessOf(this.agent).noteGoalChange(this.prompt, 'stop');
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
        this.state = STOPPED;
        // [ai-player] 2026-11-01: record who stopped him and when. A player's stop is a short pause
        // (BOB_PLAYER_STOP_SEC); a model stop is restarted by the watchdog.
        this.stopped_by = by;
        this.stopped_at = Date.now();
        this.stopped_idle = 0;
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}
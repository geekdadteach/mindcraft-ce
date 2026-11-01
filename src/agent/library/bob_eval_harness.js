// Isolated, opt-in evaluation JSONL for Bob (MineBobNE).
// Off unless BOB_EVAL_HARNESS_LOG is an absolute path. Observe-only:
// hooks never change prompts, history, timing, command selection, guard
// outcomes, or return values. Callers never await the writer.
//
// Do not reuse V2EventLog (that writer uses writeSync). This file is a
// separate path from BOB_BRAIN_V2_EVENT_LOG / BOB_AI_V2_EVENT_LOG.
//
// task.finished state 'succeeded' is NOT a goal outcome. It only means the
// action function returned without throw/interrupt/timeout. Goal verdicts
// come from a world-state verifier and are labelled separately.

import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
    closeSync,
    constants,
    createWriteStream,
    fchmodSync,
    fstatSync,
    openSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { isModelErrorReply } from '../../utils/model_errors.js';
import {
    VERIFIER_VERSION,
    captureWorldSnapshot,
    describeCommand,
    publicDescriptor,
    snapshotHintFromDescriptor,
    verifyGoal,
} from './bob_goal_verifier.js';

export const EVAL_HARNESS_LOG_ENV = 'BOB_EVAL_HARNESS_LOG';
export const EVAL_HARNESS_RAW_ENV = 'BOB_EVAL_HARNESS_LOG_RAW';
export const EVAL_HARNESS_PROMPTS_ENV = 'BOB_EVAL_HARNESS_LOG_PROMPTS';
export const EVAL_GOAL_VERIFIER_ENV = 'BOB_EVAL_GOAL_VERIFIER';

export const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_LINE_BYTES = 8192;
export const MAX_QUEUE = 256;
export const MAX_RAW_CHARS = 400;
export const MAX_SUMMARY_CHARS = 160;
export const WRITE_ERROR_DISABLE_AFTER = 3;

const EVENT_TYPES = new Set([
    'turn_start',
    'model_response',
    'parse',
    'guard',
    'exec_start',
    'exec_end',
    'history_append',
    'turn_end',
    'goal_check',
    'goal_change',
    'task_event',
]);

const defaultLog = {
    log: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
};

function nowMs() {
    return Date.now();
}

function monoMs() {
    return Number(process.hrtime.bigint() / 1000000n);
}

function isoTs(ms) {
    try { return new Date(ms).toISOString(); }
    catch { return new Date().toISOString(); }
}

export function hashText(text) {
    return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 12);
}

export function clipText(text, max = MAX_SUMMARY_CHARS) {
    const out = String(text ?? '')
        .replace(/[\u0000-\u001f]+/g, ' ')
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9]{8,}\b/g, '[redacted]')
        .trim();
    if (out.length <= max) return out;
    return out.slice(0, max) + '…';
}

export function resolveEvalHarnessConfig(env = process.env) {
    const raw = String(env?.[EVAL_HARNESS_LOG_ENV] ?? '').trim();
    if (!raw)
        return { enabled: false, rejected: false, reason: 'BOB_EVAL_HARNESS_LOG is unset' };
    if (!isAbsolute(raw) || /[\s\u0000]/.test(raw))
        return { enabled: false, rejected: true, reason: 'BOB_EVAL_HARNESS_LOG must be an absolute path' };
    if (!constants.O_NOFOLLOW)
        return { enabled: false, rejected: true, reason: 'BOB_EVAL_HARNESS_LOG requires O_NOFOLLOW' };
    return {
        enabled: true,
        rejected: false,
        reason: 'enabled',
        path: raw,
        logRaw: String(env?.[EVAL_HARNESS_RAW_ENV] ?? '') === '1',
        logPrompts: String(env?.[EVAL_HARNESS_PROMPTS_ENV] ?? '') === '1',
        // Verifier is ON whenever the harness is on. Opt out with =0.
        goalVerifier: String(env?.[EVAL_GOAL_VERIFIER_ENV] ?? '') !== '0',
    };
}

export function isGoalVerifierEnabled(env = process.env) {
    return String(env?.[EVAL_GOAL_VERIFIER_ENV] ?? '') !== '0';
}

// Infer which existing guard produced a returned string. Do NOT call
// RepeatGuard.check, aiPlayerGuard, parseCommandMessage, or getBotOutputSummary.
export function inferGuardKind(text) {
    const s = String(text ?? '');
    if (!s) return null;
    if (s === 'dropped_by_interrupt') return 'dropped_by_interrupt';
    if (s.startsWith('You already did that;')) return 'repeat';
    if (/CRITICAL SURVIVAL/i.test(s)) return 'survival';
    if (/is blocked for about .+ more min: you got stuck doing it/i.test(s)) return 'stuck';
    if (/failed \d+ times near .+ recently/i.test(s)) return 'failure';
    if (/You already have \d+ .+, which is plenty/i.test(s)) return 'collect';
    return 'unknown';
}

export function snapshotModel(agent, lane, model) {
    try {
        const p = agent?.prompter;
        const chosen = model
            || (lane === 'coding' ? p?.code_model : null)
            || (lane === 'vision' ? p?.vision_model : null)
            || p?.chat_model;
        const api = lane === 'coding'
            ? (p?.profile?.code_model?.api || chosen?.constructor?.name)
            : (p?.profile?.model?.api || chosen?.constructor?.name);
        const name = chosen?.lm_model || chosen?.model_name || chosen?.modelName
            || (lane === 'coding' ? p?.profile?.code_model?.model : p?.profile?.model?.model)
            || null;
        return {
            lane: typeof lane === 'string' && lane ? lane : 'conversation',
            backend: typeof api === 'string' ? api.slice(0, 40) : null,
            model: typeof name === 'string' ? name.slice(0, 80) : null,
        };
    } catch {
        return { lane: lane || 'conversation', backend: null, model: null };
    }
}

export function snapshotWorld(agent, hint = {}) {
    const out = { position: null, health: null, food: null, inventory: [], self_prompt_hash: null, dimension: null };
    try {
        out.self_prompt_hash = hashText(agent?.self_prompter?.prompt || '');
        const snap = captureWorldSnapshot(agent, hint);
        out.position = snap.position;
        out.health = snap.health;
        out.food = snap.food;
        out.inventory = snap.inventory;
        out.dimension = snap.dimension;
        out.nearby_blocks = snap.nearby_blocks;
        out.target_kind = snap.target_kind;
        out.target_present = snap.target_present;
        out.target_distance = snap.target_distance;
        out.target_nearby = snap.target_nearby;
        out.ok = snap.ok;
    } catch { /* world snapshot must never throw */ }
    return out;
}

// Pluggable stub. Never treats task.finished 'succeeded' (or !endGoal) as
// goal completion. Those facts are copied onto the record only as context.
export function defaultGoalVerifier(world, context = {}) {
    const taskState = context.last_task_finished_state ?? null;
    let verdict = 'unevaluated';
    let reason = 'No goal verifier is registered; world snapshot stored for later review.';
    if (!context.self_prompt_present) {
        verdict = 'no_active_goal';
        reason = 'No self-prompt is active; nothing to verify.';
    } else if (!world || (world.position == null && (!world.inventory || world.inventory.length === 0))) {
        verdict = 'insufficient_world_state';
        reason = 'Inventory and position were unavailable; cannot judge the goal.';
    }
    return {
        verdict,
        verdict_source: 'world_state_stub',
        reason,
        task_finished_is_not_goal_outcome: true,
        task_finished_state: taskState,
        task_finished_reason: context.last_task_finished_reason ?? null,
    };
}

// [ai-player] Fix 6: the code lane decision, for the startup log and the turn_start event.
// CODER_MODE comes from BOB_CODER_MODE (default 'auto'); coding_enabled from allow_insecure_coding.
export function codeLaneInfo({ coderMode = null, codingEnabled = true } = {}) {
    const mode = coderMode || 'auto';
    // [ai-player] Fix 6 review: with coding disabled the code lane is not selected at all.
    const lane = codingEnabled ? 'coding' : 'none';
    return {
        lane,
        selected_lane: lane,
        coder_mode: mode,
        coding_enabled: !!codingEnabled,
        reason: codingEnabled ? 'code lane selected (coder_mode=' + mode + ')' : 'code lane disabled (allow_insecure_coding=false)',
    };
}

export class EvalHarnessWriter {
    constructor(config, options = {}) {
        this.config = config || { enabled: false, rejected: false, reason: 'BOB_EVAL_HARNESS_LOG is unset' };
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
        this.log = options.log || defaultLog;
        this.queue = [];
        this.fd = null;
        this.stream = null;
        this.size = 0;
        this.scheduled = false;
        this.draining = false;
        this.errorCount = 0;
        this.dropped = 0;
        this.disabled = this.config.enabled !== true;
        this.warned = false;
        this._drainResolve = null;
        this._idleWaiters = [];
    }

    enqueue(record) {
        try {
            if (this.disabled) return false;
            const line = serializeRecord(record);
            if (!line) return false;
            if (this.queue.length >= MAX_QUEUE) {
                this.queue.shift();
                this.dropped += 1;
            }
            this.queue.push(line);
            this._schedule();
            return true;
        } catch {
            this._noteError();
            return false;
        }
    }

    async flush() {
        while (!this.disabled && (this.queue.length || this.scheduled || this.draining)) {
            if (this.draining || this.scheduled) {
                await new Promise(resolve => {
                    this._idleWaiters.push(resolve);
                    setTimeout(resolve, 50);
                });
            } else if (this.queue.length) {
                this._schedule();
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        if (this.stream) {
            try { await new Promise(resolve => this.stream.write('', resolve)); }
            catch { /* tests still return */ }
        }
    }

    close() {
        this.disabled = true;
        this.queue.length = 0;
        const stream = this.stream;
        this.stream = null;
        const fd = this.fd;
        this.fd = null;
        try { stream?.end(); } catch { /* ignore */ }
        if (fd != null) {
            try { closeSync(fd); } catch { /* ignore */ }
        }
        this._wakeIdle();
    }

    _schedule() {
        if (this.disabled || this.scheduled) return;
        this.scheduled = true;
        setImmediate(() => { this._drain(); });
    }

    async _drain() {
        this.draining = true;
        try {
            if (this.disabled) return;
            if (!this._ensureOpen()) return;
            while (this.queue.length && !this.disabled) {
                const line = this.queue.shift();
                const bytes = Buffer.byteLength(line);
                if (this.size + bytes > this.maxBytes) {
                    this._fail('eval harness stopped: file reached its size cap');
                    break;
                }
                const ok = this.stream.write(line);
                this.size += bytes;
                if (!ok) await once(this.stream, 'drain');
            }
            this.errorCount = 0;
        } catch (err) {
            this._noteError(err);
        } finally {
            this.scheduled = false;
            this.draining = false;
            this._wakeIdle();
            if (this.queue.length && !this.disabled) this._schedule();
        }
    }

    _ensureOpen() {
        if (this.stream) return true;
        if (this.disabled) return false;
        const path = this.config.path;
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;
        const fd = openSync(path, flags, 0o600);
        try { fchmodSync(fd, 0o600); } catch { /* best-effort private mode */ }
        const st = fstatSync(fd);
        if (!st.isFile()) {
            try { closeSync(fd); } catch { /* ignore */ }
            this._fail('eval harness disabled: path is not a regular file');
            return false;
        }
        this.size = st.size;
        this.stream = createWriteStream(path, { fd, flags: 'a' });
        this.fd = null; // stream owns and will close the descriptor
        this.stream.on('error', (err) => { this._noteError(err); });
        return true;
    }

    _noteError(err) {
        this.errorCount += 1;
        if (this.errorCount >= WRITE_ERROR_DISABLE_AFTER)
            this._fail(`eval harness disabled: ${err?.code || 'write failed'}`);
        else
            this._warn(`eval harness write error (${this.errorCount}/${WRITE_ERROR_DISABLE_AFTER}): ${err?.code || err?.message || 'write failed'}`);
    }

    _fail(message) {
        this.disabled = true;
        this.queue.length = 0;
        this._warn(message);
        const stream = this.stream;
        this.stream = null;
        const fd = this.fd;
        this.fd = null;
        try { stream?.destroy(); } catch { /* ignore */ }
        if (fd != null) {
            try { closeSync(fd); } catch { /* ignore */ }
        }
        this._wakeIdle();
    }

    _warn(message) {
        if (this.warned && this.disabled) return;
        this.warned = this.disabled;
        try { this.log.warn(`[bob-eval] ${message}`); } catch { /* ignore */ }
    }

    _wakeIdle() {
        const waiters = this._idleWaiters;
        this._idleWaiters = [];
        for (const w of waiters) {
            try { w(); } catch { /* ignore */ }
        }
    }
}

export function serializeRecord(record) {
    try {
        const line = JSON.stringify(record) + '\n';
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) return null;
        if (line.indexOf('\n') !== line.length - 1) return null;
        return line;
    } catch {
        return null;
    }
}

export class BobEvalHarness {
    constructor(options = {}) {
        const env = options.env || process.env;
        this.config = options.config || resolveEvalHarnessConfig(env);
        this.enabled = this.config.enabled === true;
        this.log = options.log || defaultLog;
        this.writer = options.writer || (this.enabled ? new EvalHarnessWriter(this.config, options) : null);
        this.goalVerifier = options.goalVerifier || defaultGoalVerifier;
        this.goalVerifierOn = this.config.goalVerifier !== false;
        this.agent = options.agent || null;
        this.run_id = options.run_id || `r${process.pid}.${randomBytes(4).toString('hex')}`;
        this.goal_id = null;
        this.turn_id = null;
        this.command_id = null;
        this.task_id = null;
        this._goalN = 0;
        this._turnN = 0;
        this._cmdN = 0;
        this._lastTaskFinishedState = null;
        this._lastTaskFinishedReason = null;
        this._modelMark = null;
        this._cmdDesc = null;
        this._beforeGoal = null;
        this._beforeCmd = null;
        this._afterCmd = null;
        this._afterTurn = null;
        this._lastResultText = ''; // [ai-player] Fix 4.11 review: the last command's result text
        if (this.enabled) {
            try { this.log.log(`[bob-eval] enabled run=${this.run_id}`); } catch { /* ignore */ }
        }
    }

    _safeSnap(agent, hint = {}) {
        try {
            const src = agent || this.agent;
            if (!src) return null;
            return snapshotWorld(src, hint);
        } catch {
            return null;
        }
    }

    // Clock helpers: when disabled, do not touch the clock.
    markNow() {
        if (!this.enabled) return 0;
        try { return nowMs(); } catch { return 0; }
    }

    elapsedMs(started) {
        if (!this.enabled || !started) return 0;
        try { return Math.max(0, nowMs() - started); } catch { return 0; }
    }

    setGoalVerifier(fn) {
        if (typeof fn === 'function') this.goalVerifier = fn;
    }

    noteGoalChange(prompt, reason, agent) {
        try {
            if (!this.enabled) return;
            this._goalN += 1;
            this.goal_id = `g${this._goalN}.${hashText(prompt || '')}`;
            this.task_id = null;
            this._lastTaskFinishedState = null;
            this._lastTaskFinishedReason = null;
            this._cmdDesc = null;
            this._beforeCmd = null;
            this._afterCmd = null;
            this._beforeGoal = this._safeSnap(agent);
            this._emit('goal_change', {
                reason: clipText(reason, 40) || 'change',
                prompt_hash: hashText(prompt || ''),
                self_prompt_present: !!String(prompt || '').trim(),
            });
        } catch { /* never throw */ }
    }

    // [ai-player] Fix 6: remember the code lane decision so every turn_start carries it.
    noteLaneSelection(info = {}) {
        try {
            if (!this.enabled) return null;
            const lane = codeLaneInfo(info);
            this._lane = { lane: lane.lane, lane_reason: lane.reason, coder_mode: lane.coder_mode, coding_enabled: lane.coding_enabled };
            this.log?.log?.(`[bob-eval] code lane: ${lane.reason}`);
            return this._lane;
        } catch { return null; }
    }

    noteTurnStart(agent, info = {}) {
        try {
            if (!this.enabled) return;
            this._turnN += 1;
            this.turn_id = `${this.run_id}.t${this._turnN}`;
            this._cmdN = 0;
            this.command_id = null;
            this.task_id = null;
            const rec = {
                ...(this._lane || {}),
                source: clipText(info.source, 40),
                self_prompt: !!info.self_prompt,
                iteration: Number.isFinite(info.iteration) ? info.iteration : 0,
            };
            if (info.lane) { rec.lane = clipText(info.lane, 20); rec.lane_reason = clipText(info.lane_reason, 120); }
            if (info.coder_mode != null) rec.coder_mode = clipText(info.coder_mode, 20);
            if (info.coding_enabled != null) rec.coding_enabled = !!info.coding_enabled;
            this._emit('turn_start', rec);
        } catch { /* never throw */ }
    }

    markModelCall(agent, lane, model) {
        if (!this.enabled) return null;
        try {
            return {
                started: nowMs(),
                lane,
                modelSnapshot: snapshotModel(agent, lane, model),
            };
        } catch {
            return null;
        }
    }

    finishModelCall(mark, text, extra = {}) {
        try {
            if (!this.enabled || !mark) return;
            const raw = typeof text === 'string' ? text : '';
            const trimmed = raw.trim();
            const rec = {
                ...mark.modelSnapshot,
                latency_ms: this.elapsedMs(mark.started),
                empty: trimmed.length === 0,
                is_model_error: isModelErrorReply(raw),
                text_chars: raw.length,
            };
            if (this.config.logRaw && raw)
                rec.text = clipText(raw, MAX_RAW_CHARS);
            if (this.config.logPrompts && extra.prompt)
                rec.prompt = clipText(extra.prompt, MAX_RAW_CHARS);
            this._emit('model_response', rec);
        } catch { /* never throw */ }
    }

    noteParse(info = {}) {
        try {
            if (!this.enabled) return;
            if (info.has_command && info.command_name) this._nextCommandId();
            if (info.has_command && info.command_name)
                this._cmdDesc = describeCommand(info.command_name, info.args);
            const pub = publicDescriptor(this._cmdDesc);
            this._emit('parse', {
                has_command: !!info.has_command,
                command_name: sanitizeCommandName(info.command_name),
                exists: info.exists === true,
                parse_ok: info.parse_ok !== false,
                arg_count: Number.isFinite(info.arg_count) ? info.arg_count : null,
                error: info.error ? clipText(info.error, 80) : null,
                target_item: pub?.item || pub?.block || pub?.entity || null,
                target_count: Number.isFinite(pub?.count) ? pub.count : null,
            });
        } catch { /* never throw */ }
    }

    noteGuard(info = {}) {
        try {
            if (!this.enabled) return;
            const summary = typeof info.note === 'string' ? info.note : '';
            this._emit('guard', {
                kind: info.kind || inferGuardKind(summary) || inferGuardKind(info.kind) || 'unknown',
                blocked: info.blocked !== false,
                note: summary ? clipText(summary) : null,
            });
        } catch { /* never throw */ }
    }

    noteExecStart(info = {}, agent) {
        try {
            if (!this.enabled) return;
            if (!this.command_id) this._nextCommandId();
            this._cmdDesc = describeCommand(info.command_name, info.args);
            const hint = snapshotHintFromDescriptor(this._cmdDesc);
            this._beforeCmd = this._safeSnap(agent || info.agent, hint);
            this._afterCmd = null;
            this._lastResultText = ''; // [ai-player] Fix 4.11 review: never reuse a stale result text
            const pub = publicDescriptor(this._cmdDesc);
            this._emit('exec_start', {
                command_name: sanitizeCommandName(info.command_name),
                target_item: pub?.item || pub?.block || pub?.entity || null,
                target_count: Number.isFinite(pub?.count) ? pub.count : null,
            });
        } catch { /* never throw */ }
    }

    noteExecEnd(info = {}, agent) {
        try {
            if (!this.enabled) return;
            const hint = snapshotHintFromDescriptor(this._cmdDesc);
            this._afterCmd = this._safeSnap(agent || info.agent, hint);
            const summary = clipText(info.result_summary ?? info.result ?? '', MAX_SUMMARY_CHARS);
            this._lastResultText = summary; // [ai-player] Fix 4.11 review: the verifier needs this
            this._emit('exec_end', {
                duration_ms: Number.isFinite(info.duration_ms) ? info.duration_ms : 0,
                result_summary: summary,
                result_chars: Number.isFinite(info.result_chars) ? info.result_chars
                    : (info.result != null ? String(info.result).length : 0),
                threw: !!info.threw,
                interrupted: !!info.interrupted,
                timedout: !!info.timedout,
                task_state: info.task_state ? clipText(info.task_state, 30) : this._lastTaskFinishedState,
                task_finished_is_not_goal_outcome: true,
            });
        } catch { /* never throw */ }
    }

    noteHistoryAppend(info = {}) {
        try {
            if (!this.enabled) return;
            const rec = {
                role: clipText(info.role, 20) || 'unknown',
                kind: clipText(info.kind, 40) || null,
                chars: Number.isFinite(info.chars) ? info.chars : 0,
            };
            if (this.config.logRaw && info.text)
                rec.text = clipText(info.text, MAX_RAW_CHARS);
            this._emit('history_append', rec);
        } catch { /* never throw */ }
    }

    noteTurnEnd(info = {}, agent) {
        try {
            if (!this.enabled) return;
            const hint = snapshotHintFromDescriptor(this._cmdDesc);
            this._afterTurn = this._safeSnap(agent || info.agent, hint);
            this._emit('turn_end', {
                reason: clipText(info.reason, 40) || 'unknown',
            });
        } catch { /* never throw */ }
    }

    noteTaskEvent(event) {
        try {
            if (!this.enabled || !event || typeof event !== 'object') return;
            if (event.taskId) this.task_id = String(event.taskId).slice(0, 80);
            if (event.type === 'task.finished') {
                this._lastTaskFinishedState = event.state ? String(event.state).slice(0, 30) : null;
                this._lastTaskFinishedReason = event.reason ? clipText(event.reason, 110) : null;
            }
            this._emit('task_event', {
                event_type: clipText(event.type, 40),
                state: event.state ? clipText(event.state, 30) : null,
                label: event.label ? clipText(event.label, 80) : null,
                reason: event.reason ? clipText(event.reason, 110) : null,
                timedout: !!event.timedout,
                goal_id_from_task: event.goalId == null ? null : clipText(String(event.goalId), 80),
                // Copied for correlation only. Never a goal verdict.
                task_finished_is_not_goal_outcome: event.type === 'task.finished',
            });
        } catch { /* never throw */ }
    }

    noteGoalCheck(agent) {
        try {
            if (!this.enabled) return;
            const hint = snapshotHintFromDescriptor(this._cmdDesc);
            const after = this._afterCmd || this._safeSnap(agent, hint);
            const before = this._beforeCmd || this._beforeGoal;
            const selfPrompt = String(agent?.self_prompter?.prompt || '').trim();
            const active = typeof agent?.self_prompter?.isActive === 'function'
                ? agent.self_prompter.isActive()
                : !!selfPrompt;
            let verdict;
            if (this.goalVerifierOn && this.goalVerifier === defaultGoalVerifier) {
                try {
                    verdict = verifyGoal({
                        before,
                        after,
                        descriptor: publicDescriptor(this._cmdDesc) || {},
                        goalText: selfPrompt,
                        resultText: this._lastResultText || '',
                    });
                } catch {
                    verdict = defaultGoalVerifier(after, {
                        last_task_finished_state: this._lastTaskFinishedState,
                        last_task_finished_reason: this._lastTaskFinishedReason,
                        self_prompt_present: !!selfPrompt && active,
                    });
                    verdict.verdict = 'unevaluated';
                    verdict.reason = 'Verifier threw; left unevaluated.';
                }
            } else {
                verdict = this.goalVerifier(after, {
                    last_task_finished_state: this._lastTaskFinishedState,
                    last_task_finished_reason: this._lastTaskFinishedReason,
                    self_prompt_present: !!selfPrompt && active,
                }) || defaultGoalVerifier(after, {});
            }
            const locked = { ...verdict };
            locked.task_finished_is_not_goal_outcome = true;
            locked.task_finished_state = this._lastTaskFinishedState;
            locked.task_finished_reason = this._lastTaskFinishedReason;
            const pub = publicDescriptor(this._cmdDesc);
            this._emit('goal_check', {
                verdict: clipText(locked.verdict, 40),
                verifier: clipText(locked.verifier || locked.verdict_source, 40),
                verifier_version: clipText(locked.verifier_version || (this.goalVerifierOn ? VERIFIER_VERSION : 'stub'), 16),
                verdict_source: clipText(locked.verdict_source || locked.verifier, 40),
                reason: clipText(locked.reason, 160),
                command_name: sanitizeCommandName(pub?.command),
                task_finished_is_not_goal_outcome: true,
                task_finished_state: locked.task_finished_state,
                task_finished_reason: locked.task_finished_reason,
                evidence: locked.evidence || null,
                world: {
                    position: after?.position || null,
                    health: after?.health ?? null,
                    food: after?.food ?? null,
                    dimension: after?.dimension || null,
                    inventory: Array.isArray(after?.inventory) ? after.inventory.slice(0, 20) : [],
                },
            });
        } catch { /* never throw */ }
    }

    async flush() {
        try { if (this.writer?.flush) await this.writer.flush(); }
        catch { /* tests still return */ }
    }

    close() {
        try { this.writer?.close?.(); } catch { /* ignore */ }
        this.enabled = false;
    }

    _nextCommandId() {
        this._cmdN += 1;
        this.command_id = `${this.turn_id || this.run_id}.${this._cmdN}`;
        return this.command_id;
    }

    _emit(type, fields) {
        if (!this.enabled || !this.writer || !EVENT_TYPES.has(type)) return;
        const ms = nowMs();
        const record = {
            ts: isoTs(ms),
            mono_ms: monoMs(),
            run_id: this.run_id,
            goal_id: this.goal_id,
            turn_id: this.turn_id,
            command_id: this.command_id,
            task_id: this.task_id,
            type,
            ...fields,
        };
        try { this.writer.enqueue(record); }
        catch { /* writer failures never escape */ }
    }
}

function sanitizeCommandName(name) {
    const text = String(name || '');
    if (/^![A-Za-z0-9_]{1,40}$/.test(text)) return text;
    return text ? 'unknown' : null;
}

export function attachBobEvalHarness(agent, options = {}) {
    if (agent?._evalHarnessAttached && agent.evalHarness) return agent.evalHarness;
    if (agent) agent._evalHarnessAttached = true;
    const harness = new BobEvalHarness({ ...options, agent });
    if (agent) agent.evalHarness = harness;
    if (harness.enabled && agent?.bot?.on) {
        agent.bot.on('bob_task_event', (event) => {
            try { harness.noteTaskEvent(event); }
            catch { /* second listener must stay passive */ }
        });
    }
    return harness;
}

export function harnessOf(agent) {
    try {
        if (agent?.evalHarness) return agent.evalHarness;
    } catch { /* ignore */ }
    return DISABLED_HARNESS;
}

const DISABLED_HARNESS = new BobEvalHarness({
    config: { enabled: false, rejected: false, reason: 'no agent harness' },
    env: {},
});

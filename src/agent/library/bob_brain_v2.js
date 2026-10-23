// Append-only BobBot V2 version-1 receipts for Bob's own side.
// Off unless BOB_BRAIN_V2_EVENT_LOG is an absolute path. Writes never change
// gameplay: a bad path, a full file, or a disk error disables the writer.
//
// Version-1 fields (OBSERVABLE_EVENTS.md was not readable from this public
// checkout). Bob enforces:
//   version    number 1
//   event_id   optional, stable within this process, 1-128 chars [A-Za-z0-9_.:-]
//   trace_id   required, 1-80 chars [A-Za-z0-9_.:-] (a queue job id, or bob.<hex>)
//   source     "mindcraft"
//   type       advice_injected | advice_rejected | action_started | action_result
//   summary    developer-authored, at most 700 characters
// Brain-side ids look like brain.{job_id}.a{attempt}.{type}. Bob's ids look like
// bob.{boot}.{trace_id}.{type}.{n} and are omitted when that string is not a
// valid event id.
//
// lesson_applied and lesson_outcome are not emitted. long_memory.js puts lesson
// sentences in the conversation prompt and stores a new lesson when a command
// result matches a regex. Nothing records that a lesson was the reason for a
// command, or that a later result confirmed that lesson.
import { randomBytes } from 'node:crypto';
import {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    lstatSync,
    openSync,
    renameSync,
    unlinkSync,
    writeSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { Buffer } from 'node:buffer';

export const V2_EVENT_LOG_ENV = 'BOB_BRAIN_V2_EVENT_LOG';
export const V2_SOURCE = 'mindcraft';
export const MAX_SUMMARY_CHARS = 700;
export const MAX_LINE_BYTES = 4096;
export const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
export const MAX_RECEIPT_ARCHIVES = 4;
export const TRACE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
export const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SLOW_WRITE_MS = 250;

const DROP_SUMMARY = {
    validation_invalid: 'Review result not stored because validation.valid is false.',
    stripped: 'Review result not stored because command text stripped it to nothing.',
    empty: 'Review result not stored because it had no usable advice text.',
    cap: 'Stored advice dropped because the note list is capped.',
    block_cap: 'Stored advice was cut from the suggestion block because that block is capped at 900 characters.',
    not_in_prompt: 'Stored advice was not fully present in the assembled conversation prompt.',
    wrong_prompt: 'Advice not inserted because the prompt template has no $LONG_MEMORY placeholder.',
    bad_job_id: 'Stored advice was not given a brain trace id because the queue job id is not a valid trace id.',
};

const defaultLog = {
    log: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
};

export function adviceLine(item) {
    return `- (${item.kind}) ${item.text}`;
}

// True only when the exact stored line sits in the suggestion block and is
// not a prefix of a longer line. The advice sentence itself is not enough.
export function advicePresentInPrompt(prompt, item) {
    if (typeof prompt !== 'string' || !item || typeof item.text !== 'string' || !item.text || !item.kind)
        return false;
    const line = adviceLine(item);
    let from = 0;
    while (from < prompt.length) {
        const at = prompt.indexOf(line, from);
        if (at < 0) return false;
        const next = prompt[at + line.length];
        const headerAt = prompt.lastIndexOf('Bob Brain suggestion (unverified):', at);
        if (headerAt >= 0 && (next === undefined || next === '\n')) return true;
        from = at + line.length;
    }
    return false;
}

export function redactSummary(text, secrets = []) {
    let out = String(text ?? '');
    for (const secret of secrets) {
        const token = String(secret || '');
        if (token.length >= 8) out = out.split(token).join('[redacted]');
    }
    out = out
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9]{8,}\b/g, '[redacted]')
        .replace(/[\u0000-\u001f]+/g, ' ')
        .trim();
    if (out.length > MAX_SUMMARY_CHARS) out = out.slice(0, MAX_SUMMARY_CHARS);
    return out;
}

export function buildV2Event({ eventId, traceId, type, summary, source = V2_SOURCE, secrets } = {}) {
    if (typeof traceId !== 'string' || !TRACE_ID_RE.test(traceId)) return null;
    if (eventId != null && (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId))) return null;
    if (typeof type !== 'string' || !TYPE_RE.test(type)) return null;
    if (source !== V2_SOURCE) return null;
    const clean = redactSummary(summary, secrets);
    if (!clean) return null;
    const event = { version: 1 };
    if (eventId) event.event_id = eventId;
    event.trace_id = traceId;
    event.source = source;
    event.type = type;
    event.summary = clean;
    return event;
}

export function serializeV2Event(event) {
    let line;
    try { line = JSON.stringify(event) + '\n'; }
    catch { return null; }
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return null;
    if (line.indexOf('\n') !== line.length - 1) return null;
    return line;
}

export function resolveV2EventLogConfig(env = process.env) {
    const raw = String(env?.[V2_EVENT_LOG_ENV] ?? '').trim();
    if (!raw)
        return { enabled: false, rejected: false, reason: 'BOB_BRAIN_V2_EVENT_LOG is unset' };
    if (!isAbsolute(raw) || /[\s\u0000]/.test(raw))
        return { enabled: false, rejected: true, reason: 'BOB_BRAIN_V2_EVENT_LOG must be an absolute path' };
    if (!constants.O_NOFOLLOW)
        return { enabled: false, rejected: true, reason: 'BOB_BRAIN_V2_EVENT_LOG requires O_NOFOLLOW' };
    return {
        enabled: true, rejected: false, reason: 'enabled', path: raw,
        rotateEnabled: String(env?.BOB_BRAIN_V2_ROTATE_LOG ?? '') === '1',
    };
}

function safeKind(kind) {
    const text = String(kind || '');
    return /^[A-Za-z0-9_.:-]{1,40}$/.test(text) ? text : 'unknown';
}

export function sanitizeActionLabel(name) {
    const text = String(name || '');
    if (/^![A-Za-z0-9_]{1,40}$/.test(text)) return text;
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(text)) return text;
    return 'unknown';
}

function describeOutcome(runtime, result, threw) {
    if (threw || runtime?.threw) return 'threw';
    if (runtime?.timedout) return 'timedout';
    if (runtime?.interrupted) return 'interrupted';
    if (runtime?.abandoned) return 'abandoned';
    if (runtime && runtime.success === false) return 'failed';
    if (runtime && runtime.success === true) return 'finished';
    if (result == null || result === '') return 'empty';
    return 'returned';
}

function actionSummary(handle, index, total, outcome) {
    const parts = [
        `action_id=${handle.actionId}`,
        `command=${handle.commandName}`,
        `kind=${handle.kind}`,
    ];
    if (outcome) parts.push(`outcome=${outcome}`);
    if (total > 1) parts.push(`note=${index + 1}/${total}`);
    return parts.join(' ');
}

export class V2EventLog {
    constructor(config, options = {}) {
        this.config = config || { enabled: false, rejected: false, reason: 'BOB_BRAIN_V2_EVENT_LOG is unset' };
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
        this.rotateEnabled = options.rotateEnabled ?? this.config.rotateEnabled ?? false;
        this.log = options.log || defaultLog;
        this.now = options.now || Date.now;
        this.fd = null;
        this.disabled = this.config.enabled !== true;
        this.full = false;
        this.warned = false;
    }

    append(event) {
        try {
            if (this.disabled || this.full) return false;
            const line = serializeV2Event(event);
            if (!line) return false;
            if (!this._open()) return false;
            const size = fstatSync(this.fd).size;
            const bytes = Buffer.byteLength(line);
            if (size + bytes > this.maxBytes) {
                if (!this.rotateEnabled || bytes > this.maxBytes) {
                    this.full = true;
                    this._warn('v2 receipts stopped: file reached its size cap');
                    return false;
                }
                if (!this._rotateArchive() || !this._open()) return false;
            }
            const started = this.now();
            const written = writeSync(this.fd, line);
            if (written !== bytes) {
                this._fail('v2 receipts disabled: short write');
                return false;
            }
            if (this.now() - started > SLOW_WRITE_MS) {
                this._fail('v2 receipts disabled: write was slow');
                return true;
            }
            return true;
        } catch (err) {
            this._fail(`v2 receipts disabled: ${err?.code || 'write failed'}`);
            return false;
        }
    }

    close() {
        const fd = this.fd;
        this.fd = null;
        if (fd == null) return;
        try { closeSync(fd); } catch { /* closing a receipt file must not throw */ }
    }

    _warn(message) {
        if (this.warned) return;
        this.warned = true;
        try { this.log.warn(`[bob-brain] ${message}`); } catch { /* ignore */ }
    }

    _fail(message) {
        this.disabled = true;
        this.close();
        this._warn(message);
    }

    _rotateArchive() {
        // Opt-in bounded ring: active -> .1 -> .2 -> .3 -> .4. The oldest
        // archive may be lost; the reader reports gaps if it fell behind.
        // All writes/renames are local; never touch Minecraft or the queue.
        const path = this.config.path;
        try {
            const existing = lstatSync(path);
            if (!existing.isFile() || existing.isSymbolicLink())
                throw new Error('active receipt file unsafe');
            const archives = [];
            for (let n = 1; n <= MAX_RECEIPT_ARCHIVES; n++) {
                let current = null;
                try { current = lstatSync(path + '.' + n); }
                catch (err) {
                    if (err?.code !== 'ENOENT') throw err;
                }
                if (current && (current.isSymbolicLink() || !current.isFile() ||
                    ![0o600, 0o640].includes(current.mode & 0o777)))
                    throw new Error('receipt archive unsafe');
                archives.push(current);
            }
            // Close before rename so an append can't continue into old inode.
            this.close();
            if (archives[MAX_RECEIPT_ARCHIVES - 1])
                unlinkSync(path + '.' + MAX_RECEIPT_ARCHIVES);
            for (let n = MAX_RECEIPT_ARCHIVES - 1; n >= 1; n--) {
                if (archives[n - 1]) renameSync(path + '.' + n, path + '.' + (n + 1));
            }
            renameSync(path, path + '.1');
            return true;
        } catch {
            this._fail('v2 receipts disabled: safe rotation failed');
            return false;
        }
    }

    _open() {
        if (this.fd != null) return true;
        if (this.disabled || !this.config.path) return false;
        const path = this.config.path;
        let existing = null;
        try {
            existing = lstatSync(path);
        } catch (err) {
            if (err?.code !== 'ENOENT') {
                this._fail('v2 receipts disabled: path could not be read');
                return false;
            }
        }
        if (existing?.isSymbolicLink()) {
            this._fail('v2 receipts disabled: path is a symlink');
            return false;
        }
        if (existing && !existing.isFile()) {
            this._fail('v2 receipts disabled: path is not a regular file');
            return false;
        }
        if (existing) {
            const mode = existing.mode & 0o777;
            if (mode !== 0o640 && mode !== 0o600) {
                this._fail('v2 receipts disabled: file mode must be 640 or 600');
                return false;
            }
        }
        let fd;
        try {
            const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
            fd = openSync(path, flags, 0o640);
        } catch {
            this._fail('v2 receipts disabled: file could not be opened');
            return false;
        }
        try {
            const opened = fstatSync(fd);
            if (!opened.isFile()) {
                closeSync(fd);
                this._fail('v2 receipts disabled: path is not a regular file');
                return false;
            }
            if (!existing) fchmodSync(fd, 0o640);
            const mode = fstatSync(fd).mode & 0o777;
            if (mode !== 0o640 && mode !== 0o600) {
                closeSync(fd);
                this._fail('v2 receipts disabled: file mode must be 640 or 600');
                return false;
            }
            this.fd = fd;
            return true;
        } catch {
            try { closeSync(fd); } catch { /* ignore */ }
            this._fail('v2 receipts disabled: file could not be opened');
            return false;
        }
    }
}

export class BobV2Receipts {
    constructor(options = {}) {
        const env = options.env || process.env;
        this.config = options.config || resolveV2EventLogConfig(env);
        this.secrets = options.secrets || (() => []);
        this.writer = options.writer || new V2EventLog(this.config, options);
        this.boot = options.boot || randomBytes(4).toString('hex');
        this._seq = new Map();
        this._turnSeq = 0;
        this._turn = null;
        this._actionSeq = 0;
        this._wrongPrompt = new Set();
        this._startupLogged = false;
    }

    reportStartup() {
        if (this._startupLogged) return;
        this._startupLogged = true;
        if (!this.config?.enabled && !this.config?.rejected) return;
        const log = this.writer.log || defaultLog;
        if (this.config.enabled)
            log.log('[bob-brain] v2 receipts enabled');
        else if (this.config.rejected)
            log.warn(`[bob-brain] v2 receipts disabled: ${this.config.reason}`);
    }

    close() {
        try { this.writer.close(); } catch { /* ignore */ }
    }

    newLocalTrace() {
        return `bob.${randomBytes(8).toString('hex')}`;
    }

    nextActionId() {
        this._actionSeq += 1;
        return `a${this._actionSeq}`;
    }

    supersedeTurn() {
        this._turn = null;
    }

    commitTurn(token) {
        if (!this._turn || this._turn.id !== token) return false;
        this._turn.ready = true;
        return true;
    }

    takeTraces(token) {
        if (typeof token !== 'number' || !this._turn) return null;
        if (this._turn.id !== token || this._turn.ready !== true) return null;
        const traces = this._turn.traces;
        this._turn = null;
        return traces.length ? traces.slice() : null;
    }

    onAdviceDropped(item, reason, extra) {
        try {
            const trace = traceOf(item?.jobId);
            let summary = reason === 'cap' && Number.isInteger(extra)
                ? `Stored advice dropped because the note list is capped at ${extra}.`
                : (DROP_SUMMARY[reason] || DROP_SUMMARY.empty);
            if (!trace && item?.jobId) summary += ' Queue job id is not a valid trace id.';
            this._emit(trace || this.newLocalTrace(), 'advice_rejected', summary);
        } catch { /* a receipt must not affect advice storage */ }
    }

    observePrompt(brain, prompt, opts = {}) {
        try {
            const items = freshItems(brain);
            const conversation = opts.conversationPrompt === true;
            const injected = [];
            let block = '';
            try { block = brain?.adviceBlock?.() || ''; } catch { block = ''; }
            for (const item of items) {
                const trace = traceOf(item.jobId);
                if (!conversation) {
                    this._wrongOnce(item, trace);
                    continue;
                }
                if (advicePresentInPrompt(prompt, item)) {
                    const used = trace || this.newLocalTrace();
                    this._emit(used, 'advice_injected', injectedSummary(item, !trace));
                    if (trace) injected.push(trace);
                } else {
                    const capped = block.length >= 900 && !block.includes(adviceLine(item));
                    const used = trace || this.newLocalTrace();
                    this._emit(used, 'advice_rejected', DROP_SUMMARY[capped ? 'block_cap' : 'not_in_prompt']);
                }
            }
            if (opts.armAction === true && conversation) {
                const id = ++this._turnSeq;
                this._turn = { id, traces: injected, ready: false };
                return id;
            }
            return null;
        } catch {
            return null;
        }
    }

    emitActionStarted(handle) {
        this._emitAction(handle, 'action_started', null);
    }

    emitActionResult(handle, info) {
        const outcome = describeOutcome(info?.runtime, info?.result, info?.threw === true);
        this._emitAction(handle, 'action_result', outcome);
    }

    beginRuntime(label) {
        try {
            if (this.config?.enabled !== true || this.writer.disabled) return null;
            const handle = {
                commandName: sanitizeActionLabel(label),
                kind: 'action',
                traces: [this.newLocalTrace()],
                actionId: this.nextActionId(),
            };
            this.emitActionStarted(handle);
            return handle;
        } catch {
            return null;
        }
    }

    finishRuntime(handle, outcome) {
        try {
            if (!handle) return;
            this.emitActionResult(handle, { runtime: outcome, result: null, threw: outcome?.threw === true });
        } catch { /* ignore */ }
    }

    _wrongOnce(item, trace) {
        const key = trace || `local:${item?.jobId || ''}`;
        if (this._wrongPrompt.has(key)) return;
        if (this._wrongPrompt.size > 200) this._wrongPrompt.clear();
        this._wrongPrompt.add(key);
        this._emit(trace || this.newLocalTrace(), 'advice_rejected', DROP_SUMMARY.wrong_prompt);
    }

    _emitAction(handle, type, outcome) {
        try {
            const traces = Array.isArray(handle?.traces) ? handle.traces : [];
            const total = traces.length;
            for (let i = 0; i < total; i++) {
                this._emit(traces[i], type, actionSummary(handle, i, total, outcome));
            }
        } catch { /* ignore */ }
    }

    _eventId(trace, type) {
        const key = `${trace}\0${type}`;
        const n = (this._seq.get(key) || 0) + 1;
        this._seq.set(key, n);
        const id = `bob.${this.boot}.${trace}.${type}.${n}`;
        return EVENT_ID_RE.test(id) ? id : null;
    }

    _emit(traceId, type, summary) {
        try {
            if (this.config?.enabled !== true || this.writer.disabled || this.writer.full) return false;
            let secrets = [];
            try { secrets = this.secrets() || []; } catch { secrets = []; }
            const event = buildV2Event({
                eventId: this._eventId(traceId, type),
                traceId,
                type,
                summary,
                secrets,
            });
            if (!event) return false;
            return this.writer.append(event);
        } catch {
            return false;
        }
    }
}

function traceOf(id) {
    if (typeof id === 'number' && Number.isSafeInteger(id)) id = String(id);
    if (typeof id === 'string' && TRACE_ID_RE.test(id)) return id;
    return null;
}

function freshItems(brain) {
    try {
        const items = brain?._freshAdvice?.() || brain?.currentAdvice?.() || [];
        return Array.isArray(items) ? items : [];
    } catch {
        return [];
    }
}

function injectedSummary(item, badTrace) {
    const chars = String(item?.text || '').length;
    const truncated = item?.truncated ? 'yes' : 'no';
    let summary = `Injected stored advice into the conversation prompt (kind=${safeKind(item?.kind)}, chars=${chars}, truncated=${truncated}).`;
    if (badTrace) summary += ' Queue job id is not a valid trace id.';
    return summary;
}

export function noteRuntimeStart(agent, label) {
    try {
        if (!agent || (agent._bobV2CommandDepth || 0) > 0) return null;
        return agent.bobBrain?.receipts?.beginRuntime(label) || null;
    } catch {
        return null;
    }
}

export function noteRuntimeFinish(agent, handle, outcome) {
    try {
        if ((agent?._bobV2CommandDepth || 0) > 0 && agent?._bobV2OutcomeSlot)
            agent._bobV2OutcomeSlot.outcome = outcome || null;
        if (handle) agent?.bobBrain?.receipts?.finishRuntime(handle, outcome);
    } catch { /* a receipt must not affect the action */ }
}

// Runs perform() and writes action_started before it, action_result after it
// returns or throws. Parsing, guards, and a command string that is only sent
// do not call this. Claim is the prompt-turn token from the model response;
// other callers pass a falsy claim and get a Bob-local trace id.
export async function runCommandPerform(agent, meta, perform) {
    const brain = agent?.bobBrain;
    const receipts = brain?.receipts;
    const commandName = sanitizeActionLabel(meta?.commandName);
    const kind = meta?.action ? 'action' : 'command';
    let traces = null;
    try {
        const claim = agent?._bobV2ClaimAdvice;
        if (typeof claim === 'number' && receipts) traces = receipts.takeTraces(claim);
    } catch {
        traces = null;
    }
    let local = null;
    if (!traces?.length) {
        try { local = receipts?.newLocalTrace?.() || null; } catch { local = null; }
    }
    const handle = {
        commandName,
        kind,
        traces: traces?.length ? traces : (local ? [local] : []),
        actionId: 'a0',
    };
    try { handle.actionId = receipts?.nextActionId?.() || 'a0'; } catch { handle.actionId = 'a0'; }

    const slot = { outcome: null };
    const prevSlot = agent?._bobV2OutcomeSlot;
    if (agent) {
        agent._bobV2OutcomeSlot = slot;
        agent._bobV2CommandDepth = (agent._bobV2CommandDepth || 0) + 1;
    }
    try {
        try { receipts?.emitActionStarted(handle); } catch { /* ignore */ }
        const result = await perform();
        try {
            receipts?.emitActionResult(handle, { result, threw: false, runtime: slot.outcome });
        } catch { /* ignore */ }
        return result;
    } catch (err) {
        try {
            receipts?.emitActionResult(handle, { result: null, threw: true, runtime: slot.outcome });
        } catch { /* ignore */ }
        throw err;
    } finally {
        if (agent) {
            agent._bobV2CommandDepth = Math.max(0, (agent._bobV2CommandDepth || 1) - 1);
            agent._bobV2OutcomeSlot = prevSlot;
        }
    }
}

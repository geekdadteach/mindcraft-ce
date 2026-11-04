// [bob-eval] Opt-in evaluation trace. OFF unless the process env has BOB_EVAL=1.
//
// When off, every hook in agent.js / commands/index.js / action_manager.js / prompter.js
// is skipped by an `if (evalEnabled())` check, so live Bob does no extra work and writes no file.
// When on, one JSONL line per step of a model turn is written to BOB_EVAL_DIR (default ./eval-runs,
// gitignored), all lines of one turn sharing run_id + turn_id:
//   turn_start -> llm_response -> parsed_command -> repeat_guard -> command_parse -> command_guard
//   -> task_event (TaskLifecycle) -> execute_result
// Privacy: prompts are recorded only as a hash + length; text fields go through redactSummary
// (Bearer/sk-/pk-/rk- tokens removed) and are truncated; keys that look like secrets/env are dropped;
// process.env is never read except for the BOB_EVAL* settings below. A trace must never change behavior:
// every function swallows its own errors.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { V2EventLog, redactSummary } from './bob_brain_v2.js';
import { isModelErrorReply } from '../../utils/model_errors.js';

export const EVAL_ENV = 'BOB_EVAL';
export const EVAL_DIR_ENV = 'BOB_EVAL_DIR';
export const EVAL_RUN_ID_ENV = 'BOB_EVAL_RUN_ID';
export const DEFAULT_EVAL_DIR = 'eval-runs';
export const EVAL_TRACE_VERSION = 1;

const MAX_TEXT = 600;
const MAX_ARRAY = 8;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const SAFE_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SECRET_KEY_RE = /(key|token|secret|passw|auth|cookie|credential|^env$|^environment$)/i;

let state = null;          // lazily created when the first event is recorded with the flag on
const collectors = new Set();

export function evalEnabled(env = process.env) {
    try { return String(env?.[EVAL_ENV] ?? '') === '1'; } catch { return false; }
}

function newRunId() {
    const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    return `run-${t}-${randomBytes(3).toString('hex')}`;
}

function getState() {
    if (state) return state;
    const wanted = String(process.env[EVAL_RUN_ID_ENV] ?? '').trim();
    const runId = SAFE_ID_RE.test(wanted) ? wanted : newRunId();
    const dir = resolve(String(process.env[EVAL_DIR_ENV] ?? '').trim() || DEFAULT_EVAL_DIR);
    let log = null, file = null;
    try {
        mkdirSync(dir, { recursive: true });
        file = join(dir, `${runId}.trace.jsonl`);
        log = new V2EventLog({ enabled: true, rejected: false, reason: 'bob-eval', path: file },
            { maxBytes: MAX_LOG_BYTES, rotateEnabled: false, log: { warn: m => console.warn(`[bob-eval] ${m}`) } });
    } catch (err) {
        console.warn(`[bob-eval] trace file disabled: ${err?.code || err?.message || 'error'}`);
    }
    state = { runId, dir, file, log, seq: 0, turnSeq: 0, context: null };
    return state;
}

export function evalPromptId(text) {
    try { return 'p_' + createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 12); }
    catch { return null; }
}

// Extra patterns on top of redactSummary (which misses sk-proj-/sk-ant- style keys with inner dashes).
const EXTRA_SECRET_RES = [
    /\b(?:sk|pk|rk|xai)-[A-Za-z0-9_-]{8,}/g,
    /\bAIza[0-9A-Za-z_-]{20,}/g,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    /\b[MN][A-Za-z\d_-]{23,}\.[\w-]{6}\.[\w-]{27,}/g,                 // Discord bot token shape
    /\b((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)["']?[^\s"',}]+/gi,
];

export function sanitizeEvalText(text, max = MAX_TEXT) {
    let out = String(text ?? '');
    for (const re of EXTRA_SECRET_RES) out = out.replace(re, (m, prefix) => (typeof prefix === 'string' ? prefix : '') + '[redacted]');
    out = redactSummary(out);
    return out.length > max ? out.slice(0, max) : out;
}

function clean(value, depth = 0) {
    if (value == null) return value ?? null;
    if (typeof value === 'string') return sanitizeEvalText(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'boolean') return value;
    if (value instanceof Error) return sanitizeEvalText(value.message || String(value));
    if (depth >= 2) return sanitizeEvalText(Array.isArray(value) ? `[array ${value.length}]` : '[object]');
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(v => clean(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value).slice(0, 24)) {
            if (SECRET_KEY_RE.test(k) || typeof v === 'function') continue;
            out[k] = clean(v, depth + 1);
        }
        return out;
    }
    return null;
}

function agentName(agent) {
    const n = String(agent?.name ?? '');
    return SAFE_ID_RE.test(n) ? n : 'agent';
}

// Generic recorder; `fields` are sanitized. Never throws.
export function evalRecord(agent, type, fields = {}) {
    if (!evalEnabled()) return null;
    try {
        const s = getState();
        const event = {
            v: EVAL_TRACE_VERSION,
            run_id: s.runId,
            turn_id: agent?._evalTurnId ?? null,
            seq: ++s.seq,
            ts: new Date().toISOString(),
            type: String(type).slice(0, 40),
            agent: agentName(agent),
        };
        if (s.context) event.ctx = clean(s.context);
        Object.assign(event, clean(fields));
        // fields may not override the correlation keys
        event.v = EVAL_TRACE_VERSION; event.run_id = s.runId; event.type = String(type).slice(0, 40);
        try { s.log?.append(event); } catch { /* ignore */ }
        for (const fn of collectors) { try { fn(event); } catch { /* ignore */ } }
        return event;
    } catch {
        return null;
    }
}

function sourceKind(agent, source) {
    if (source === 'system') return 'system';
    if (source === agent?.name) return 'self';
    return 'other';   // player or other bot; names are not recorded
}

// Starts a new model turn: assigns agent._evalTurnId used by every later event of the turn.
export function evalBeginTurn(agent, source, iteration = 0) {
    if (!evalEnabled()) return null;
    try {
        const s = getState();
        const turnId = `${s.runId}.t${++s.turnSeq}`;
        if (agent) { agent._evalTurnId = turnId; agent._evalPrompt = null; }
        evalRecord(agent, 'turn_start', { source: sourceKind(agent, source), iteration,
            self_prompting: !!agent?.self_prompter?.isActive?.() });
        return turnId;
    } catch { return null; }
}

// Called by the prompter once the real prompt is assembled: hash + length only, never the text.
export function evalNotePrompt(agent, prompt, modelName) {
    if (!evalEnabled() || !agent) return;
    try {
        agent._evalPrompt = { prompt_id: evalPromptId(prompt), prompt_chars: String(prompt ?? '').length,
            model: modelName ? String(modelName).slice(0, 80) : null };
    } catch { /* ignore */ }
}

function modelNameOf(agent) {
    try {
        const p = agent?.prompter;
        return String(agent?._evalPrompt?.model || p?.chat_model?.model_name || p?.profile?.model?.model
            || (typeof p?.profile?.model === 'string' ? p.profile.model : '') || 'unknown').slice(0, 80);
    } catch { return 'unknown'; }
}

export function evalLlmResponse(agent, history, response) {
    if (!evalEnabled()) return null;
    try {
        const p = agent?._evalPrompt;
        return evalRecord(agent, 'llm_response', {
            model: modelNameOf(agent),
            prompt_id: p?.prompt_id || evalPromptId(JSON.stringify(history ?? [])),
            prompt_chars: p?.prompt_chars ?? null,
            history_len: Array.isArray(history) ? history.length : null,
            response_chars: String(response ?? '').length,
            empty: String(response ?? '').trim().length === 0,
            model_error: isModelErrorReply(response),
            raw: response,
        });
    } catch { return null; }
}

export function evalSetContext(context) {
    try { getState().context = context ?? null; } catch { /* ignore */ }
}

export function evalAddCollector(fn) {
    collectors.add(fn);
    return () => collectors.delete(fn);
}

export function evalTraceInfo() {
    return state ? { runId: state.runId, dir: state.dir, file: state.file } : null;
}

// For the offline harness/tests: close the file and forget the run so the next event starts a new one.
export function evalResetForTests() {
    try { state?.log?.close(); } catch { /* ignore */ }
    state = null;
    collectors.clear();
}

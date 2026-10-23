// Optional, advisory client for the local Bob Brain job queue.
// Off unless BOB_BRAIN_TOKEN_FILE is set. The brain never controls Bob:
// results are stored as unverified prompt notes and are not run as commands.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { BobV2Receipts, TRACE_ID_RE } from './bob_brain_v2.js';

export const DEFAULT_BRAIN_URL = 'http://127.0.0.1:8765';
export const LOW_HEALTH = 6;
export const LOW_HEALTH_RECOVER = 10;
export const MAX_BODY_BYTES = 120 * 1024;
export const DEFAULT_FOOTPRINT = Object.freeze({ width: 5, depth: 5 });
export const MAX_FOOTPRINT = 32;
// The queue keeps client_key forever. A repeat inside this bucket is the same
// request. A later bucket is a new job. Default cooldowns are at least this long.
export const KEY_BUCKET_MS = 10 * 60 * 1000;
export const HTTP_ERROR_LOG_MS = 3 * 60 * 1000;
export const HTTP_ERROR_CLIP = 120;

const PATH_RESET_FAILURES = new Set(['stuck', 'dig_error', 'place_error', 'no_scaffolding_blocks']);
const GOTO_FAILURE = /^(No path to the goal!|Took to long to decide path to goal!)/;
const BUILD_GOAL = /\b(build(?:ing)?|construct(?:ion|ing)?|blueprint|shelter|house|hut|cabin|wall|bridge|tower|barn|platform|roof|floor|pen|structure|farm|stair(?:s|case)?|pillar)\b/i;
const COMMAND_TEXT = /![A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?/g;

const defaultLog = {
    log: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
};

function clip(value, max) {
    const text = String(value ?? '');
    return text.length <= max ? text : text.slice(0, max);
}

function hashKey(prefix, material) {
    const digest = createHash('sha256').update(String(material)).digest('hex').slice(0, 40);
    return `${prefix}:${digest}`.slice(0, 128);
}

// JSON.stringify drops undefined object fields and turns an undefined array
// entry into null. Match that, with object keys sorted, so a retry hashes and
// sends the same payload even if the caller built the object in another order.
function sortedPayload(value) {
    if (Array.isArray(value))
        return value.map((item) => (item === undefined ? null : sortedPayload(item)));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) out[key] = sortedPayload(value[key]);
    }
    return out;
}

function canonicalJson(value) {
    return JSON.stringify(sortedPayload(value));
}

export function normalizePosition(position) {
    if (!position) return null;
    const x = Number(position.x);
    const y = Number(position.y);
    const z = Number(position.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
}

function cellOf(position, size = 8) {
    const p = normalizePosition(position);
    if (!p) return 'unknown';
    return `${Math.floor(p.x / size)},${Math.floor(p.y / size)},${Math.floor(p.z / size)}`;
}

function normalizePathReason(reason) {
    const text = String(reason || 'path failed');
    if (/no path/i.test(text) || text === 'noPath') return 'noPath';
    if (/took to long/i.test(text) || text === 'timeout') return 'timeout';
    if (text === 'stuck' || text === 'dig_error' || text === 'place_error' || text === 'no_scaffolding_blocks')
        return text;
    return clip(text, 80);
}

function clampFootprint(width, depth) {
    const w = Math.round(Number(width));
    const d = Math.round(Number(depth));
    if (!Number.isFinite(w) || !Number.isFinite(d)) return null;
    return {
        width: Math.max(1, Math.min(MAX_FOOTPRINT, w)),
        depth: Math.max(1, Math.min(MAX_FOOTPRINT, d)),
    };
}

// Build-style goals only. Dimensions come from the text; otherwise a small default.
// The private brain validator was not available here, so the payload stays at
// {objective, footprint:{width, depth}} and width/depth stay inside 1..32.
export function planPayloadForGoal(objective) {
    const text = clip(objective, 500).trim();
    if (!text || !BUILD_GOAL.test(text)) return null;
    let footprint = null;
    let assumed = true;
    const pair = text.match(/(\d{1,3})\s*(?:x|×|by)\s*(\d{1,3})/i);
    if (pair) footprint = clampFootprint(pair[1], pair[2]);
    if (!footprint) {
        const words = text.match(/(\d{1,3})\s*(?:blocks?\s+)?(?:wide|width)\b[\s\S]{0,40}?(\d{1,3})\s*(?:blocks?\s+)?(?:deep|depth|long|length)\b/i);
        if (words) footprint = clampFootprint(words[1], words[2]);
    }
    if (footprint) assumed = false;
    else footprint = { width: DEFAULT_FOOTPRINT.width, depth: DEFAULT_FOOTPRINT.depth };
    return { objective: text, footprint, assumed };
}

function sanitizeAdvice(text) {
    return String(text || '')
        .replace(COMMAND_TEXT, '[removed]')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function plainBit(value, max = 80) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string') return clip(value.trim(), max);
    return '';
}

function formatMaterials(materials) {
    let pairs = [];
    if (Array.isArray(materials)) {
        pairs = materials.slice(0, 8).map((item) => {
            if (typeof item === 'string') return clip(item.trim(), 40);
            if (!item || typeof item !== 'object') return '';
            const name = plainBit(item.name || item.item || item.id || item.material, 32);
            const count = plainBit(item.count ?? item.qty ?? item.amount, 12);
            if (!name) return '';
            return count ? `${name} ${count}` : name;
        });
    } else if (materials && typeof materials === 'object') {
        pairs = Object.entries(materials).slice(0, 8).map(([name, count]) => {
            const label = plainBit(name, 32);
            const amount = plainBit(count, 12);
            if (!label) return '';
            return amount ? `${label} ${amount}` : label;
        });
    }
    return pairs.filter(Boolean).join(', ');
}

function formatStageTitles(stages) {
    if (!Array.isArray(stages)) return '';
    return stages.slice(0, 6).map((stage) => {
        if (typeof stage === 'string') return clip(stage.trim(), 80);
        if (stage && typeof stage === 'object') return plainBit(stage.title || stage.name, 80);
        return '';
    }).filter(Boolean).join(', ');
}

function footprintText(proposal) {
    const fp = proposal?.footprint;
    if (fp && typeof fp === 'object') {
        const width = plainBit(fp.width ?? fp.w, 8);
        const depth = plainBit(fp.depth ?? fp.d ?? fp.length, 8);
        if (width && depth) return `${width}x${depth}`;
    }
    const width = plainBit(proposal?.width, 8);
    const depth = plainBit(proposal?.depth ?? proposal?.length, 8);
    if (width && depth) return `${width}x${depth}`;
    return '';
}

function renderPlanProposal(proposal) {
    const size = footprintText(proposal);
    const height = plainBit(proposal.wall_height ?? proposal.wallHeight ?? proposal.height, 8);
    const materials = formatMaterials(proposal.materials ?? proposal.material_counts ?? proposal.materialCounts);
    const stages = formatStageTitles(proposal.stages ?? proposal.stage_titles ?? proposal.stageTitles);
    const bits = [];
    if (size) bits.push(`footprint ${size}`);
    if (height) bits.push(`wall height ${height}`);
    if (materials) bits.push(`materials ${materials}`);
    if (stages) bits.push(`stages ${stages}`);
    return bits.join('; ');
}

function renderFailureProposal(proposal) {
    const cause = plainBit(proposal.cause, 160);
    const lesson = plainBit(proposal.lesson_proposal ?? proposal.lessonProposal ?? proposal.lesson, 160);
    const rawSteps = proposal.verification_steps ?? proposal.verificationSteps ?? [];
    const steps = Array.isArray(rawSteps) ? rawSteps.slice(0, 2).map((step) => {
        if (typeof step === 'string') return clip(step.trim(), 120);
        if (step && typeof step === 'object') return plainBit(step.step || step.title || step.text, 120);
        return '';
    }).filter(Boolean) : [];
    const bits = [];
    if (cause) bits.push(`cause ${cause}`);
    if (lesson) bits.push(`lesson ${lesson}`);
    if (steps.length) bits.push(`check ${steps.join('; ')}`);
    return bits.join('; ');
}

function renderProposal(proposal, kind) {
    if (!proposal || typeof proposal !== 'object') return '';
    if (/fail/i.test(kind || '')) return renderFailureProposal(proposal);
    if (/plan/i.test(kind || '')) return renderPlanProposal(proposal);
    return renderPlanProposal(proposal) || renderFailureProposal(proposal);
}

// Turn a review result into one plain sentence. A worker result looks like
// {summary?, proposal, validation:{valid, issues}, finish_reason, review_required, world_action_taken, memory_applied}.
// Prefer summary. Otherwise describe proposal. Skip invalid validation. Never dump the wrapper JSON.
export function toAdvisoryText(result, kind) {
    if (typeof result === 'string') return sanitizeAdvice(result);
    if (!result || typeof result !== 'object') return result == null ? '' : sanitizeAdvice(result);
    if (result.validation && result.validation.valid === false) return '';
    if (typeof result.summary === 'string' && result.summary.trim()) return sanitizeAdvice(result.summary);
    const proposal = result.proposal && typeof result.proposal === 'object' ? result.proposal : null;
    const rendered = renderProposal(proposal, kind || result.kind || proposal?.kind || '');
    if (rendered) return sanitizeAdvice(rendered);
    for (const key of ['advice', 'analysis', 'suggestion', 'text', 'message']) {
        if (typeof result[key] === 'string' && result[key].trim()) return sanitizeAdvice(result[key]);
    }
    if (typeof result.plan === 'string' && result.plan.trim()) return sanitizeAdvice(result.plan);
    return '';
}

// The conversation prompt is the one that contains $LONG_MEMORY. Other prompts stay unchanged.
export function withConversationAdvice(prompt, longMemoryText) {
    if (typeof prompt !== 'string' || !prompt.includes('$LONG_MEMORY')) return prompt;
    return prompt.replaceAll('$LONG_MEMORY', longMemoryText || '');
}

function checkLoopbackUrl(raw) {
    let parsed;
    try { parsed = new URL(raw); }
    catch { return { ok: false, reason: 'BOB_BRAIN_URL is not a valid URL' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return { ok: false, reason: 'BOB_BRAIN_URL must be http or https' };
    if (parsed.username || parsed.password)
        return { ok: false, reason: 'BOB_BRAIN_URL must not include credentials' };
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash)
        return { ok: false, reason: 'BOB_BRAIN_URL must not include a path or query' };
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1')
        return { ok: false, reason: 'BOB_BRAIN_URL must be loopback (127.0.0.1, localhost, or ::1)' };
    return { ok: true, url: parsed.origin };
}

function readTokenFile(file) {
    let info;
    try { info = lstatSync(file); }
    catch { throw new Error('BOB_BRAIN_TOKEN_FILE could not be read'); }
    if (!info.isFile() || info.isSymbolicLink())
        throw new Error('BOB_BRAIN_TOKEN_FILE must be a regular file, not a symlink');
    if ((info.mode & 0o077) !== 0)
        throw new Error('BOB_BRAIN_TOKEN_FILE must be a private regular file (mode 600)');
    const buf = readFileSync(file);
    if (buf.length > 4096)
        throw new Error('BOB_BRAIN_TOKEN_FILE is too large');
    const secret = buf.toString('utf8').trim();
    if (secret.length < 32 || secret.length > 512 || /[\s\u0000-\u001f]/.test(secret))
        throw new Error('BOB_BRAIN_TOKEN_FILE token must be 32-512 characters without whitespace');
    return secret;
}

export function resolveBobBrainConfig(env = process.env) {
    const tokenFile = String(env.BOB_BRAIN_TOKEN_FILE || '').trim();
    if (!tokenFile) {
        return { enabled: false, rejected: false, reason: 'BOB_BRAIN_TOKEN_FILE is unset' };
    }
    const urlCheck = checkLoopbackUrl(String(env.BOB_BRAIN_URL || DEFAULT_BRAIN_URL).trim());
    if (!urlCheck.ok) return { enabled: false, rejected: true, reason: urlCheck.reason };
    try {
        const token = readTokenFile(tokenFile);
        return {
            enabled: true,
            rejected: false,
            reason: 'enabled',
            url: urlCheck.url,
            token,
        };
    } catch (err) {
        return { enabled: false, rejected: true, reason: err.message || 'BOB_BRAIN_TOKEN_FILE was rejected' };
    }
}

function asJobId(id) {
    if (typeof id === 'number' && Number.isSafeInteger(id)) id = String(id);
    if (typeof id === 'string' && TRACE_ID_RE.test(id)) return id;
    return null;
}

function storedTraceId(id) {
    return asJobId(id);
}

function positionOf(bot) {
    return normalizePosition(bot?.entity?.position);
}

function hook(fn) {
    try { fn(); } catch { /* the brain must not affect gameplay */ }
}

function fire(promise) {
    if (promise && typeof promise.then === 'function') promise.catch(() => {});
}

function wrapMethod(obj, name, wrapper) {
    if (!obj || typeof obj[name] !== 'function' || obj[name]._bobBrainWrapped) return;
    const orig = obj[name];
    function wrapped(...args) {
        return wrapper.call(this, orig, args);
    }
    wrapped._bobBrainWrapped = true;
    obj[name] = wrapped;
}

export class BobBrain {
    constructor(config, options = {}) {
        this.config = config || { enabled: false, reason: 'unconfigured' };
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.log = options.log || defaultLog;
        this.now = options.now || Date.now;
        this.timeoutMs = options.timeoutMs ?? 2500;
        this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
        this.eventDedupeMs = options.eventDedupeMs ?? 60_000;
        this.failureGapMs = options.failureGapMs ?? 60_000;
        this.failureCooldownMs = options.failureCooldownMs ?? 10 * 60_000;
        this.deathCooldownMs = options.deathCooldownMs ?? 10 * 60_000;
        this.planCooldownMs = options.planCooldownMs ?? 30 * 60_000;
        this.repeatThreshold = options.repeatThreshold ?? 2;
        this.deathCoalesceMs = options.deathCoalesceMs ?? 400;
        this.keyBucketMs = options.keyBucketMs ?? KEY_BUCKET_MS;
        this.errorLogIntervalMs = options.errorLogIntervalMs ?? 60_000;
        this.httpErrorLogIntervalMs = options.httpErrorLogIntervalMs ?? HTTP_ERROR_LOG_MS;
        this.maxAdvice = options.maxAdvice ?? 3;
        this.maxAdviceChars = options.maxAdviceChars ?? 280;
        this.adviceTtlMs = options.adviceTtlMs ?? 30 * 60_000;
        this.maxTrackedJobs = options.maxTrackedJobs ?? 8;
        this.maxTrackMs = options.maxTrackMs ?? 3 * 60 * 60_000;
        this.eventRate = options.eventRate ?? 8;
        this.lowHealth = options.lowHealth ?? LOW_HEALTH;
        this.counters = {
            events_sent: 0,
            events_dropped: 0,
            jobs_enqueued: 0,
            jobs_review: 0,
            jobs_failed: 0,
            request_errors: 0,
            client_key_conflicts: 0,
            advice: 0,
            health_ok: 0,
        };
        this._recentEvents = new Map();
        this._eventTimes = [];
        this._kinds = new Map();
        this._cooldowns = new Map();
        this._jobs = new Map();
        this._advice = [];
        this._httpErrors = new Map();
        this._lastErrorLog = null;
        this._lowLatched = false;
        this._lastGoal = '';
        this._deathPending = null;
        this._deathTimer = null;
        this._pollTimer = null;
        this._stopped = false;
        this.receipts = options.receipts || new BobV2Receipts({
            env: options.env || process.env,
            log: this.log,
            maxBytes: options.v2MaxBytes,
            now: () => this.now(),
            secrets: () => (this.config?.token ? [this.config.token] : []),
        });
        if (this.config.enabled && typeof this.fetchImpl !== 'function') {
            this.config = { enabled: false, rejected: true, reason: 'fetch is not available' };
        }
    }

    // Enabled flag, loopback URL, counters, outstanding job count, and current advice count.
    // The token is not included.
    status() {
        const advice = this._freshAdvice().length;
        return {
            enabled: this.config.enabled === true,
            reason: this.config.reason,
            url: this.config.enabled ? this.config.url : undefined,
            counters: { ...this.counters },
            outstanding_jobs: this._jobs.size,
            advice,
        };
    }

    statusSuffix() {
        if (!this.config.enabled) return '';
        const c = this.counters;
        return ` bob-brain=on e=${c.events_sent}/${c.events_dropped} j=${c.jobs_enqueued} rev=${c.jobs_review} fail=${c.jobs_failed} err=${c.request_errors} adv=${this._freshAdvice().length}`;
    }

    stop() {
        this._stopped = true;
        if (this._pollTimer) clearInterval(this._pollTimer);
        if (this._deathTimer) clearTimeout(this._deathTimer);
        this._pollTimer = null;
        this._deathTimer = null;
        try { this.receipts?.close(); } catch { /* receipts must not affect shutdown */ }
    }

    // Final assembled prompt. Emits advice_injected only after the stored line
    // is found in that string. armAction is set by the conversation prompter.
    observeAssembledPrompt(prompt, opts) {
        try { return this.receipts.observePrompt(this, prompt, opts || {}); }
        catch { return null; }
    }

    supersedeTurn() {
        try { this.receipts.supersedeTurn(); } catch { /* ignore */ }
    }

    commitPromptTurn(token) {
        try { return this.receipts.commitTurn(token) === true; }
        catch { return false; }
    }

    startPolling() {
        if (!this.config.enabled || this._pollTimer) return;
        const tick = () => { fire(this.pollOnce()); };
        this._pollTimer = setInterval(tick, this.pollIntervalMs);
        this._pollTimer.unref?.();
    }

    async probe() {
        if (!this.config.enabled) return { ok: false, reason: 'disabled' };
        const res = await this._request('GET', '/health');
        if (res?.ok && res.json?.ok === true) {
            this.counters.health_ok++;
            this.log.log('[bob-brain] health ok');
        } else if (res?.ok) {
            this._noteError('health response was not ok');
        }
        return res;
    }

    noteDeath(info) {
        return this._guard(() => this._queueDeath(info || {}));
    }

    noteLowHealth(info) {
        return this._guard(() => this._noteLowHealth(info || {}));
    }

    noteFailure(info) {
        return this._guard(() => this._noteFailure(info || {}));
    }

    notePathFailure(info) {
        return this._guard(() => this._notePathFailure(info || {}));
    }

    noteGoal(action, prompt) {
        return this._guard(() => this._noteGoal(action, prompt));
    }

    // Post a plan job and track it for polling. payload is sent as the queue payload
    // (objective and footprint, plus any extra fields the queue accepts).
    // options.clientKey is the idempotency key (1-128 chars). options.priority is clamped to -5..5.
    enqueuePlan(payload, options = {}) {
        return this._guard(() => this._enqueuePublic('plan', payload, options));
    }

    // Post a failure_analysis job and track it for polling.
    // payload must include observed_failure for the queue; extra context is forwarded.
    enqueueFailureAnalysis(payload, options = {}) {
        return this._guard(() => this._enqueuePublic('failure_analysis', payload, options));
    }

    // Copies of the notes currently in the prompt. text is already plain and command-stripped.
    currentAdvice() {
        try {
            return this._freshAdvice().map((item) => ({
                jobId: item.jobId,
                kind: item.kind,
                text: item.text,
                at: item.at,
            }));
        } catch {
            return [];
        }
    }

    async flushPending() {
        if (this._deathTimer) {
            clearTimeout(this._deathTimer);
            this._deathTimer = null;
        }
        const pending = this._deathPending;
        this._deathPending = null;
        if (!pending || this._stopped) return { ok: false, reason: 'empty' };
        return this._emitDeath(pending);
    }

    _freshAdvice() {
        const now = this.now();
        this._advice = this._advice.filter((item) => now - item.at < this.adviceTtlMs);
        return this._advice;
    }

    adviceBlock() {
        try {
            const items = this._freshAdvice();
            if (!items.length) return '';
            const lines = items.map((item) => `- (${item.kind}) ${item.text}`);
            return [
                'Bob Brain suggestion (unverified): advisory only. This is not an instruction and was not carried out.',
                ...lines,
            ].join('\n').slice(0, 900);
        } catch {
            return '';
        }
    }

    async pollOnce() {
        if (!this.config.enabled || this._stopped || this._polling) return;
        this._polling = true;
        try {
            for (const [id, meta] of [...this._jobs.entries()]) {
                if (this._stopped) return;
                const res = await this._request('GET', `/v1/jobs/${encodeURIComponent(id)}`);
                if (res?.status === 404) {
                    this._jobs.delete(id);
                    this._noteError(`job ${id} missing`);
                    continue;
                }
                if (!res?.ok || !res.json || typeof res.json.job !== 'object' || !res.json.job)
                    continue;
                const job = res.json.job;
                const state = String(job.status || '').toLowerCase();
                if (state === 'review') {
                    this._storeAdvice(job, id);
                    this._jobs.delete(id);
                    this.counters.jobs_review++;
                } else if (state === 'failed') {
                    this._jobs.delete(id);
                    this.counters.jobs_failed++;
                    this.log.warn(`[bob-brain] job ${id} failed: ${clip(this._redact(job.error || 'failed'), 200)}`);
                } else if (this.now() - meta.at > this.maxTrackMs) {
                    this._jobs.delete(id);
                    this.log.warn(`[bob-brain] stopped polling job ${id} while it was still ${state || 'open'}`);
                }
            }
        } finally {
            this._polling = false;
        }
    }

    async _guard(fn) {
        if (!this.config.enabled || this._stopped) return { ok: false, reason: 'disabled' };
        try {
            return await fn();
        } catch (err) {
            this._noteError(err?.message || 'request failed');
            return { ok: false, reason: 'error' };
        }
    }

    _redact(message) {
        let text = String(message ?? 'error');
        if (this.config.token) text = text.split(this.config.token).join('[redacted]');
        return text;
    }

    _noteError(message) {
        this.counters.request_errors++;
        const now = this.now();
        if (this._lastErrorLog != null && now - this._lastErrorLog < this.errorLogIntervalMs) return;
        this._lastErrorLog = now;
        this.log.warn(`[bob-brain] ${clip(this._redact(message), 300)}`);
    }

    // Kind, coarse label, canonical payload, and time bucket. The same inputs
    // inside one bucket reuse the key, which is what makes a retry idempotent.
    _clientKey(prefix, kind, coarse, payload) {
        const bucketMs = this.keyBucketMs > 0 ? this.keyBucketMs : 1;
        const bucket = Math.floor(this.now() / bucketMs);
        return hashKey(prefix, `${kind}|${coarse}|${canonicalJson(payload)}|${bucket}`);
    }

    // Only the server's error string. Never the payload, headers, or token.
    _formatHttpError(json) {
        if (!json || typeof json.error !== 'string') return '';
        const cleaned = this._redact(json.error).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
        return clip(cleaned, HTTP_ERROR_CLIP);
    }

    _noteHttpError(status, method, path, errorText) {
        this.counters.request_errors++;
        const signature = errorText || `HTTP ${status} ${method} ${path}`;
        const now = this.now();
        let rec = this._httpErrors.get(signature);
        if (!rec) {
            if (this._httpErrors.size >= 30)
                this._httpErrors.delete(this._httpErrors.keys().next().value);
            rec = { count: 0, lastAt: 0 };
        }
        rec.count += 1;
        const windowMs = this.httpErrorLogIntervalMs > 0 ? this.httpErrorLogIntervalMs : 0;
        const due = rec.lastAt === 0 || now - rec.lastAt >= windowMs;
        if (!due) {
            this._httpErrors.set(signature, rec);
            return;
        }
        const times = rec.count;
        rec.count = 0;
        rec.lastAt = now;
        this._httpErrors.set(signature, rec);
        const detail = errorText ? `: ${errorText}` : '';
        this.log.warn(`[bob-brain] HTTP ${status} ${method} ${path}${detail} (x${times})`);
    }

    async _request(method, path, body) {
        const raw = body === undefined ? null : JSON.stringify(body);
        if (raw && Buffer.byteLength(raw) > MAX_BODY_BYTES) {
            this.counters.events_dropped++;
            this._noteError(`body too large for ${method} ${path}`);
            return { ok: false, reason: 'too_large' };
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        timer.unref?.();
        try {
            const headers = { Accept: 'application/json' };
            if (path !== '/health') headers.Authorization = `Bearer ${this.config.token}`;
            if (raw) headers['Content-Type'] = 'application/json';
            const res = await this.fetchImpl(this.config.url + path, {
                method,
                headers,
                body: raw ?? undefined,
                signal: ctrl.signal,
                redirect: 'error',
            });
            const text = await res.text();
            let json = null;
            if (text) {
                try { json = JSON.parse(text); }
                catch {
                    this._noteError(`malformed JSON from ${method} ${path}`);
                    return { ok: false, status: res.status, reason: 'malformed_json' };
                }
            }
            if (!res.ok) {
                const errorText = this._formatHttpError(json);
                if (json && json.error === 'client_key already used for different job')
                    this.counters.client_key_conflicts++;
                this._noteHttpError(res.status, method, path, errorText);
                const conflict = json?.error === 'client_key already used for different job';
                return {
                    ok: false,
                    status: res.status,
                    json,
                    reason: conflict ? 'client_key_conflict' : 'http_error',
                };
            }
            return { ok: true, status: res.status, json };
        } catch (err) {
            const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
            this._noteError(aborted ? `timeout ${method} ${path}` : `unreachable ${method} ${path}`);
            return { ok: false, reason: aborted ? 'timeout' : 'unreachable' };
        } finally {
            clearTimeout(timer);
        }
    }

    _queueDeath(info) {
        const cause = clip(info.cause || 'unknown', 300);
        const position = normalizePosition(info.position);
        const dimension = clip(info.dimension || '', 64);
        if (!this._deathPending) this._deathPending = { cause, position, dimension };
        else {
            if (position) this._deathPending.position = position;
            if (dimension) this._deathPending.dimension = dimension;
            if (cause && cause !== 'death' && cause !== 'unknown') this._deathPending.cause = cause;
        }
        if (this._deathTimer) return { ok: true, coalesced: true };
        this._deathTimer = setTimeout(() => {
            this._deathTimer = null;
            const pending = this._deathPending;
            this._deathPending = null;
            if (pending && !this._stopped) fire(this._emitDeath(pending));
        }, this.deathCoalesceMs);
        this._deathTimer.unref?.();
        return { ok: true, scheduled: true };
    }

    async _emitDeath(info) {
        const position = normalizePosition(info.position);
        const cause = clip(info.cause || 'unknown', 300);
        const dimension = clip(info.dimension || '', 64);
        await this._reportEvent('death', { cause, position, dimension }, `death:${cellOf(position)}:${cause}`);
        const payload = {
            observed_failure: clip(`Died${dimension ? ` in ${dimension}` : ''}: ${cause}`, 1000),
            cause,
            position,
            dimension: dimension || undefined,
        };
        // Cooldown stays on the cell and cause. The posted key also includes the
        // exact payload, so a later death in that cell is a new job.
        const coarse = `${cellOf(position)}|${cause.toLowerCase()}`;
        const cooldownKey = hashKey('death', coarse);
        if (!this._cooldownOk(cooldownKey, this.deathCooldownMs))
            return { ok: false, reason: 'cooldown' };
        const clientKey = this._clientKey('death', 'failure_analysis', coarse, payload);
        const sent = await this._enqueue('failure_analysis', payload, clientKey, 1);
        if (sent?.ok) this._rememberCooldown(cooldownKey, this.deathCooldownMs);
        return sent;
    }

    async _noteLowHealth(info) {
        const health = Math.round(Number(info.health));
        if (!Number.isFinite(health) || health <= 0) return { ok: false, reason: 'dead' };
        if (health > this.lowHealth) {
            if (health >= LOW_HEALTH_RECOVER) {
                this._lowLatched = false;
                // A new dip after recovery is a new warning, even inside the dedupe window.
                this._recentEvents.delete('low_health:low_health');
            }
            return { ok: false, reason: 'ok' };
        }
        if (this._lowLatched) {
            this.counters.events_dropped++;
            return { ok: false, reason: 'deduped' };
        }
        this._lowLatched = true;
        return this._reportEvent('low_health', {
            health,
            position: normalizePosition(info.position),
        }, 'low_health');
    }

    async _noteFailure(info) {
        const kind = clip(info.kind || 'action', 80);
        const observed = clip(info.observed_failure || 'failed', 1000);
        const position = normalizePosition(info.position);
        const stuck = /stuck/i.test(kind) || /stuck/i.test(observed);
        await this._reportEvent(stuck ? 'stuck' : 'action_failed', {
            kind,
            observed_failure: observed,
            position,
        }, `${stuck ? 'stuck' : 'action'}:${kind}:${cellOf(position)}`);
        return this._maybeEnqueueRepeated(kind, position, {
            observed_failure: observed,
            action: kind,
            position,
            goal: clip(info.goal || this._lastGoal || '', 200) || undefined,
        });
    }

    async _notePathFailure(info) {
        const reason = normalizePathReason(info.reason);
        const position = normalizePosition(info.position);
        const kind = `path:${reason}`;
        await this._reportEvent('pathfinding_failed', { reason, position }, `path:${reason}:${cellOf(position)}`);
        return this._maybeEnqueueRepeated(kind, position, {
            observed_failure: clip(`Pathfinding failed: ${reason}`, 1000),
            action: kind,
            position,
            goal: clip(this._lastGoal || '', 200) || undefined,
        });
    }

    async _maybeEnqueueRepeated(kind, position, payload) {
        const now = this.now();
        let rec = this._kinds.get(kind);
        if (!rec) rec = { count: 0, lastAt: 0, lastJobAt: 0 };
        if (rec.lastAt && now - rec.lastAt < this.failureGapMs) {
            this._kinds.set(kind, rec);
            return { ok: false, reason: 'same_episode' };
        }
        rec.count += 1;
        rec.lastAt = now;
        this._kinds.set(kind, rec);
        if (rec.count < this.repeatThreshold) return { ok: false, reason: 'below_threshold', count: rec.count };
        if (rec.lastJobAt && now - rec.lastJobAt < this.failureCooldownMs) return { ok: false, reason: 'cooldown', count: rec.count };
        const clientKey = this._clientKey('fail', 'failure_analysis', `${kind}|${cellOf(position)}`, payload);
        const sent = await this._enqueue('failure_analysis', payload, clientKey, 0);
        if (sent?.ok) {
            rec.count = 0;
            rec.lastJobAt = now;
            this._kinds.set(kind, rec);
        }
        return sent;
    }

    async _noteGoal(action, prompt) {
        const text = clip(prompt || '', 500).trim();
        if (!text) return { ok: false, reason: 'empty' };
        if (action === 'cleared') {
            if (this._lastGoal === text) this._lastGoal = '';
            return this._reportEvent('goal_cleared', { prompt: text }, `goal_cleared:${text}`);
        }
        this._lastGoal = text;
        const event = await this._reportEvent('goal_set', { prompt: text }, `goal_set:${text}`);
        const plan = planPayloadForGoal(text);
        if (!plan) return event;
        const payload = {
            objective: plan.objective,
            footprint: { width: plan.footprint.width, depth: plan.footprint.depth },
        };
        const coarse = plan.objective.toLowerCase();
        const cooldownKey = hashKey('plan', coarse);
        if (!this._cooldownOk(cooldownKey, this.planCooldownMs))
            return { ok: true, reason: 'plan_cooldown', event };
        this.log.log(`[bob-brain] plan footprint ${plan.footprint.width}x${plan.footprint.depth}${plan.assumed ? ' (default)' : ''}`);
        const clientKey = this._clientKey('plan', 'plan', coarse, payload);
        const sent = await this._enqueue('plan', payload, clientKey, 0);
        if (sent?.ok) this._rememberCooldown(cooldownKey, this.planCooldownMs);
        return sent;
    }

    _cooldownOk(key, windowMs) {
        const until = this._cooldowns.get(key) || 0;
        return this.now() >= until && windowMs >= 0;
    }

    _rememberCooldown(key, windowMs) {
        this._cooldowns.set(key, this.now() + windowMs);
    }

    async _reportEvent(type, payload, dedupeKey) {
        const now = this.now();
        const key = `${type}:${dedupeKey}`;
        const prev = this._recentEvents.get(key);
        if (prev != null && now - prev < this.eventDedupeMs) {
            this.counters.events_dropped++;
            return { ok: false, reason: 'deduped' };
        }
        this._eventTimes = this._eventTimes.filter((t) => now - t < 60_000);
        const exempt = type === 'death' || type === 'low_health';
        if (!exempt && this._eventTimes.length >= this.eventRate) {
            this.counters.events_dropped++;
            return { ok: false, reason: 'rate_limited' };
        }
        if (this._recentEvents.size > 200) {
            for (const [seen, at] of this._recentEvents) {
                if (now - at >= this.eventDedupeMs) this._recentEvents.delete(seen);
            }
        }
        this._recentEvents.set(key, now);
        this._eventTimes.push(now);
        const body = {
            source: 'mindcraft',
            type,
            payload: payload && typeof payload === 'object' ? payload : {},
        };
        const res = await this._request('POST', '/v1/events', body);
        if (res?.ok) this.counters.events_sent++;
        return res;
    }

    async _enqueuePublic(kind, payload, options = {}) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
            return { ok: false, reason: 'bad_payload' };
        let clientKey = options.clientKey ?? options.client_key;
        if (clientKey == null || clientKey === '') {
            const prefix = kind === 'plan' ? 'plan' : 'fail';
            const coarse = kind === 'plan'
                ? clip(payload.objective || '', 500).toLowerCase()
                : clip(payload.observed_failure || payload.action || kind, 1000).toLowerCase();
            clientKey = this._clientKey(prefix, kind, coarse, payload);
        }
        clientKey = String(clientKey);
        if (clientKey.length < 1 || clientKey.length > 128)
            return { ok: false, reason: 'bad_client_key' };
        const priority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 0;
        return this._enqueue(kind, payload, clientKey, priority);
    }

    async _enqueue(kind, payload, clientKey, priority) {
        const res = await this._request('POST', '/v1/jobs', {
            kind,
            payload: sortedPayload(payload),
            client_key: clientKey,
            priority: Math.max(-5, Math.min(5, priority | 0)),
        });
        // One attempt. A client_key conflict is a 400, not a reason to post again.
        if (!res?.ok) return res;
        const id = asJobId(res.json?.job?.id);
        if (!id) {
            this._noteError('job response missing id');
            return { ok: false, reason: 'bad_response' };
        }
        this._track(id, { kind, clientKey });
        this.counters.jobs_enqueued++;
        return { ok: true, id };
    }

    _track(id, meta) {
        if (this._jobs.has(id)) return;
        while (this._jobs.size >= this.maxTrackedJobs) {
            const oldest = this._jobs.keys().next().value;
            this._jobs.delete(oldest);
            this._noteError('polling list full; dropped the oldest job');
        }
        this._jobs.set(id, { ...meta, at: this.now() });
    }

    _storeAdvice(job, trackedId) {
        const full = toAdvisoryText(job?.result, job?.kind);
        const text = full.slice(0, this.maxAdviceChars);
        const shownId = String(trackedId ?? job?.id ?? '');
        const kind = clip(job?.kind || 'note', 40);
        if (!text || text === '[removed]') {
            const invalid = job?.result?.validation?.valid === false;
            const reason = invalid ? 'validation_invalid' : (full === '[removed]' ? 'stripped' : 'empty');
            hook(() => this.receipts.onAdviceDropped({ jobId: shownId, kind }, reason));
            this.log.log(`[bob-brain] job ${shownId || '?'} review ${invalid ? 'failed validation; skipped' : 'had no usable advice'}`);
            return;
        }
        const traceId = storedTraceId(trackedId) || storedTraceId(job?.id);
        this._advice.push({
            at: this.now(),
            jobId: traceId || shownId,
            kind,
            text,
            truncated: full.length > text.length,
        });
        while (this._advice.length > this.maxAdvice) {
            const dropped = this._advice.shift();
            hook(() => this.receipts.onAdviceDropped(dropped, 'cap', this.maxAdvice));
        }
        this.counters.advice++;
        this.log.log(`[bob-brain] stored unverified advice for job ${traceId || shownId} (${text.length} chars)`);
    }
}

export function attachBobBrain(agent, options = {}) {
    if (agent._bobBrainAttached && agent.bobBrain) return agent.bobBrain;
    agent._bobBrainAttached = true;
    const env = options.env || process.env;
    const config = options.config || resolveBobBrainConfig(env);
    const brain = new BobBrain(config, { ...options, env });
    agent.bobBrain = brain;
    try { brain.receipts.reportStartup(); } catch { /* receipts must not affect startup */ }
    if (!config.enabled) {
        const line = `[bob-brain] disabled: ${config.reason}`;
        if (config.rejected) brain.log.warn(line);
        else brain.log.log(line);
        return brain;
    }
    brain.log.log(`[bob-brain] enabled url=${config.url}`);
    brain.ready = brain.probe();
    const bot = agent.bot;

    if (bot?.on) {
        bot.on('health', () => hook(() => {
            fire(brain.noteLowHealth({ health: bot.health, position: positionOf(bot) }));
        }));
        bot.on('death', () => hook(() => {
            fire(brain.noteDeath({
                cause: 'death',
                position: positionOf(bot),
                dimension: bot.game?.dimension,
            }));
        }));
        bot.on('messagestr', (message, _position, jsonMsg) => hook(() => {
            const translate = jsonMsg?.translate;
            if (typeof translate !== 'string' || !translate.startsWith('death')) return;
            if (!String(message || '').startsWith(agent.name || '')) return;
            fire(brain.noteDeath({
                cause: clip(message, 300),
                position: positionOf(bot),
                dimension: bot.game?.dimension,
            }));
        }));
        bot.on('path_reset', (reason) => hook(() => {
            if (!PATH_RESET_FAILURES.has(String(reason))) return;
            fire(brain.notePathFailure({ reason: String(reason), position: positionOf(bot) }));
        }));
        bot.on('path_update', (results) => hook(() => {
            const status = results?.status;
            if (status !== 'noPath' && status !== 'timeout') return;
            fire(brain.notePathFailure({ reason: String(status), position: positionOf(bot) }));
        }));
        const pf = bot.pathfinder;
        if (pf && typeof pf.goto === 'function' && !pf.goto._bobBrainWrapped) {
            const origGoto = pf.goto.bind(pf);
            function noteGotoError(err) {
                const message = String(err?.message || err || '');
                if (err?.name === 'NoPath' || err?.name === 'Timeout' || GOTO_FAILURE.test(message))
                    fire(brain.notePathFailure({ reason: clip(message, 200), position: positionOf(bot) }));
            }
            function wrappedGoto(goal) {
                try {
                    const pending = origGoto(goal);
                    if (pending && typeof pending.then === 'function') {
                        return pending.then((value) => value, (err) => {
                            noteGotoError(err);
                            throw err;
                        });
                    }
                    return pending;
                } catch (err) {
                    noteGotoError(err);
                    throw err;
                }
            }
            wrappedGoto._bobBrainWrapped = true;
            pf.goto = wrappedGoto;
        }
    }

    const prompter = agent.self_prompter;
    wrapMethod(prompter, 'start', function (orig, args) {
        const result = orig.apply(this, args);
        hook(() => { fire(brain.noteGoal('set', this.prompt)); });
        return result;
    });
    wrapMethod(prompter, 'setPromptPaused', function (orig, args) {
        const result = orig.apply(this, args);
        hook(() => { fire(brain.noteGoal('set', this.prompt)); });
        return result;
    });
    wrapMethod(prompter, 'stop', function (orig, args) {
        const wasGoing = typeof this.isStopped === 'function' ? !this.isStopped() : true;
        const prompt = this.prompt;
        const result = orig.apply(this, args);
        if (wasGoing && prompt) {
            Promise.resolve(result).then(() => {
                hook(() => { fire(brain.noteGoal('cleared', prompt)); });
            }, () => {});
        }
        return result;
    });

    if (agent.failures?.record) {
        wrapMethod(agent.failures, 'record', function (orig, args) {
            const recorded = orig.apply(this, args);
            hook(() => {
                const [cmd, target, pos, error] = args;
                const kind = `${cmd || 'action'}:${target || 'unknown'}`;
                fire(brain.noteFailure({
                    kind,
                    observed_failure: clip(error || 'failed', 500),
                    position: pos,
                    goal: agent.self_prompter?.prompt,
                }));
            });
            return recorded;
        });
    }

    brain.startPolling();
    return brain;
}

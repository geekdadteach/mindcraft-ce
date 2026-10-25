// Opt-in, privacy-filtered receipts for real Mindcraft model calls.
// This observes requests made by Bob; it does not read provider internals.
// Unset BOB_AI_V2_EVENT_LOG => no I/O, no change in inference behavior.
import { randomBytes } from 'node:crypto';
import { V2EventLog, resolveV2EventLogConfig, TRACE_ID_RE } from './bob_brain_v2.js';

const LANES = new Set(['conversation', 'coding', 'memory', 'responder', 'vision', 'goal']);

export class BobAIReceipts {
    constructor(options = {}) {
        const env = options.env || process.env;
        this.config = resolveV2EventLogConfig({
            BOB_BRAIN_V2_EVENT_LOG: env.BOB_AI_V2_EVENT_LOG,
            BOB_BRAIN_V2_ROTATE_LOG: env.BOB_AI_V2_ROTATE_LOG,
        });
        this.writer = options.writer || new V2EventLog(this.config);
        this.boot = options.boot || randomBytes(4).toString('hex');
        this.random = options.random || randomBytes;
    }

    // Copy only the job IDs belonging to the prompt used for THIS call.
    // Multiple advice notes may share one model call; one call ID deduplicates them.
    _traces(traceIds) {
        const valid = Array.isArray(traceIds)
            ? [...new Set(traceIds.filter(id => typeof id === 'string' && TRACE_ID_RE.test(id)))]
            : [];
        return valid.length ? valid.slice(0, 3) : ['ai.' + this.random(8).toString('hex')];
    }

    _emit(ids, type, callId, lane, outcome) {
        for (let i = 0; i < ids.length; i++) {
            // Never serialize prompts, messages, responses, exception text,
            // model URLs, credentials, player chat or hidden reasoning.
            const event = {
                version: 1,
                source: 'ai',
                type,
                trace_id: ids[i],
                event_id: 'ai.' + this.boot + '.' + callId + '.' + type + '.' + i,
                summary: 'call=' + callId + ' lane=' + lane + ' state=' + outcome,
            };
            try { this.writer.append(event); }
            catch { /* receipts cannot alter model execution */ }
        }
    }

    async observe(lane, send, traceIds = []) {
        if (typeof send !== 'function') throw new TypeError('send must be callable');
        if (!this.config.enabled || this.writer.disabled || this.writer.full)
            return await send();
        const safeLane = LANES.has(lane) ? lane : 'conversation';
        const ids = this._traces(traceIds);
        const callId = this.random(6).toString('hex');
        this._emit(ids, 'model_request', callId, safeLane, 'sent');
        try {
            const result = await send();
            // Returned means the wrapper completed, not that the goal succeeded.
            this._emit(ids, 'model_response', callId, safeLane, 'returned');
            return result;
        } catch (error) {
            this._emit(ids, 'error', callId, safeLane, 'failed');
            throw error;
        }
    }

    close() {
        try { this.writer.close(); }
        catch { /* ignore */ }
    }
}

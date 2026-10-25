// [ai-player] AndyPool: chat/thinking model that shares calls between two backends.
//   1. Hosted Andy API (class Andy: 75 s chat spacing + local quota guard live in andy.js).
//   2. Andy-4.2 on LM Studio (OpenAI-compatible, 1 parallel slot).
// Routing per call:
//   - Andy chat slot free right now (and quota OK)  -> Andy
//   - else LM Studio idle                            -> LM Studio
//   - else wait for whichever frees first (Andy slot time, or the LM Studio call finishing)
//   - LM Studio error / timeout (~150 s) / empty reply -> fall back to Andy at its next slot
//     (LM Studio is also paused 30 s..5 min after a failure so a down server is not hammered).
// Used only for profile.model (chat/memory). Embeddings stay on profile.embedding (andy),
// code_model stays as configured. One "[ai-player] pool call" log line per call.
import OpenAIApi from 'openai';
import { Andy } from './andy.js';
import { LMStudio } from './lmstudio.js';
import { MODEL_ERROR_REPLIES } from '../utils/model_errors.js';
import { strictFormat } from '../utils/text.js';
import { lmUrlList, pickLmUrl, markLmUrlDown } from '../utils/lm_endpoints.js';

// [ai-player] mode "lmstudio_primary" (params.mode): LM Studio takes every thinking call; the Andy API is backup only.
//   - LM Studio busy (its one slot is in use by another call) -> wait for it.
//   - LM Studio error / empty / HTTP 400 (context) / over params.lmstudio_timeout_ms (90 s) -> Andy at its next
//     75 s slot (Andy limiter + quota guard in andy.js still apply).
//   - Connection errors, timeouts and empty replies also pause LM Studio 30 s..5 min (backoff); during the pause
//     calls go to Andy. A 400 / context overflow is prompt-specific, so it does not pause LM Studio.
//   - Log line per call: "[ai-player] pool call backend=... latency_ms=... prompt_tokens=..." (tokens from LM usage,
//     prompt_chars always).

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class AndyPool {
    static prefix = 'andy_pool';

    // Shared by every AndyPool instance in this process (LM Studio has a single slot).
    static _lmBusy = false;
    static _lmIdleWaiters = [];
    static _lmDownUntil = 0;
    static _lmBackoffMs = 0;

    constructor(model_name, url, params) {
        const p = params || {};
        this.model_name = model_name || 'auto';
        this.lm_url = url || 'http://192.168.1.20:1234/v1';
        // [ai-player] Ordered endpoints: profile url first, then params.lmstudio_fallback_urls (e.g. .144 then .143).
        this.lm_urls = lmUrlList(this.lm_url, p.lmstudio_fallback_urls);
        this.lm_connect_ms = Number(p.lmstudio_connect_timeout_ms) || 1500;
        this.lm_model = p.lmstudio_model || 'andy-4.2';
        this.lm_timeout_ms = Number(p.lmstudio_timeout_ms) || 150000;
        this.max_attempts = Number(p.max_attempts) || 6;
        this.mode = p.mode || 'share';
        this.andy = new Andy(this.model_name, p.andy_url || undefined, undefined);
        this.lm = new LMStudio(this.lm_model, this.lm_url, undefined);
        // Same client as lmstudio.js but with a hard timeout and no silent SDK retries; one per endpoint.
        this.lm_clients = new Map(this.lm_urls.map(u => [u, new OpenAIApi({
            baseURL: u,
            apiKey: 'lm-studio',
            timeout: this.lm_timeout_ms,
            maxRetries: 0,
        })]));
        this.lm.openai = this.lm_clients.get(this.lm_url);
    }

    static _notifyLmIdle() {
        const waiters = AndyPool._lmIdleWaiters.splice(0);
        for (const w of waiters) w();
    }

    static _waitLmIdle() {
        return new Promise(r => AndyPool._lmIdleWaiters.push(r));
    }

    _lmAvailable(now) {
        return !AndyPool._lmBusy && now >= AndyPool._lmDownUntil;
    }

    // A reply the agent cannot use. A bare tab is Bob's legitimate "nothing to do" reply, so it is kept.
    _isFailure(res) {
        if (typeof res !== 'string') return true;
        const t = res.trim();
        if (MODEL_ERROR_REPLIES.includes(t)) return true;
        return t.length === 0 && !res.includes('\t');
    }

    async _callLm(turns, systemMessage) {
        AndyPool._lmBusy = true; // claimed synchronously: a concurrent call cannot also pick LM Studio
        let timer = null;
        let call;
        try {
            call = Promise.resolve().then(() => this.lm.sendRequest(turns, systemMessage));
            const guard = new Promise(r => { timer = setTimeout(() => r({ __timeout: true }), this.lm_timeout_ms + 5000); });
            const res = await Promise.race([call, guard]);
            if (res && res.__timeout) return { ok: false, reason: 'timeout' };
            if (this._isFailure(res)) {
                return { ok: false, reason: (typeof res === 'string' && res.trim()) ? 'error' : 'empty' };
            }
            return { ok: true, res };
        } catch (err) {
            return { ok: false, reason: 'error' };
        } finally {
            clearTimeout(timer);
            // Keep the slot marked busy until the underlying HTTP request has really settled.
            (call || Promise.resolve()).catch(() => {}).finally(() => {
                AndyPool._lmBusy = false;
                AndyPool._notifyLmIdle();
            });
        }
    }

    _log(backend, latencyMs, t0, attempts, path) {
        const total = Date.now() - t0;
        console.log(`[ai-player] pool call backend=${backend} latency_ms=${latencyMs} total_ms=${total} queued_ms=${Math.max(0, total - latencyMs)} attempts=${attempts}${path.length ? ' path=' + path.join(',') : ''}`);
    }

    _promptChars(messages) {
        let n = 0;
        for (const m of messages) n += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
        return n;
    }

    // Direct LM Studio call (same request as lmstudio.js) so the failure kind is known: ok | error | http400 | length | timeout | empty.
    async _callLmDirect(turns, systemMessage) {
        AndyPool._lmBusy = true;
        const messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));
        const info = { prompt_chars: this._promptChars(messages), prompt_tokens: null, completion_tokens: null };
        let timer = null;
        let call;
        try {
            const lmUrl = await pickLmUrl(this.lm_urls, { connectMs: this.lm_connect_ms });
            if (!lmUrl) return { ok: false, reason: 'error', detail: `no LM Studio endpoint reachable (${this.lm_urls.join(' ')})`, info };
            info.lm_url = lmUrl;
            // reasoning_effort "none": request-side backup for the server-side enableThinking=false on Randy's Mac.
            call = this.lm_clients.get(lmUrl).chat.completions.create({ model: this.lm_model, messages, stop: '***', reasoning_effort: 'none' });
            const guard = new Promise(r => { timer = setTimeout(() => r({ __timeout: true }), this.lm_timeout_ms + 5000); });
            const completion = await Promise.race([call, guard]);
            if (completion && completion.__timeout) return { ok: false, reason: 'timeout', info };
            info.prompt_tokens = completion?.usage?.prompt_tokens ?? null;
            info.completion_tokens = completion?.usage?.completion_tokens ?? null;
            info.reasoning_tokens = completion?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
            info.reasoning_chars = String(completion?.choices?.[0]?.message?.reasoning_content || completion?.choices?.[0]?.message?.reasoning || '').length;
            const choice = completion?.choices?.[0];
            if (choice?.finish_reason === 'length') return { ok: false, reason: 'length', info };
            let res = choice?.message?.content;
            if (typeof res === 'string' && res.includes('</think>')) {
                if (!res.includes('<think>')) res = '<think>' + res;
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            if (this._isFailure(res)) return { ok: false, reason: (typeof res === 'string' && res.trim()) ? 'error' : 'empty', info };
            return { ok: true, res, info };
        } catch (err) {
            const status = err?.status;
            // Connect failure (not a slow-model timeout): skip this endpoint for 30 s so the next call uses the other one.
            if (info.lm_url && err instanceof OpenAIApi.APIConnectionError && !(err instanceof OpenAIApi.APIConnectionTimeoutError)) markLmUrlDown(info.lm_url);
            const msg = String(err?.message || err).slice(0, 160).replace(/\s+/g, ' ');
            if (status === 400) return { ok: false, reason: 'http400', detail: msg, info };
            if (err?.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(msg)) return { ok: false, reason: 'timeout', detail: msg, info };
            return { ok: false, reason: 'error', detail: `${status ?? ''} ${msg}`.trim(), info };
        } finally {
            clearTimeout(timer);
            Promise.resolve(call).catch(() => {}).finally(() => {
                AndyPool._lmBusy = false;
                AndyPool._notifyLmIdle();
            });
        }
    }

    async _sendLmPrimary(turns, systemMessage) {
        const t0 = Date.now();
        let attempts = 0;
        let lmFailedThisCall = false;
        let lastRes = 'My brain disconnected, try again.';
        const path = [];
        let lastInfo = null;
        const extra = () => lastInfo ? `${lastInfo.lm_url ? ' lm_url=' + lastInfo.lm_url : ''} prompt_chars=${lastInfo.prompt_chars} prompt_tokens=${lastInfo.prompt_tokens ?? 'n/a'} completion_tokens=${lastInfo.completion_tokens ?? 'n/a'} reasoning_tokens=${lastInfo.reasoning_tokens ?? 'n/a'} reasoning_chars=${lastInfo.reasoning_chars ?? 'n/a'}` : '';

        while (attempts < this.max_attempts) {
            const now = Date.now();
            const lmPaused = now < AndyPool._lmDownUntil;

            // 1. LM Studio first, unless it already failed for this call or is paused after failures.
            if (!lmFailedThisCall && !lmPaused) {
                if (AndyPool._lmBusy) { await AndyPool._waitLmIdle(); continue; }
                attempts++;
                const s = Date.now();
                const r = await this._callLmDirect(turns, systemMessage);
                const ms = Date.now() - s;
                lastInfo = r.info;
                if (r.ok) {
                    AndyPool._lmBackoffMs = 0;
                    AndyPool._lmDownUntil = 0;
                    console.log(`[ai-player] pool call backend=lmstudio latency_ms=${ms} total_ms=${Date.now() - t0} attempts=${attempts}${extra()}${path.length ? ' path=' + path.join(',') : ''}`);
                    return r.res;
                }
                lmFailedThisCall = true;
                path.push(`lmstudio:${r.reason}@${ms}ms`);
                let pauseNote = 'no pause (prompt-specific)';
                if (r.reason !== 'http400' && r.reason !== 'length') {
                    AndyPool._lmBackoffMs = Math.min(Math.max(AndyPool._lmBackoffMs * 2, 30000), 300000);
                    AndyPool._lmDownUntil = Date.now() + AndyPool._lmBackoffMs;
                    pauseNote = `LM Studio paused ${Math.round(AndyPool._lmBackoffMs / 1000)}s`;
                }
                console.warn(`[ai-player] pool lmstudio ${r.reason} after ${ms}ms${extra()}${r.detail ? ' detail="' + r.detail + '"' : ''}; ${pauseNote}; falling back to Andy`);
                continue;
            }

            // 2. Andy backup at its next slot (Andy.send waits out the 75 s spacing and enforces the quota guard).
            const quotaUntil = Andy.quotaBlockedUntil(now);
            if (!quotaUntil) {
                attempts++;
                const s = Date.now();
                const res = await this.andy.sendRequest(turns, systemMessage);
                const ms = Date.now() - s;
                if (!this._isFailure(res)) {
                    console.log(`[ai-player] pool call backend=andy latency_ms=${ms} total_ms=${Date.now() - t0} attempts=${attempts}${extra()} path=${path.join(',') || (lmPaused ? 'lmstudio:paused' : '-')}`);
                    return res;
                }
                path.push(`andy:fail@${ms}ms`);
                lastRes = res;
                lmFailedThisCall = false; // let LM Studio try again (after its pause, if any)
                continue;
            }

            // 3. Andy out of quota: only LM Studio is left; wait for its pause to end, then retry it.
            lmFailedThisCall = false;
            await sleep(Math.min(60000, Math.max(1000, AndyPool._lmDownUntil - Date.now())));
        }

        console.warn(`[ai-player] pool call FAILED after ${attempts} attempts total_ms=${Date.now() - t0} path=${path.join(',')}`);
        return lastRes;
    }

    async sendRequest(turns, systemMessage) {
        if (this.mode === 'lmstudio_primary') return await this._sendLmPrimary(turns, systemMessage);
        const t0 = Date.now();
        let attempts = 0;
        let lmFailedThisCall = false;
        let lastRes = 'My brain disconnected, try again.';
        const path = [];

        while (attempts < this.max_attempts) {
            const now = Date.now();
            const andyAt = Andy.chatAvailableAt(now);

            // 1. Andy slot free right now -> Andy (Andy.send reserves the slot synchronously).
            if (andyAt <= now) {
                attempts++;
                const s = Date.now();
                const res = await this.andy.sendRequest(turns, systemMessage);
                const ms = Date.now() - s;
                if (!this._isFailure(res)) {
                    this._log('andy', ms, t0, attempts, path);
                    return res;
                }
                path.push(`andy:fail@${ms}ms`);
                lastRes = res;
                continue;
            }

            // 2. LM Studio idle -> LM Studio.
            if (!lmFailedThisCall && this._lmAvailable(now)) {
                attempts++;
                const s = Date.now();
                const r = await this._callLm(turns, systemMessage);
                const ms = Date.now() - s;
                if (r.ok) {
                    AndyPool._lmBackoffMs = 0;
                    AndyPool._lmDownUntil = 0;
                    this._log('lmstudio', ms, t0, attempts, path);
                    return r.res;
                }
                lmFailedThisCall = true;
                AndyPool._lmBackoffMs = Math.min(Math.max(AndyPool._lmBackoffMs * 2, 30000), 300000);
                AndyPool._lmDownUntil = Date.now() + AndyPool._lmBackoffMs;
                path.push(`lmstudio:${r.reason}@${ms}ms`);
                console.warn(`[ai-player] pool lmstudio ${r.reason} after ${ms}ms; LM Studio paused ${Math.round(AndyPool._lmBackoffMs / 1000)}s; falling back to Andy at its next slot`);
                continue;
            }

            // 3. Both busy: wait for whichever frees first.
            // If Andy is out of quota (not just spacing), LM Studio is the only backend: allow another LM try.
            if (lmFailedThisCall && Andy.quotaBlockedUntil(now) > now) lmFailedThisCall = false;
            const waitAndy = andyAt - now;
            const lmUsable = !lmFailedThisCall;
            const waitLmDown = (lmUsable && !AndyPool._lmBusy) ? Math.max(0, AndyPool._lmDownUntil - now) : Infinity;
            const waitMs = Math.min(60000, Math.max(250, Math.min(waitAndy, waitLmDown)));
            const waits = [sleep(waitMs)];
            if (lmUsable && AndyPool._lmBusy) waits.push(AndyPool._waitLmIdle());
            await Promise.race(waits);
        }

        console.warn(`[ai-player] pool call FAILED after ${attempts} attempts total_ms=${Date.now() - t0} path=${path.join(',')}`);
        return lastRes;
    }

    async embed(text) {
        return await this.andy.embed(text);
    }

    async embedMany(texts) {
        return await this.andy.embedMany(texts);
    }
}

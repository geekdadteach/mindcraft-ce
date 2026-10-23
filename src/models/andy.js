import { hasKey, getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import fs from 'fs';
import { embedWithCache, logEmbeddingCacheStartupSummary } from '../utils/embedding_cache.js';

// Keep batches comfortably below provider-specific item limits while still
// reducing the request burst during examples/skill initialization.
const MAX_EMBEDDING_BATCH_SIZE = 64;

export class Andy {
    static prefix = 'andy';

    constructor(model_name, url, params) {
        this.model_name = model_name || 'auto';
        this.params = params;
        this.base_url = url || 'https://andy.mindcraft-ce.com';
        this.chat_endpoint = '/api/v1/chat/completions';
        this.embedding_endpoint = '/api/v1/embeddings';
        this.embedding_queue = Promise.resolve();
    }

    async sendRequest(turns, systemMessage) {
        let model = this.model_name || 'auto';
        let messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));

        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting Andy API response... (model: ${model}, attempt: ${attempt})`);
            let res = null;
            try {
                const data = await this.send(this.chat_endpoint, {
                    model,
                    messages,
                    stream: false,
                    ...(this.params || {})
                }, { isRetry: attempt > 1 });
                if (data?.choices?.[0]?.message?.content) {
                    res = data.choices[0].message.content;
                } else {
                    // [ai-player] 200 with no content: log the body shape only (keys + finish_reason), then retry.
                    const c0 = Array.isArray(data?.choices) ? data.choices[0] : undefined;
                    const shape = {
                        keys: data && typeof data === 'object' ? Object.keys(data) : typeof data,
                        choices: Array.isArray(data?.choices) ? data.choices.length : typeof data?.choices,
                        choice0_keys: c0 && typeof c0 === 'object' ? Object.keys(c0) : typeof c0,
                        message_keys: c0?.message && typeof c0.message === 'object' ? Object.keys(c0.message) : typeof c0?.message,
                        content_type: c0?.message ? (c0.message.content === null ? 'null' : typeof c0.message.content) : 'n/a',
                        finish_reason: c0?.finish_reason ?? null,
                    };
                    console.warn(`[ai-player] Andy empty reply (attempt ${attempt}/${maxAttempts}) shape=${JSON.stringify(shape)}`);
                    if (attempt < maxAttempts) {
                        const waitMs = 5000 + Math.floor(Math.random() * 5000);
                        console.log(`[ai-player] Andy empty reply: retrying in ${Math.round(waitMs/1000)}s`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }
                    res = 'No response data.';
                }
            } catch (err) {
                if (err.message.toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage);
                } else {
                    console.log(err);
                    res = 'My brain disconnected, try again.';
                }
            }

            const hasOpenTag = res.includes('<think>');
            const hasCloseTag = res.includes('</think>');

            if (hasOpenTag && !hasCloseTag) {
                console.warn('Partial <think> block detected. Re-generating...');
                if (attempt < maxAttempts) continue;
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            console.warn('Could not get a valid response after max attempts.');
            finalRes = 'I thought too hard, sorry, try again.';
        }
        return finalRes;
    }

    async embed(text) {
        const embeddings = await this.embedMany([text]);
        return embeddings[0];
    }

    async embedMany(texts) {
        if (!Array.isArray(texts)) {
            throw new TypeError('Andy embeddings require an array of texts.');
        }
        if (texts.length === 0) return [];

        const modelName = this.model_name || 'auto';
        // [ai-player] Disk cache by model+sha256(text); only uncached texts hit the API.
        return await embedWithCache(modelName, texts, async (uncached) => {
            const request = this.embedding_queue.then(async () => {
                const embeddings = [];
                for (let start = 0; start < uncached.length; start += MAX_EMBEDDING_BATCH_SIZE) {
                    const batch = uncached.slice(start, start + MAX_EMBEDDING_BATCH_SIZE);
                    const data = await this.send(this.embedding_endpoint, { model: this.model_name, input: batch });
                    if (!Array.isArray(data?.data) || data.data.length !== batch.length) {
                        throw new Error('Andy API embeddings not available.');
                    }
                    const hasIndexes = data.data.every(item => Number.isInteger(item?.index));
                    const ordered = hasIndexes
                        ? [...data.data].sort((a, b) => a.index - b.index)
                        : data.data;
                    if (hasIndexes && ordered.some((item, index) => item.index !== index)) {
                        throw new Error('Andy API returned invalid embedding indexes.');
                    }
                    if (ordered.some(item => !Array.isArray(item?.embedding))) {
                        throw new Error('Andy API embeddings not available.');
                    }
                    embeddings.push(...ordered.map(item => item.embedding));
                }
                return embeddings;
            });
            this.embedding_queue = request.catch(() => {});
            return await request;
        });
    }

    // [ai-player] Separate spacing timers: chat/memory/coding calls ~1 per 75s, embeddings 2s apart.
    // (Previously one shared timer, so an embedding call cut the next chat wait down to ~2s.)
    static _nextChatAt = 0;
    static _nextEmbedAt = 0;
    static MIN_INTERVAL_MS = 75000;
    static EMBED_INTERVAL_MS = 2000;

    // [ai-player] Local quota guard (free tier: 250 req / 5 h, 750 req / day). Every real Andy HTTP request
    // (chat or embedding) is recorded in a small ledger file that survives restarts. Andy is refused (the
    // caller gets an error, nothing is sent) while the rolling 5 h count is at QUOTA_5H, the rolling 24 h
    // count is at QUOTA_24H, or the server's own x-andy-quota-requests-remaining header is <= QUOTA_RESERVE
    // (until that window's reset time). Caps sit below the real limits to leave a safety margin.
    static QUOTA_5H = 240;
    static QUOTA_24H = 720;
    static QUOTA_RESERVE = 10;
    static QUOTA_FILE = './andy_quota_ledger.json';
    // Andy bills an embeddings request as 0.3 of a request (seen in x-andy-quota-requests-remaining).
    static EMBED_WEIGHT = 0.3;
    static _ledger = null;

    static _loadLedger() {
        if (Andy._ledger) return Andy._ledger;
        let led = { t: [], e: [], windows: {} };
        try {
            const d = JSON.parse(fs.readFileSync(Andy.QUOTA_FILE, 'utf8'));
            if (Array.isArray(d?.t)) led.t = d.t.filter(Number.isFinite).sort((a, b) => a - b);
            if (Array.isArray(d?.e)) led.e = d.e.filter(Number.isFinite).sort((a, b) => a - b);
            if (d?.windows && typeof d.windows === 'object') led.windows = d.windows;
        } catch (e) { /* no ledger yet */ }
        Andy._ledger = led;
        return led;
    }

    static _saveLedger() {
        try {
            const tmp = Andy.QUOTA_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(Andy._ledger));
            fs.renameSync(tmp, Andy.QUOTA_FILE);
        } catch (e) {
            console.warn('[ai-player] Andy quota ledger save failed:', e?.message || e);
        }
    }

    // 0 when Andy may be called now (quota-wise), otherwise the epoch ms when it may be called again.
    static quotaBlockedUntil(now = Date.now()) {
        const led = Andy._loadLedger();
        const DAY = 24 * 3600_000, H5 = 5 * 3600_000;
        led.t = led.t.filter(x => now - x < DAY);
        led.e = led.e.filter(x => now - x < DAY);
        // Weighted rolling windows: chat = 1, embeddings = EMBED_WEIGHT. While the weight inside a window is
        // at its cap, Andy is blocked until enough of the oldest requests have aged out to drop below it.
        const events = led.t.map(x => [x, 1]).concat(led.e.map(x => [x, Andy.EMBED_WEIGHT])).sort((a, b) => a[0] - b[0]);
        const blockedFor = (windowMs, cap) => {
            const inWin = events.filter(([x]) => now - x < windowMs);
            let total = inWin.reduce((sum, [, w]) => sum + w, 0);
            if (total < cap) return 0;
            for (const [x, w] of inWin) {
                total -= w;
                if (total < cap) return x + windowMs;
            }
            return now + windowMs;
        };
        let until = Math.max(blockedFor(H5, Andy.QUOTA_5H), blockedFor(DAY, Andy.QUOTA_24H));
        for (const w of Object.values(led.windows || {})) {
            const rem = Number(w?.remaining);
            const reset = Date.parse(w?.reset);
            if (Number.isFinite(rem) && rem <= Andy.QUOTA_RESERVE && Number.isFinite(reset) && reset > now) {
                until = Math.max(until, reset + 60_000);
            }
        }
        return until > now ? until : 0;
    }

    // Epoch ms when the next Andy chat call could start (75 s spacing and quota guard).
    static chatAvailableAt(now = Date.now()) {
        return Math.max(Andy._nextChatAt, Andy.quotaBlockedUntil(now));
    }

    static _quotaGuard(endpoint) {
        const until = Andy.quotaBlockedUntil(Date.now());
        if (until) {
            console.warn(`[ai-player] Andy local quota guard: not sending ${endpoint}; blocked until ${new Date(until).toISOString()}`);
            throw new Error('Andy local quota guard');
        }
    }

    async send(endpoint, body, opts = {}) {
        const url = new URL(endpoint, this.base_url);
        const headers = { 'Content-Type': 'application/json' };
        const apiKey = hasKey('ANDY_API_KEY') ? getKey('ANDY_API_KEY') : null;
        if (apiKey && apiKey !== 'optional') {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        // Chat/memory/coding: 75s spacing. Embeddings: 2s (batched; free tier 30/min).
        const isEmbed = String(endpoint).includes('embedding');
        const interval = isEmbed ? Andy.EMBED_INTERVAL_MS : Andy.MIN_INTERVAL_MS;
        const timerKey = isEmbed ? '_nextEmbedAt' : '_nextChatAt';
        Andy._quotaGuard(endpoint); // before reserving a slot
        const now = Date.now();
        // Reserve the slot synchronously so two concurrent callers (e.g. self-prompt + memory summary)
        // cannot both see wait=0 and fire together (that caused a 429 at 17:24:38).
        // An empty-reply retry (opts.isRetry) already waited 5-10s; it does not wait out the 75s chat gap again.
        const slot = opts.isRetry ? now : Math.max(now, Andy[timerKey]);
        Andy[timerKey] = Math.max(Andy[timerKey], slot + interval);
        const wait = slot - now;
        if (wait > 0) {
            console.log(`[ai-player] Andy rate-limit wait ${Math.round(wait/1000)}s before ${endpoint}`);
            await new Promise(r => setTimeout(r, wait));
        }
        Andy[timerKey] = Math.max(Andy[timerKey], Date.now() + interval);
        Andy._quotaGuard(endpoint); // again after the wait, then record synchronously (no race between callers)
        (isEmbed ? Andy._loadLedger().e : Andy._loadLedger().t).push(Date.now());
        Andy._saveLedger();

        const started = Date.now();
        const request = new Request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        const res = await fetch(request);
        const latencyMs = Date.now() - started;
        const andyModel = res.headers.get('X-Andy-Model') || res.headers.get('x-andy-model') || '(none)';
        console.log(`[ai-player] Andy response model=${andyModel} latency_ms=${latencyMs} status=${res.status} endpoint=${endpoint}`);
        const qh = (n) => res.headers.get(n);
        if (qh('x-andy-quota-requests-remaining') !== null) {
            const led = Andy._loadLedger();
            led.windows[qh('x-andy-quota-window') || 'unknown'] = { remaining: Number(qh('x-andy-quota-requests-remaining')), reset: qh('x-andy-quota-reset'), at: Date.now() };
            Andy._saveLedger();
        }
        if (qh('x-andy-quota-requests-remaining') !== null) console.log(`[ai-player] Andy quota window=${qh('x-andy-quota-window')} requests_remaining=${qh('x-andy-quota-requests-remaining')} tokens_remaining=${qh('x-andy-quota-tokens-remaining')} reset=${qh('x-andy-quota-reset')}`);
        if (!res.ok) {
            if (res.status === 429) {
                console.error('[ai-player] Andy API 429 rate limited');
            }
            throw new Error(`Andy API status: ${res.status}`);
        }
        return await res.json();
    }
}

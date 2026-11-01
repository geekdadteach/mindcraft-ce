// [ai-player] 2026-11-01 - LM retry gating + the shared pause, and Bob's identity line in the profiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { AndyPool, lmFailureIsRetryable } from '../src/models/andy_pool.js';
import { Andy } from '../src/models/andy.js';
import { isModelErrorReply } from '../src/utils/model_errors.js';

// Count every Andy API request any test makes; api_fallback=false must keep this at 0.
let andyCalls = 0;
const realSend = Andy.prototype.send;
Andy.prototype.send = async function () { andyCalls++; throw new Error('test: Andy API must not be called'); };
test.after(() => { Andy.prototype.send = realSend; });

function resetPool() {
    AndyPool._lmBusy = false;
    AndyPool._lmDownUntil = 0;
    AndyPool._lmBackoffMs = 0;
    AndyPool._lmIdleWaiters = [];
}

const noFallback = (extra = {}) => ({ mode: 'lmstudio_primary', lmstudio_model: 'andy-4.2', api_fallback: false, lmstudio_connect_timeout_ms: 300, ...extra });

// Minimal OpenAI-compatible chat server. steps[i] answers request i (the last step repeats); { hang: true }
// accepts the request and never answers. seen.count is the number of requests that arrived.
function lmServer(steps) {
    const seen = { count: 0 };
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
            const i = seen.count++;
            req.on('data', () => {});
            req.on('end', () => {
                const step = steps[Math.min(i, steps.length - 1)];
                if (step.hang) return; // never respond: the client must time out
                res.statusCode = step.status || 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(step.status && step.status >= 400
                    ? { error: { message: step.reply || 'nope', type: 'invalid_request_error' } }
                    : {
                        id: 'x', object: 'chat.completion', created: 0, model: 'andy-4.2',
                        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: step.reply } }],
                        usage: { prompt_tokens: 1, completion_tokens: 1 },
                    }));
            });
        });
        srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}/v1` }));
    });
}

test('only connection/timeout/5xx style failures are retryable', () => {
    assert.equal(lmFailureIsRetryable('error'), true, 'connection errors and 5xx');
    assert.equal(lmFailureIsRetryable('timeout'), true);
    assert.equal(lmFailureIsRetryable('http400'), false, 'prompt-specific');
    assert.equal(lmFailureIsRetryable('length'), false, 'context overflow is prompt-specific');
    assert.equal(lmFailureIsRetryable('empty'), false);
    assert.equal(lmFailureIsRetryable(null), false);
});

test('an http400 failure is not retried', async () => {
    resetPool();
    const { srv, seen, url } = await lmServer([{ status: 400, reply: 'context length exceeded' }]);
    try {
        const p = new AndyPool('auto', url, noFallback({ lmstudio_fallback_urls: [] }));
        const t0 = Date.now();
        const res = await p.sendRequest([{ role: 'user', content: 'a' }], 'sys');
        assert.ok(isModelErrorReply(res), `expected a placeholder, got ${JSON.stringify(res)}`);
        assert.equal(seen.count, 1, 'a prompt-specific failure must not be retried');
        assert.ok(Date.now() - t0 < 2500, 'and it returns without the 3 s retry wait');
        assert.equal(AndyPool._lmDownUntil, 0, 'a 400 does not pause LM Studio');
        assert.equal(andyCalls, 0);
    } finally { srv.close(); }
});

test('a timeout is retried once', async () => {
    resetPool();
    const { srv, seen, url } = await lmServer([{ hang: true }]);
    try {
        const p = new AndyPool('auto', url, noFallback({ lmstudio_fallback_urls: [], lmstudio_timeout_ms: 300 }));
        const res = await p.sendRequest([{ role: 'user', content: 'a' }], 'sys');
        assert.ok(isModelErrorReply(res), `expected a placeholder, got ${JSON.stringify(res)}`);
        assert.equal(seen.count, 2, 'a timeout is retried exactly once');
        assert.equal(andyCalls, 0);
    } finally { srv.close(); }
});

test('a retry does not lift the shared pause for other in-flight calls', async () => {
    resetPool();
    // So the pause after the failure is 40 s: longer than the 15 s a non-retrying call is willing to wait out.
    AndyPool._lmBackoffMs = 20000;
    // Request 1 fails (500) and request 2 hangs, so the retry attempt is still in flight while we sample.
    const { srv, seen, url } = await lmServer([{ status: 500 }, { hang: true }]);
    try {
        const p = new AndyPool('auto', url, noFallback({ lmstudio_fallback_urls: [], lmstudio_timeout_ms: 1200 }));
        const first = p.sendRequest([{ role: 'user', content: 'a' }], 'sys');
        // Past the 3 s retry wait: the retry attempt is now in flight.
        await new Promise(r => setTimeout(r, 3300));
        assert.equal(seen.count, 2, 'the retry attempt was made');
        assert.equal(AndyPool._lmBusy, true, 'the retry attempt is still in flight');

        const pauseLeft = AndyPool._lmDownUntil - Date.now();
        assert.ok(pauseLeft > 0, 'the retry left the shared pause in place (it must not clear _lmDownUntil)');
        assert.ok(pauseLeft > 15000, `the pause is still long enough not to be waited out (${Math.round(pauseLeft / 1000)}s)`);

        const second = await p.sendRequest([{ role: 'user', content: 'b' }], 'sys');
        assert.ok(isModelErrorReply(second), `the second call respected the pause, got ${JSON.stringify(second)}`);
        assert.equal(seen.count, 2, 'the second call made no LM request of its own');

        assert.ok(isModelErrorReply(await first), 'the retrying call gave up after its one retry');
        assert.equal(seen.count, 2, 'exactly two LM requests: the failed attempt and its single retry');
        assert.equal(andyCalls, 0);
    } finally { srv.close(); }
});

test('both profiles answer identity questions with the land-of-AI line and name no machine', () => {
    const lite = JSON.parse(fs.readFileSync(new URL('../profiles/andy-api-lite.json', import.meta.url), 'utf8'));
    const api = JSON.parse(fs.readFileSync(new URL('../profiles/andy-api.json', import.meta.url), 'utf8'));
    assert.equal(lite.conversing, api.conversing, 'both profiles share one conversing prompt');
    const c = lite.conversing;
    assert.match(c, /YOUR BRAIN/);
    assert.match(c, /answer only "I am Bob, from the land of AI!"/, 'the identity answer is the existing rule');
    assert.match(c, /Andy 4\.2 Air/, 'keeps the chat-model fact for Bob himself');
    assert.match(c, /Google Gemini \(gemini-3\.8-flash\)/, 'keeps the code-model fact');
    assert.match(c, /nomic-embed-text v1\.5 embedder/, 'keeps the embedder fact');
    for (const bad of ['Randy', 'Mac mini', 'living room', 'Leon', '192.168', 'LM Studio', 'localhost']) {
        assert.equal(c.includes(bad), false, `the prompt must not mention ${bad}`);
    }
    assert.match(c, /your own 128 by 128 claim is yours to use/, 'the rest of the prompt is untouched');
});

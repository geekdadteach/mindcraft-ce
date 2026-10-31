import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { AndyPool } from '../src/models/andy_pool.js';
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

// Minimal OpenAI-compatible chat server standing in for LM Studio.
function fakeLm(reply) {
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    id: 'x', object: 'chat.completion', created: 0, model: 'andy-4.2',
                    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                }));
            });
        });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

// A local port with nothing listening (connection refused).
function deadUrl() {
    return new Promise(resolve => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(`http://127.0.0.1:${p}/v1`)); });
    });
}

const noFallback = (extra = {}) => ({ mode: 'lmstudio_primary', lmstudio_model: 'andy-4.2', api_fallback: false, lmstudio_connect_timeout_ms: 300, ...extra });

test('default keeps the Andy API backup (behaviour unchanged)', () => {
    const p = new AndyPool('auto', 'http://127.0.0.1:1/v1', { mode: 'lmstudio_primary' });
    assert.equal(p.api_fallback, true);
    assert.ok(p.andy instanceof Andy);
});

test('api_fallback=false creates no Andy client and forces lmstudio_primary', () => {
    const p = new AndyPool('auto', 'http://127.0.0.1:1/v1', { mode: 'share', api_fallback: false });
    assert.equal(p.api_fallback, false);
    assert.equal(p.andy, null);
    assert.equal(p.mode, 'lmstudio_primary');
});

test('missing or empty lmstudio_fallback_urls = only the profile url', () => {
    const a = new AndyPool('auto', 'http://127.0.0.1:1/v1', noFallback());
    const b = new AndyPool('auto', 'http://127.0.0.1:1/v1', noFallback({ lmstudio_fallback_urls: [] }));
    assert.deepEqual(a.lm_urls, ['http://127.0.0.1:1/v1']);
    assert.deepEqual(b.lm_urls, ['http://127.0.0.1:1/v1']);
});

test('LM Studio up: reply comes from LM Studio', async () => {
    resetPool();
    const srv = await fakeLm('hello from lm');
    try {
        const url = `http://127.0.0.1:${srv.address().port}/v1`;
        const p = new AndyPool('auto', url, noFallback({ lmstudio_fallback_urls: [] }));
        const res = await p.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
        assert.equal(res, 'hello from lm');
        assert.equal(andyCalls, 0);
    } finally { srv.close(); }
});

test('LM Studio down: model-error placeholder (never chatted), no API call', async () => {
    resetPool();
    const url = await deadUrl();
    const p = new AndyPool('auto', url, noFallback({ lmstudio_fallback_urls: [] }));
    const t0 = Date.now();
    const res = await p.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    assert.ok(isModelErrorReply(res), `expected a model-error placeholder, got ${JSON.stringify(res)}`);
    assert.equal(andyCalls, 0);
    assert.ok(Date.now() - t0 < 10000, 'returns quickly instead of waiting for an API slot');
    // While LM Studio is paused after the failure, the next call also returns at once without the API.
    assert.ok(AndyPool._lmDownUntil > Date.now());
    const res2 = await p.sendRequest([{ role: 'user', content: 'hi again' }], 'sys');
    assert.ok(isModelErrorReply(res2));
    assert.equal(andyCalls, 0);
});

test('LM Studio empty reply: placeholder, no API call', async () => {
    resetPool();
    const srv = await fakeLm('');
    try {
        const url = `http://127.0.0.1:${srv.address().port}/v1`;
        const p = new AndyPool('auto', url, noFallback());
        const res = await p.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
        assert.ok(isModelErrorReply(res));
        assert.equal(andyCalls, 0);
    } finally { srv.close(); }
});

test('api_fallback=false: embeddings never go to the API (callers use word overlap)', async () => {
    const p = new AndyPool('auto', 'http://127.0.0.1:1/v1', noFallback());
    await assert.rejects(() => p.embed('text'), /api_fallback=false/);
    await assert.rejects(() => p.embedMany(['a', 'b']), /api_fallback=false/);
    assert.equal(andyCalls, 0);
});

test('LITE keeps coding allowed (no allow_insecure_coding=false, no !newAction block)', () => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
        "const s = (await import('./settings.js')).default; console.log(JSON.stringify({ mode: s.bob_mode, code: s.allow_insecure_coding, blocked: s.blocked_actions.includes('!newAction'), vision: s.allow_vision, profiles: s.profiles }));"],
        { env: { ...process.env, BOB_MODE: 'lite' }, encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.equal(r.mode, 'lite');
    assert.equal(r.code, true);
    assert.equal(r.blocked, false);
    assert.equal(r.vision, false);
    assert.deepEqual(r.profiles, ['./profiles/andy-api-lite.json']);
});

test('profiles: chat is LM Studio only; code_model is Gemini (live) or the Andy API (lite)', async () => {
    const fs = await import('node:fs');
    // Oct 31 2026: Randy moved the live profile's code lane to Gemini.
    const codeModels = {
        'profiles/andy-api-lite.json': { api: 'andy', model: 'claude-haiku-5.5' },
        'profiles/andy-api.json': { api: 'google', model: 'gemini-3.8-flash' },
    };
    for (const [f, cm] of Object.entries(codeModels)) {
        const pr = JSON.parse(fs.readFileSync(f, 'utf8'));
        assert.equal(pr.model.api, 'andy_pool', f);
        assert.equal(pr.model.params.api_fallback, false, f);
        assert.deepEqual(pr.model.params.lmstudio_fallback_urls, [], f);
        assert.equal(pr.code_model.api, cm.api, f);
        assert.equal(pr.code_model.model, cm.model, f);
        assert.equal(pr.vision_model, undefined, f);
        assert.equal(pr.embedding.params?.fallback_urls, undefined, f);
    }
});

// [ai-player] 2026-11-01 (item 5) - promptCoding must clear awaiting_coding on any outcome (try/finally)
// and retry a transport/5xx (e.g. 503) coding failure once. A stuck flag blocked the whole code lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Prompter, codingFailureIsRetryable } from '../src/models/prompter.js';

test('codingFailureIsRetryable covers 5xx/transport, not prompt-specific errors', () => {
    assert.equal(codingFailureIsRetryable(new Error('Andy API status: 503')), true);
    assert.equal(codingFailureIsRetryable(new Error('HTTP error! status: 503')), true);
    assert.equal(codingFailureIsRetryable(new Error('fetch failed')), true);
    assert.equal(codingFailureIsRetryable(new Error('request timeout')), true);
    assert.equal(codingFailureIsRetryable(new Error('context length exceeded')), false);
    assert.equal(codingFailureIsRetryable(new Error('invalid request')), false);
    assert.equal(codingFailureIsRetryable(null), false);
});

// A minimal `this` for Prompter.prototype.promptCoding.
function fakePrompter({ send }) {
    return {
        awaiting_coding: false,
        profile: { coding: 'CODE' },
        coding_examples: [],
        code_model: {},
        checkCooldown: async () => {},
        replaceStrings: async (p) => p,
        _saveLog: async () => {},
        _sendObservedModel: send,
    };
}

test('awaiting_coding is cleared even when the coding call throws', async () => {
    const p = fakePrompter({ send: async () => { throw new Error('boom'); } });
    await assert.rejects(() => Prompter.prototype.promptCoding.call(p, []));
    assert.equal(p.awaiting_coding, false, 'the flag is reset in finally');
});

test('a 503 coding failure is retried once, then succeeds', async () => {
    let calls = 0;
    const p = fakePrompter({ send: async () => { calls++; if (calls === 1) throw new Error('Andy API status: 503'); return 'code'; } });
    const resp = await Prompter.prototype.promptCoding.call(p, []);
    assert.equal(resp, 'code');
    assert.equal(calls, 2, 'retried exactly once');
    assert.equal(p.awaiting_coding, false);
});

test('a prompt-specific coding failure is not retried', async () => {
    let calls = 0;
    const p = fakePrompter({ send: async () => { calls++; throw new Error('context length exceeded'); } });
    await assert.rejects(() => Prompter.prototype.promptCoding.call(p, []));
    assert.equal(calls, 1, 'no retry for a prompt-specific error');
    assert.equal(p.awaiting_coding, false);
});

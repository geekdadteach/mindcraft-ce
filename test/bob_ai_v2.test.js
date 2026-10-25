import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BobAIReceipts } from '../src/agent/library/bob_ai_v2.js';
import { BobV2Receipts } from '../src/agent/library/bob_brain_v2.js';

function withFile(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'bob-ai-v2-'));
    try { return fn(join(dir, 'ai.jsonl')); }
    finally { rmSync(dir, { recursive: true, force: true }); }
}

function rows(path) {
    return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('AI receipts are opt-in and disabled calls behave identically', async () => {
    const receipts = new BobAIReceipts({ env: {} });
    let called = 0;
    const result = await receipts.observe('conversation', async () => ++called);
    assert.equal(result, 1);
    assert.equal(called, 1);
    receipts.close();
});

test('real model call produces private AI records correlated with one Brain job', async () => {
    await withFile(async (file) => {
        const receipts = new BobAIReceipts({ env: { BOB_AI_V2_EVENT_LOG: file } });
        const secret = 'sk-proj-this-should-never-appear';
        const result = await receipts.observe(
            'conversation',
            async () => 'response contains ' + secret,
            ['job-42']
        );
        receipts.close();
        assert.match(result, /response contains/);
        const events = rows(file);
        assert.deepEqual(events.map(e => e.type), ['model_request', 'model_response']);
        assert.deepEqual(events.map(e => e.source), ['ai', 'ai']);
        assert(events.every(e => e.trace_id === 'job-42'));
        assert(events.every(e => e.event_id && e.summary.includes('lane=conversation')));
        assert.equal(events[0].summary.split(' ')[0], events[1].summary.split(' ')[0]);
        assert.equal(readFileSync(file, 'utf8').includes(secret), false);
        assert.equal(statSync(file).mode & 0o027, 0);
    });
});

test('errors are reported without leaking the error, and propagated unchanged', async () => {
    await withFile(async (file) => {
        const receipts = new BobAIReceipts({ env: { BOB_AI_V2_EVENT_LOG: file } });
        const error = new Error('private prompt and token text');
        await assert.rejects(
            receipts.observe('coding', async () => { throw error; }, ['job-42']),
            e => e === error
        );
        receipts.close();
        const events = rows(file);
        assert.deepEqual(events.map(e => e.type), ['model_request', 'error']);
        assert.equal(events[1].summary.includes('private'), false);
    });
});

test('two advice notes share one call ID and unrelated calls get local traces', async () => {
    await withFile(async (file) => {
        const receipts = new BobAIReceipts({ env: { BOB_AI_V2_EVENT_LOG: file } });
        await receipts.observe('conversation', async () => 'ok', ['job-a', 'job-b', 'job-a']);
        await receipts.observe('vision', async () => 'ok');
        receipts.close();
        const events = rows(file);
        assert.equal(events.length, 6);
        assert.deepEqual(events.slice(0, 4).map(e => e.trace_id),
            ['job-a', 'job-b', 'job-a', 'job-b']);
        assert.match(events[4].trace_id, /^ai\.[0-9a-f]{16}$/);
        assert.equal(events[4].trace_id, events[5].trace_id);
        assert.equal(new Set(events.map(e => e.event_id)).size, 6);
    });
});

test('model trace IDs are scoped to the exact assembled prompt turn', () => {
    const receipts = new BobV2Receipts({
        config: { enabled: true },
        writer: { disabled: false, append: () => true, close: () => {} }
    });
    const note = { jobId: 'job-7', kind: 'failure_analysis', text: 'Avoid lava.' };
    const brain = {
        _freshAdvice: () => [note],
        adviceBlock: () => '- (failure_analysis) Avoid lava.'
    };
    const token = receipts.observePrompt(
        brain,
        'Bob Brain suggestion (unverified):\n- (failure_analysis) Avoid lava.',
        { conversationPrompt: true, armAction: true }
    );
    assert.deepEqual(receipts.modelTraceIds(token), ['job-7']);
    assert.deepEqual(receipts.modelTraceIds(token + 1), []);
    receipts.supersedeTurn();
    assert.deepEqual(receipts.modelTraceIds(token), []);
});

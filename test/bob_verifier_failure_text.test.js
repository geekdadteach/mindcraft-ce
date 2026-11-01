// [ai-player] Fix 4.11 - a task text that says it failed is never reported as met.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FAILURE_PHRASES, textReportsFailure, verifyGoal } from '../src/agent/library/bob_goal_verifier.js';
import { BobEvalHarness } from '../src/agent/library/bob_eval_harness.js';

test('FAILURE_PHRASES is narrow: only whole-action failures', () => {
    assert.ok(Array.isArray(FAILURE_PHRASES));
    for (const p of ['not confirmed', 'no path', 'unreachable', 'could not find']) assert.ok(FAILURE_PHRASES.includes(p), p);
    assert.equal(FAILURE_PHRASES.includes('could not'), false, 'the broad phrase is gone');
    assert.equal(FAILURE_PHRASES.includes('failed'), false, 'the broad phrase is gone');
});

test('textReportsFailure detects failure text and ignores success text', () => {
    assert.equal(textReportsFailure('Chest deposit not confirmed (0/32 clay_ball)'), true);
    assert.equal(textReportsFailure('Could not find food nearby (none within 64 blocks)'), true);
    assert.equal(textReportsFailure(''), false);
    assert.equal(textReportsFailure('Successfully put 4 bread in the chest.'), false);
});

test('verifyGoal downgrades a met verdict when the result text says it failed', () => {
    const before = { inventory: [], position: { x: 0, y: 64, z: 0 } };
    const after = { inventory: [{ name: 'oak_log', count: 6 }], position: { x: 0, y: 64, z: 0 } };
    const desc = { command: '!collectBlocks', item: 'oak_log', count: 4 };
    assert.equal(verifyGoal({ before, after, descriptor: desc }).verdict, 'met', 'the collect verifier alone says met');
    const r = verifyGoal({ before, after, descriptor: desc, resultText: 'Chest deposit not confirmed (0/6 oak_log)' });
    assert.equal(r.verdict, 'not_met');
    assert.equal(r.verdict_source, 'result-text');
});

test('a kind verdict that already failed keeps its own label', () => {
    const before = { inventory: [], position: { x: 0, y: 64, z: 0 } };
    const after = { inventory: [], position: { x: 0, y: 64, z: 0 } };
    const r = verifyGoal({ before, after, descriptor: { command: '!collectBlocks', item: 'oak_log', count: 4 }, resultText: 'Could not find any oak_log.' });
    assert.equal(r.verdict, 'not_met');
    assert.equal(r.verdict_source, 'collect');
});




test('the harness passes the last command result summary to the verifier', () => {
    const seen = [];
    const h = new BobEvalHarness({ config: { enabled: true }, env: {}, writer: { enqueue: (r) => seen.push(r) } });
    h.noteExecEnd({ result_summary: 'Chest deposit not confirmed (0/1 oak_log)', result: '' }, null);
    assert.equal(h._lastResultText, 'Chest deposit not confirmed (0/1 oak_log)');
    const src = fs.readFileSync(new URL('../src/agent/library/bob_eval_harness.js', import.meta.url), 'utf8');
    assert.match(src, /resultText: this\._lastResultText/, 'noteGoalCheck passes the summary');
    assert.match(src, /this\._lastResultText = summary/, 'noteExecEnd stores the summary');
    assert.match(src, /this\._lastResultText = ''/, 'it is reset per command');
    const before = { position: { x: 0, y: 64, z: 0 }, inventory: [] };
    const after = { position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'oak_log', count: 6 }] };
    const r = verifyGoal({ before, after, descriptor: { command: '!collectBlocks', item: 'oak_log', count: 4 }, resultText: h._lastResultText });
    assert.equal(r.verdict, 'not_met');
    assert.equal(r.verdict_source, 'result-text');
});




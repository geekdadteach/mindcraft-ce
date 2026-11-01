// [ai-player] Fix 4.11 - a task text that says it failed is never reported as met.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_PHRASES, textReportsFailure, verifyGoal } from '../src/agent/library/bob_goal_verifier.js';

test('FAILURE_PHRASES covers the shared failure texts', () => {
    assert.ok(Array.isArray(FAILURE_PHRASES));
    for (const p of ['not confirmed', 'could not', 'failed']) assert.ok(FAILURE_PHRASES.includes(p), p);
});

test('textReportsFailure detects failure text and ignores success text', () => {
    assert.equal(textReportsFailure('Chest deposit not confirmed (0/32 clay_ball)'), true);
    assert.equal(textReportsFailure('Could not find food nearby (none within 64 blocks)'), true);
    assert.equal(textReportsFailure(''), false);
    assert.equal(textReportsFailure('Successfully put 4 bread in the chest.'), false);
});

test('verifyGoal never reports met when the result text says it failed', () => {
    const before = { inventory: [], position: { x: 0, y: 64, z: 0 } };
    const after = { inventory: [], position: { x: 0, y: 64, z: 0 } };
    const r = verifyGoal({ goalText: '!getFood', resultText: 'Could not find food nearby (none within 64 blocks)', before, after, descriptor: {} });
    assert.equal(r.verdict, 'not_met');
    assert.equal(r.verdict_source, 'result-text');
});


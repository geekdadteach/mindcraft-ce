// [ai-player] Fix 6 — the code lane startup log and its reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BobEvalHarness, codeLaneInfo } from '../src/agent/library/bob_eval_harness.js';

test('codeLaneInfo reports the lane, the mode and the reason', () => {
    const on = codeLaneInfo({ coderMode: 'auto', codingEnabled: true });
    assert.equal(on.lane, 'coding');
    assert.equal(on.selected_lane, 'coding');
    assert.equal(on.coder_mode, 'auto');
    assert.equal(on.coding_enabled, true);
    assert.match(on.reason, /code lane selected/);
    const off = codeLaneInfo({ coderMode: 'manual', codingEnabled: false });
    assert.equal(off.coding_enabled, false);
    assert.equal(off.coder_mode, 'manual');
    assert.match(off.reason, /disabled/);
    assert.equal(codeLaneInfo({}).coder_mode, 'auto', 'default mode');
});

test('noteTurnStart records the coder lane and its reason', () => {
    const seen = [];
    const h = new BobEvalHarness({ config: { enabled: true }, env: {}, writer: { enqueue: (r) => seen.push(r) } });
    assert.equal(h.enabled, true);
    h.noteLaneSelection({ coderMode: 'auto', codingEnabled: true });
    h.noteTurnStart({}, { source: 'self', self_prompt: true, iteration: 1 });
    const rec = seen.find(r => r.type === 'turn_start');
    assert.ok(rec, 'a turn_start event was emitted');
    assert.equal(rec.lane, 'coding');
    assert.equal(rec.coder_mode, 'auto');
    assert.equal(rec.coding_enabled, true);
    assert.match(rec.lane_reason, /code lane selected/);
});

test('the code lane startup log is wired into the agent and the coder', () => {
    const agent = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    assert.match(agent, /code lane startup log/, 'the agent logs the lane at startup');
    const coder = fs.readFileSync(new URL('../src/agent/coder.js', import.meta.url), 'utf8');
    assert.match(coder, /logLaneOnce/, 'the coder logs the lane once');
    assert.match(coder, /noteLaneSelection/, 'the coder records the lane on the harness');
});

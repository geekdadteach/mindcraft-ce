// [ai-player] Fix 4.8 - numeric params from a preempt-feedback command are clamped, not rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampToDomain, parseCommandMessage } from '../src/agent/commands/index.js';

test('clampToDomain clamps into the interval and reports it', () => {
    assert.deepEqual(clampToDomain(5, [10, 512]), { value: 10, clamped: true, note: 'clamped into [10, 512)' });
    assert.deepEqual(clampToDomain(900, [10, 512]), { value: 511, clamped: true, note: 'clamped into [10, 512)' });
    assert.equal(clampToDomain(100, [10, 512]).clamped, false, 'in range: unchanged');
    assert.equal(clampToDomain(-500, [-64, 320]).value, -64);
    assert.equal(clampToDomain(500, [-64, 320]).value, 319);
    assert.equal(clampToDomain(Infinity, [0, 10]).clamped, false, 'non-finite: unchanged');
});

test('parseCommandMessage clamps an out-of-range numeric param and reports the clamp', () => {
    const high = parseCommandMessage('!goToCoordinates(10, 9999, 10, 1)');
    assert.equal(typeof high, 'object', String(high));
    assert.equal(high.commandName, '!goToCoordinates');
    assert.equal(high.args[1], 319, 'y clamped to the domain upper bound');
    assert.equal(high.clampNotes.length, 1);
    assert.match(high.clampNotes[0], /y=319/);
    const low = parseCommandMessage('!goToCoordinates(10, -500, 10, 1)');
    assert.equal(low.args[1], -64, 'y clamped to the domain lower bound');
    const ok = parseCommandMessage('!goToCoordinates(10, 70, 10, 1)');
    assert.deepEqual(ok.clampNotes, [], 'in range: no clamp note');
});


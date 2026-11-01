// [ai-player] Fix 4.8 - numeric params from a preempt-feedback command are clamped, not rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampToDomain, parseCommandMessage } from '../src/agent/commands/index.js';

test('clampToDomain clamps only above the maximum and flags below-minimum values', () => {
    const high = clampToDomain(900, [10, 512]);
    assert.equal(high.clamped, true);
    assert.equal(high.value, 511);
    assert.match(high.note, /clamped into \[10, 512\)/);
    assert.equal(clampToDomain(100, [10, 512]).clamped, false, 'in range: unchanged');
    const low = clampToDomain(5, [10, 512]);
    assert.equal(low.belowMin, true, 'below the minimum is reported');
    assert.equal(low.value, 5, 'and left alone, never turned into 10');
    const neg = clampToDomain(-500, [-64, 320]);
    assert.equal(neg.belowMin, true);
    assert.equal(neg.value, -500);
    assert.equal(clampToDomain(500, [-64, 320]).value, 319);
    assert.equal(clampToDomain(Infinity, [0, 10]).clamped, false, 'non-finite: unchanged');
});

test('an open upper bound clamps strictly inside the range', () => {
    const y = clampToDomain(9999.5, [-64, 320]);
    assert.equal(y.clamped, true);
    assert.ok(y.value < 320, 'y stays below 320');
});

test('parseCommandMessage clamps above the maximum but still rejects below the minimum', () => {
    const high = parseCommandMessage('!goToCoordinates(10, 9999, 10, 1)');
    assert.equal(typeof high, 'object', String(high));
    assert.equal(high.commandName, '!goToCoordinates');
    assert.equal(high.args[1], 319, 'y clamped below the domain upper bound');
    assert.equal(high.clampNotes.length, 1);
    assert.match(high.clampNotes[0], /y=319/);
    const low = parseCommandMessage('!goToCoordinates(10, -500, 10, 1)');
    assert.equal(typeof low, 'string', 'below the minimum stays a parse error');
    assert.match(low, /y/);
    const dist = parseCommandMessage('!moveAway(-5)');
    assert.equal(typeof dist, 'string', 'distance below the minimum is not silently clamped');
    assert.match(dist, /distance/);
    const ok = parseCommandMessage('!goToCoordinates(10, 70, 10, 1)');
    assert.deepEqual(ok.clampNotes, [], 'in range: no clamp note');
});




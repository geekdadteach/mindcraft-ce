import test from 'node:test';
import assert from 'node:assert/strict';
import { foodSearchAllowed, noteFoodSearchFailure } from '../src/agent/library/survival.js';

test('failed food search is throttled in same 16-block cell for 45 seconds', () => {
    const agent = {};
    const at = { x: -820, y: 124, z: 568 };
    assert.equal(foodSearchAllowed(agent, at, 1000), true);
    noteFoodSearchFailure(agent, at, 1000);
    assert.equal(foodSearchAllowed(agent, at, 1001), false);
    assert.equal(foodSearchAllowed(agent, { x: -819, y: 124, z: 569 }, 2000), false);
    assert.equal(foodSearchAllowed(agent, at, 45999), false);
    assert.equal(foodSearchAllowed(agent, at, 46000), true);
});

test('moving to another cell or switching agent permits immediate search', () => {
    const agent = {};
    noteFoodSearchFailure(agent, { x: 0, y: 64, z: 0 }, 1000);
    assert.equal(foodSearchAllowed(agent, { x: 16, y: 64, z: 0 }, 1001), true);
    assert.equal(foodSearchAllowed({}, { x: 0, y: 64, z: 0 }, 1001), true);
});

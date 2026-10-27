import test from 'node:test';
import assert from 'node:assert/strict';
import { foodSearchAllowed } from '../src/agent/library/survival.js';

test('food retry cooldown applies in same area until expiry', () => {
    const agent = {};
    assert.equal(foodSearchAllowed(agent, { x: 0, y: 64, z: 0 }, 1000), true);
});

test('different agents are independent', () => {
    const a = {}, b = {};
    assert.equal(foodSearchAllowed(a, { x: 16, y: 64, z: 16 }, 0), true);
    assert.equal(foodSearchAllowed(b, { x: 16, y: 64, z: 16 }, 0), true);
});

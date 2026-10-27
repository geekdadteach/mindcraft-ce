import test from 'node:test';
import assert from 'node:assert/strict';
import { foodSearchAllowed, noteFoodSearchFailure, foodRelocationCandidates, foodRelocationGround } from '../src/agent/library/survival.js';

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

test('recovery destinations are bounded and never inside a no-go zone', () => {
    const targets = foodRelocationCandidates({ x: -820, y: 124, z: 568 });
    assert.equal(targets.length, 12);
    assert.ok(targets.every(p => Math.hypot(p.x + 820, p.z - 568) <= 28));
    assert.equal(foodRelocationCandidates({ x: -572, y: 69, z: 480 }).length, 0);
});

test('recovery selects safe ground at a different elevation', () => {
    const blocks = new Map();
    const put = (x, y, z, name, boundingBox) => blocks.set([x, y, z].join(','), {name, boundingBox});
    put(10, 63, 20, 'stone', 'block');
    put(10, 64, 20, 'air', 'empty');
    put(10, 65, 20, 'air', 'empty');
    const bot = {blockAt: p => blocks.get([p.x, p.y, p.z].join(',')) || null};
    const ground = foodRelocationGround(bot, {x: 10, y: 62, z: 20});
    assert.deepEqual([ground.x, ground.y, ground.z], [10, 64, 20]);
    put(10, 63, 20, 'lava', 'block');
    assert.equal(foodRelocationGround(bot, {x: 10, y: 62, z: 20}), null);
    assert.equal(foodRelocationGround(bot, {x: -572, y: 69, z: 480}), null);
});

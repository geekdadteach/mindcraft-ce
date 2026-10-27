import test from 'node:test';
import assert from 'node:assert/strict';
import { foodSearchAllowed, noteFoodSearchFailure, foodRelocationCandidates, foodRelocationGround, relocateForFood, inBobFarmArea } from '../src/agent/library/survival.js';

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

function recoveryBot() {
    const origin = {x: -820, y: 124, z: 568};
    const position = { ...origin, clone() { return {...this, distanceTo(other) {
        return Math.hypot(this.x-other.x, this.y-other.y, this.z-other.z);
    }}; }, distanceTo(other) { return Math.hypot(this.x-other.x, this.y-other.y, this.z-other.z); }};
    return {
        health: 1, food: 0, interrupt_code: false, entity: {position},
        blockAt(p) {
            return { name: p.y === 123 ? 'stone' : 'air', boundingBox: p.y === 123 ? 'block' : 'empty' };
        }
    };
}
test('at 1 health and zero food recovery executes a path to a new area', async () => {
    const bot = recoveryBot();
    const visited = [];
    const ok = await relocateForFood({bot}, {navigate: async (b, goal) => {
        visited.push(goal);
        Object.assign(b.entity.position, {x: goal.x, y: goal.y, z: goal.z});
        return true;
    }});
    assert.equal(ok, true);
    assert.equal(visited.length, 1);
    assert.ok(bot.entity.position.distanceTo({x:-820,y:124,z:568}) >= 8);
});
test('unreachable routes stop after six attempts and never claim progress', async () => {
    const bot = recoveryBot();
    let attempts = 0;
    const ok = await relocateForFood({bot}, {navigate: async () => { attempts++; return false; }});
    assert.equal(ok, false);
    assert.equal(attempts, 6);
});
test('interruption prevents recovery and aborts subsequent routes', async () => {
    const bot = recoveryBot();
    bot.interrupt_code = true;
    assert.equal(await relocateForFood({bot}, {navigate: async () => { throw Error('must not navigate'); }}), false);
    bot.interrupt_code = false;
    let attempts = 0;
    assert.equal(await relocateForFood({bot}, {navigate: async () => {
        attempts++;
        bot.interrupt_code = true;
        return false;
    }}), false);
    assert.equal(attempts, 1);
});
test('blocked terrain prevents blind navigation', async () => {
    const bot = recoveryBot();
    bot.blockAt = () => null;
    let attempts = 0;
    assert.equal(await relocateForFood({bot}, {navigate: async () => {attempts++; return true;}}), false);
    assert.equal(attempts, 0);
});

test('first recovery attempts cover all four compass directions', () => {
    const origin = {x: -820, y: 124, z: 568};
    const first = foodRelocationCandidates(origin).slice(0, 4);
    assert.deepEqual(first.map(p => [p.x-origin.x, p.z-origin.z]),
        [[-12, 0], [0, -12], [12, 0], [0, 12]]);
});

test('farming never targets house structures, no-go zones or distant farmland', () => {
    assert.equal(inBobFarmArea({x:-823,y:124,z:568}), false);
    assert.equal(inBobFarmArea({x:-830,y:124,z:580}), true);
    assert.equal(inBobFarmArea({x:-750,y:124,z:568}), false);
    assert.equal(inBobFarmArea({x:-572,y:69,z:480}), false);
});

// [ai-player] Fix 2 — the food loop: desperate edibles, regen eat, relocation, verified hunts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DESPERATE_FOODS, edibleFoods, shouldEatForRegen, getFood, huntAnimal,
    farFoodCandidates, foodRelocateEnabled,
} from '../src/agent/library/survival.js';

const at = (x, y, z) => ({ x, y, z, distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z), floored() { return at(Math.floor(x), Math.floor(y), Math.floor(z)); }, clone() { return at(this.x, this.y, this.z); } });
const FOODS = { bread: { foodPoints: 5 }, beef: { foodPoints: 8 }, spider_eye: { foodPoints: 2 }, rotten_flesh: { foodPoints: 4 }, chicken: { foodPoints: 2 } };
function foodBot({ food = 20, health = 20, items = [], banned = ['spider_eye', 'rotten_flesh', 'chicken'] } = {}) {
    return { output: '', food, health, inventory: { items: () => items }, registry: { foodsByName: FOODS }, autoEat: { options: { bannedFood: banned } }, entities: {} };
}

test('edibleFoods only allows spider_eye/rotten_flesh when desperate', () => {
    const items = [{ name: 'spider_eye', count: 2 }, { name: 'rotten_flesh', count: 1 }, { name: 'bread', count: 1 }];
    const bot = foodBot({ items });
    assert.deepEqual(edibleFoods(bot, false).map(i => i.name), ['bread']);
    assert.deepEqual(edibleFoods(bot, true).map(i => i.name).sort(), ['bread', 'rotten_flesh', 'spider_eye']);
    assert.equal(DESPERATE_FOODS.has('spider_eye'), true);
});

test('shouldEatForRegen tops up when hurt and below 18 with food in hand', () => {
    const bread = [{ name: 'bread', count: 1 }];
    assert.equal(shouldEatForRegen(foodBot({ food: 16, health: 5, items: bread })), true, 'food 16 / health 5: eat');
    assert.equal(shouldEatForRegen(foodBot({ food: 17, health: 19, items: bread })), true, 'food < 18: eat');
    assert.equal(shouldEatForRegen(foodBot({ food: 18, health: 5, items: bread })), false, 'food >= 18: regen already on');
    assert.equal(shouldEatForRegen(foodBot({ food: 16, health: 20, items: bread })), false, 'full health: no need');
    assert.equal(shouldEatForRegen(foodBot({ food: 16, health: 5, items: [] })), false, 'nothing to eat: stay');
});

test('farFoodCandidates keeps to a 96..160 ring outside no-go zones, and the opt-out works', () => {
    assert.equal(foodRelocateEnabled({}), true);
    assert.equal(foodRelocateEnabled({ BOB_FOOD_RELOCATE: '0' }), false);
    const cands = farFoodCandidates({ x: 0, y: 64, z: 0 });
    assert.ok(cands.length > 0);
    for (const c of cands) assert.ok(Math.hypot(c.x, c.z) >= 90, 'on the ring');
    const market = farFoodCandidates({ x: -572, y: 69, z: 480 });
    for (const c of market) assert.ok(Math.hypot(c.x + 572, c.z - 480) >= 64, 'outside the no-go zone');
});

test('getFood relocates after 2 consecutive empty local searches', async () => {
    let relocations = 0;
    const agent = { bot: foodBot({ food: 4, health: 20 }), failures: { record() {}, isBlocked: () => false } };
    const hunt = async () => ({ ok: false, why: 'none' });
    const relocateFar = async () => { relocations += 1; return true; };
    assert.equal(await getFood(agent, { hunt, relocateFar, env: {} }), false);
    assert.equal(relocations, 0, 'one empty search does not relocate');
    assert.equal(await getFood(agent, { hunt, relocateFar, env: {} }), false);
    assert.equal(relocations, 1, 'relocates on the second consecutive empty search');
    assert.equal(await getFood(agent, { hunt, relocateFar, env: { BOB_FOOD_RELOCATE: '0' } }), false);
    assert.equal(relocations, 1, 'the opt-out stops relocation');
});

test('huntAnimal is ok only when a food count rises', async () => {
    const inv = [];
    const animal = { id: 7, name: 'cow', type: 'mob', metadata: {}, position: at(1, 64, 0) };
    const cows = [animal, { id: 8, name: 'cow', type: 'mob', metadata: {}, position: at(40, 64, 0) }, { id: 9, name: 'cow', type: 'mob', metadata: {}, position: at(41, 64, 0) }];
    const bot = { output: '', entity: { position: at(0, 64, 0) }, inventory: { slots: [], items: () => inv }, registry: { foodsByName: FOODS }, entities: { 7: animal, 8: cows[1], 9: cows[2] }, nearestEntity: (pred) => cows.find(pred) };
    const agent = { bot, failures: { record() {}, isBlocked: () => false } };
    assert.equal((await huntAnimal(agent, 16, { attack: async () => {}, collect: async () => {} })).ok, false, 'no drop: not ok');
    const r = await huntAnimal(agent, 16, { attack: async () => {}, collect: async () => { inv.push({ name: 'beef', count: 1 }); } });
    assert.equal(r.ok, true, 'a drop makes it ok');
    assert.ok(r.got >= 1);
});

// [ai-player] 2026-11-01 (item 2a) - wheat_seeds and other non-edibles are never chosen as food.
// Live night 1: with only wheat_seeds in the inventory, hunger kept trying to eat them ("not food").
import test from 'node:test';
import assert from 'node:assert/strict';
import { edibleFoods, foodStock, eatBest, isEdibleItemName } from '../src/agent/library/survival.js';
import { hasEdibleFood } from '../src/agent/library/night_shelter.js';
import { criticalSurvivalGuard } from '../src/agent/library/bob_survival_gate.js';

const FOODS = { bread: { foodPoints: 5 }, beef: { foodPoints: 8 }, wheat_seeds: { foodPoints: 0 } };
function bot(items) {
    return {
        output: '', food: 10, health: 20,
        registry: { foodsByName: FOODS },
        inventory: { items: () => items },
        autoEat: { options: { bannedFood: [] } },
    };
}

test('isEdibleItemName rejects seeds and an explicit zero food value', () => {
    assert.equal(isEdibleItemName('bread', FOODS), true);
    assert.equal(isEdibleItemName('wheat_seeds', FOODS), false, 'a planting item is never food');
    assert.equal(isEdibleItemName('diamond', FOODS), false, 'not in the registry');
    assert.equal(isEdibleItemName('wheat_seeds', { wheat_seeds: { foodPoints: 0 } }), false, 'zero food value');
    assert.equal(isEdibleItemName('bread', { bread: {} }), true, 'a registry entry with no explicit value');
});

test('edibleFoods/foodStock never include wheat_seeds', () => {
    const b = bot([{ name: 'wheat_seeds', count: 64 }, { name: 'bread', count: 1 }]);
    assert.deepEqual(edibleFoods(b, false).map(i => i.name), ['bread']);
    assert.equal(foodStock(b), 1);
    const onlySeeds = bot([{ name: 'wheat_seeds', count: 64 }]);
    assert.deepEqual(edibleFoods(onlySeeds, true), [], 'nothing edible at all');
    assert.equal(foodStock(onlySeeds), 0);
});

test('eatBest does not try to eat a seed', async () => {
    const b = bot([{ name: 'wheat_seeds', count: 64 }]);
    let consumed = 0;
    b.equip = async () => {}; b.consume = async () => { consumed++; };
    assert.equal(await eatBest(b), false, 'no edible food: eatBest returns false');
    assert.equal(consumed, 0, 'and it never tried to consume the seed');
});

test('hasEdibleFood is false with only seeds', () => {
    assert.equal(hasEdibleFood(bot([{ name: 'wheat_seeds', count: 64 }])), false);
    assert.equal(hasEdibleFood(bot([{ name: 'bread', count: 1 }])), true);
    // no registry: the whole-name fallback must not mistake beetroot_seeds for beetroot
    const noReg = { output: '', registry: {}, inventory: { items: () => [{ name: 'beetroot_seeds' }] } };
    assert.equal(hasEdibleFood(noReg), false);
    const beetroot = { output: '', registry: {}, inventory: { items: () => [{ name: 'beetroot' }] } };
    assert.equal(hasEdibleFood(beetroot), true);
});

test('the survival gate never tells the model to eat a seed or a crafting item', () => {
    const seeds = { health: 2, food: 2, registry: { foodsByName: FOODS }, inventory: { items: () => [{ name: 'wheat_seeds', count: 64 }] } };
    const msg = criticalSurvivalGuard(seeds, '!collectBlocks', true, { args: ['coal_ore'] });
    assert.match(msg, /CRITICAL SURVIVAL/, 'still a critical block');
    assert.doesNotMatch(msg, /!consume/, 'but no eat suggestion for a seed');
    const bread = { health: 2, food: 2, registry: { foodsByName: FOODS }, inventory: { items: () => [{ name: 'bread', count: 2 }] } };
    assert.match(criticalSurvivalGuard(bread, '!collectBlocks', true, { args: ['coal_ore'] }), /!consume\("bread"\)/);
});

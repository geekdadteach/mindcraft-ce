// [ai-player] Fix 4.9 - consume() decides edibility from the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { consume, isEdible } from '../src/agent/library/skills.js';

const FOODS = { bread: {}, glow_berries: {}, dried_kelp: {} };
function foodBot(itemName) {
    return {
        output: '',
        registry: { foodsByName: FOODS },
        inventory: { findInventoryItem: (n) => (n === itemName ? { name: n, type: 1 } : null) },
        equip: async () => {}, consume: async () => {},
    };
}

test('isEdible allows registry foods and refuses non-foods', () => {
    assert.equal(isEdible(foodBot('bread'), 'bread'), true);
    assert.equal(isEdible(foodBot('bread'), 'glow_berries'), true, 'a registry food the old list missed');
    assert.equal(isEdible(foodBot('bread'), 'diamond'), false, 'not food');
    assert.equal(isEdible({}, 'diamond'), true, 'no registry: allow by default');
});

test('consume eats a registry food and refuses a non-food with the named message', async () => {
    assert.equal(await consume(foodBot('glow_berries'), 'glow_berries'), true, 'a registry food is eaten');
    const bot = foodBot('diamond');
    assert.equal(await consume(bot, 'diamond'), false, 'a non-food is refused');
    assert.match(bot.output, /cannot eat diamond/);
    const empty = foodBot('nothing');
    assert.equal(await consume(empty, 'apple'), false, 'missing item');
    assert.match(empty.output, /You do not have any apple to eat/);
});


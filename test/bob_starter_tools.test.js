// [ai-player] Fix 3 — planks alias and starter tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { correctName } from '../src/agent/library/long_memory.js';
import { starterToolsEnabled, needsStarterTools, craftStarterTools } from '../src/agent/library/survival.js';

const REG = {
    itemsByName: { spruce_planks: {}, oak_planks: {}, stick: {}, wooden_pickaxe: {}, wooden_sword: {} },
    blocksByName: { spruce_planks: {}, oak_planks: {}, spruce_log: {}, oak_log: {}, crafting_table: {} },
};
function agentWith(items) {
    return { bot: { registry: REG, inventory: { items: () => items }, findBlock: () => null } };
}

test('correctName maps planks to the held log wood type', () => {
    assert.equal(correctName(agentWith([{ name: 'spruce_log' }]), '!craftRecipe', 'planks', 'item'), 'spruce_planks');
    assert.equal(correctName(agentWith([]), '!craftRecipe', 'planks', 'item'), 'oak_planks');
    assert.equal(correctName(agentWith([{ name: 'stick' }]), '!craftRecipe', 'plank', 'item'), 'oak_planks');
});

test('craftStarterTools crafts planks, table, sticks, pickaxe, sword in order', async () => {
    const calls = [];
    const bot = { inventory: { items: () => [{ name: 'spruce_log' }] }, interrupt_code: false };
    const made = await craftStarterTools(bot, { craft: async (b, name) => { calls.push(name); return true; } });
    assert.deepEqual(calls, ['spruce_planks', 'crafting_table', 'stick', 'wooden_pickaxe', 'wooden_sword']);
    assert.deepEqual(made, calls);
});

test('starter tools are ON by default, opt-out via env, and only when logs are held', () => {
    assert.equal(starterToolsEnabled({}), true);
    assert.equal(starterToolsEnabled({ BOB_STARTER_TOOLS: '0' }), false);
    assert.equal(needsStarterTools({ inventory: { items: () => [{ name: 'oak_log' }] } }), true, 'log, no tools');
    assert.equal(needsStarterTools({ inventory: { items: () => [{ name: 'oak_log' }, { name: 'wooden_pickaxe' }, { name: 'wooden_sword' }] } }), false, 'has both');
    assert.equal(needsStarterTools({ inventory: { items: () => [{ name: 'oak_log' }, { name: 'wooden_pickaxe' }] } }), true, 'missing a sword');
    assert.equal(needsStarterTools({ inventory: { items: () => [] } }), false, 'no logs');
});

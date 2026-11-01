// [ai-player] Fix 3 — planks alias and starter tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { correctName } from '../src/agent/library/long_memory.js';
import { starterToolsEnabled, needsStarterTools, craftStarterTools, starterWoodType, starterPlanksName, heldLogCount, craftingTableAtHand } from '../src/agent/library/survival.js';

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

test('craftStarterTools needs 3 logs and crafts planks, table, sticks, pickaxe, sword in order', async () => {
    const calls = [];
    const mk = (items) => ({ inventory: { items: () => items }, interrupt_code: false });
    const craft = async (b, name, count) => { calls.push(name); return true; };
    assert.deepEqual(await craftStarterTools(mk([{ name: 'spruce_log', count: 1 }]), { craft }), [], 'one log: not enough');
    assert.deepEqual(await craftStarterTools(mk([{ name: 'spruce_log', count: 2 }]), { craft }), [], 'two logs: not enough');
    const made = await craftStarterTools(mk([{ name: 'spruce_log', count: 3 }]), { craft, tableNearby: false });
    assert.deepEqual(calls, ['spruce_planks', 'crafting_table', 'stick', 'wooden_pickaxe', 'wooden_sword']);
    assert.deepEqual(made, calls);
});

test('starter tools are ON by default, opt-out via env, and only when logs are held', () => {
    assert.equal(starterToolsEnabled({}), true);
    assert.equal(starterToolsEnabled({ BOB_STARTER_TOOLS: '0' }), false);
    assert.equal(needsStarterTools({ inventory: { items: () => [{ name: 'oak_log', count: 3 }] } }), true, '3 logs, no tools');
    assert.equal(needsStarterTools({ inventory: { items: () => [{ name: 'oak_log', count: 3 }, { name: 'wooden_pickaxe' }, { name: 'wooden_sword' }] } }), false, 'has both');
    assert.equal(needsStarterTools({ inventory: { items: () => [{ name: 'oak_log', count: 3 }, { name: 'wooden_pickaxe' }] } }), true, 'missing a sword');
    assert.equal(needsStarterTools({ inventory: { items: () => [] } }), false, 'no logs');
});

test('craftStarterTools skips the table at hand and tools Bob already has', async () => {
    const craft = async (b, name) => true;
    const mk = (items) => ({ inventory: { items: () => items }, interrupt_code: false });
    assert.deepEqual(await craftStarterTools(mk([{ name: 'oak_log', count: 3 }]), { craft, tableNearby: true }), ['oak_planks', 'stick', 'wooden_pickaxe', 'wooden_sword']);
    assert.deepEqual(await craftStarterTools(mk([{ name: 'oak_log', count: 3 }, { name: 'wooden_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }]), { craft, tableNearby: true }), ['oak_planks', 'stick']);
});

test('bamboo never maps to planks', () => {
    assert.equal(starterWoodType('bamboo'), null);
    assert.equal(starterWoodType('spruce_log'), 'spruce');
    assert.equal(starterWoodType('crimson_stem'), 'crimson');
    assert.equal(heldLogCount({ inventory: { items: () => [{ name: 'oak_log', count: 2 }, { name: 'bamboo', count: 9 }] } }), 2, 'bamboo is not a log');
    assert.equal(correctName(agentWith([{ name: 'bamboo' }]), '!craftRecipe', 'planks', 'item'), 'oak_planks');
});

test('the starter run uses the most plentiful wood type and needs 3 of it', async () => {
    const mk = (items) => ({ inventory: { items: () => items }, interrupt_code: false });
    assert.equal(starterPlanksName(mk([{ name: 'spruce_log', count: 2 }, { name: 'oak_log', count: 4 }])), 'oak_planks');
    assert.equal(heldLogCount(mk([{ name: 'spruce_log', count: 2 }, { name: 'oak_log', count: 4 }])), 4);
    assert.equal(starterPlanksName(mk([{ name: 'spruce_log', count: 4 }, { name: 'oak_log', count: 2 }])), 'spruce_planks');
    assert.equal(needsStarterTools(mk([{ name: 'oak_log', count: 2 }, { name: 'spruce_log', count: 2 }])), false, 'no single type reaches 3');
    assert.equal(needsStarterTools(mk([{ name: 'oak_log', count: 3 }, { name: 'spruce_log', count: 1 }])), true, '3 oak is enough');
    const calls = [];
    const made = await craftStarterTools(mk([{ name: 'spruce_log', count: 3 }]), { craft: async (b, n) => { calls.push(n); return true; }, tableNearby: false });
    assert.deepEqual(calls, ['spruce_planks', 'crafting_table', 'stick', 'wooden_pickaxe', 'wooden_sword']);
    assert.deepEqual(made, calls);
});

test('craftingTableAtHand looks 16 blocks, matching craftRecipe', () => {
    assert.equal(craftingTableAtHand({ inventory: { items: () => [] } }), false, 'no table with an unloaded world');
    const src = fs.readFileSync(new URL('../src/agent/library/survival.js', import.meta.url), 'utf8');
    assert.match(src, /craftingTableAtHand\(bot, range = 16\)/, 'the default range matches craftRecipe');
});


// [ai-player] Fix 2b round 2 - the regen top-up must not cook while sealed in the night shelter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initModes } from '../src/agent/modes.js';
import { markSheltered, clearShelter, isSheltered } from '../src/agent/library/shelter_state.js';
import { shouldEatForRegen } from '../src/agent/library/survival.js';

// The regen branch needs: hurt (health < 20), food under 18, and something edible.
// `inventory.slots` is read ONLY by world.getInventoryCounts, i.e. only by cookRaw. That is how this test
// tells "ate straight from the inventory" (eatBest) apart from "tried to cook first" (cookOrEat).
function mkAgent() {
    const slotReads = [];
    const state = { equipped: null, consumed: 0 };
    const inv = [{ name: 'bread', count: 3, type: 1 }];
    const bot = {
        food: 12,
        health: 12,
        output: '',
        registry: { foodsByName: { bread: { foodPoints: 5 } } },
        inventory: {
            items: () => inv,
            findInventoryItem: (n) => { const i = inv.find(x => x.name === n); return i ? { ...i } : undefined; },
            get slots() { slotReads.push(1); return []; },
        },
        equip: async (item) => { state.equipped = item.name; },
        consume: async () => { state.consumed += 1; },
        toss: async () => {},
        entity: { position: { x: 0, y: 64, z: 0 } },
        autoEat: { isEating: false, options: {} },
        time: { timeOfDay: 6000 },
        modes: { flushBehaviorLog: () => '' },
        pathfinder: { stop() {} },
    };
    const agent = {
        bot,
        prompter: { getInitModes: () => null },
        isIdle: () => true,
        self_prompter: { isActive: () => false },
        actions: {
            currentActionLabel: '',
            resume_func: null,
            runAction: async (label, fn) => { await fn(); return { message: '' }; },
            stop: async () => {},
        },
    };
    return { agent, bot, slotReads, state };
}

async function runRegen(agent) {
    initModes(agent);
    const hunger = agent.bot.modes.get('hunger');
    assert.ok(hunger, 'the hunger mode exists');
    hunger.active = false;
    hunger.holding = false;
    hunger.hungry_since = Date.now() - 20000; // past the mode's 15 s "let auto-eat try first" window
    await hunger.update(agent);
    for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); // the mode fires execute() without awaiting
    return hunger;
}

test('sheltered + hurt + food under 18 eats from the inventory and never cooks', async () => {
    const { agent, bot, slotReads, state } = mkAgent();
    assert.equal(shouldEatForRegen(bot), true, 'hurt and below 18 triggers the regen branch');
    markSheltered({ day: 1 });
    try {
        assert.equal(isSheltered(), true);
        await runRegen(agent);
        assert.equal(state.consumed, 1, 'it ate');
        assert.equal(state.equipped, 'bread', 'from the inventory');
        assert.match(bot.output, /Consumed bread\./);
        assert.equal(slotReads.length, 0, 'cookRaw never ran, so cookOrEat was never called');
    } finally {
        clearShelter();
    }
});

test('the same state while not sheltered still tries to cook first', async () => {
    const { agent, bot, slotReads, state } = mkAgent();
    clearShelter();
    assert.equal(isSheltered(), false);
    await runRegen(agent);
    assert.ok(slotReads.length > 0, 'cookRaw ran, so the cookOrEat path was taken');
    assert.equal(state.consumed, 1, 'and it still ate afterwards');
});

test('the regen branch uses the sheltered ternary', () => {
    const src = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    assert.match(
        src,
        /shelter\.isSheltered\(\) \? survival\.eatBest\(bot\) : survival\.cookOrEat\(bot\)/,
        'sheltered picks eatBest, otherwise cookOrEat',
    );
    const regen = src.indexOf('survival.shouldEatForRegen(bot)');
    const ternary = src.indexOf('shelter.isSheltered() ? survival.eatBest(bot) : survival.cookOrEat(bot)');
    assert.ok(regen > 0 && ternary > regen, 'the ternary lives inside the regen branch');
});

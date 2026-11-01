// [ai-player] 2026-11-01 (item 2b) - a sheltered Bob leaves for food when starving OR badly hurt, and the
// urgent food trip is LOCAL (relocate:false). Otherwise he waits for morning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initModes, getMode } from '../src/agent/modes.js';
import { emptyHome, setActiveHome } from '../src/agent/library/bob_home.js';
import { markSheltered, clearShelter } from '../src/agent/library/shelter_state.js';
import { shouldLeaveEarlyForFood } from '../src/agent/library/night_shelter.js';

test('shouldLeaveEarlyForFood: starving OR badly hurt with nothing edible', () => {
    setActiveHome(emptyHome());
    clearShelter();
    const bot = (food, health, items) => ({ food, health, registry: { foodsByName: { bread: { foodPoints: 5 } } }, inventory: { items: () => items } });
    assert.equal(shouldLeaveEarlyForFood(bot(6, 20, [])), false, 'not sheltered: no carve-out');
    markSheltered({ day: 1 });
    try {
        assert.equal(shouldLeaveEarlyForFood(bot(6, 20, [])), true, 'food <= 6: leave');
        assert.equal(shouldLeaveEarlyForFood(bot(17, 7, [])), true, 'health < 8: leave');
        assert.equal(shouldLeaveEarlyForFood(bot(17, 20, [])), false, 'not starving, not hurt: stay');
        assert.equal(shouldLeaveEarlyForFood(bot(17, 7, [{ name: 'bread' }])), false, 'hurt but has food: eat, stay');
    } finally { clearShelter(); }
});

// A minimal agent/bot for the hunger mode (mirrors bob_food_stock.test.js).
function mkAgent({ food = 6, health = 20, timeOfDay = 18000, items = [] } = {}) {
    const inv = [...items];
    const bot = {
        food, health, output: '', entities: {},
        registry: { foodsByName: { bread: { foodPoints: 5 } } },
        inventory: { items: () => inv, findInventoryItem: (n) => inv.find(x => x.name === n), get slots() { return []; } },
        equip: async () => {}, consume: async () => {}, toss: async () => {},
        entity: {
            position: {
                x: 0, y: 64, z: 0,
                distanceTo: (o) => Math.hypot(0 - o.x, 64 - o.y, 0 - o.z),
                clone() { return this; }, floored() { return this; },
            },
        },
        autoEat: { isEating: false, options: {} },
        time: { timeOfDay },
        nearestEntity: () => null,
        findBlocks: () => [], blockAt: () => null,
        modes: { flushBehaviorLog: () => '' },
        pathfinder: { stop() {} },
    };
    const agent = {
        bot,
        prompter: { getInitModes: () => null },
        isIdle: () => true,
        openChat: () => {},
        actions: { currentActionLabel: '', runAction: async (l, fn) => { try { await fn(); } catch (_) {} return { message: '' }; }, stop: async () => {} },
        self_prompter: { isActive: () => false, isStopped: () => true, isPaused: () => false, stopLoop() {}, start() {}, prompt: '' },
    };
    return { agent, bot };
}

async function runHunger(agent) {
    const lines = [];
    const real = console.log;
    console.log = (...a) => { lines.push(a.map(String).join(' ')); };
    try {
        initModes(agent);
        const hunger = getMode('hunger');
        hunger.active = false;
        hunger.hungry_since = Date.now() - 20000;
        hunger.next_try = 0;
        hunger.next_stock_food = 0;
        await hunger.update(agent);
        for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));
        return lines;
    } finally { console.log = real; }
}

test('night, food 6, nothing edible: the urgent trip runs and stays LOCAL', async () => {
    clearShelter(); setActiveHome(emptyHome());
    const { agent } = mkAgent({ food: 6, health: 20, timeOfDay: 18000 });
    const lines = await runHunger(agent);
    assert.ok(lines.some(l => l.includes('hungry and no food')), `the urgent trip ran; logs: ${lines.join(' | ')}`);
    assert.ok(lines.some(l => l.includes('local search only')), 'and it is local (relocate:false)');
    assert.equal(lines.some(l => l.includes('fresh search ring')), false, 'no far relocation');
});

test('daytime, food 17, nothing edible: the daytime trip is unaffected', async () => {
    clearShelter(); setActiveHome(emptyHome());
    const { agent } = mkAgent({ food: 17, health: 20, timeOfDay: 6000 });
    const lines = await runHunger(agent);
    assert.ok(lines.some(l => l.includes('no food, food/health below target')), `the daytime trip ran; logs: ${lines.join(' | ')}`);
});

// [ai-player] 2026-11-01 (item 2) - with nothing edible and food < 18 or health < 20, go and get food in the
// daytime with a wider hunt/forage search, on a cooldown. Eating from the inventory stays first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initModes, getMode } from '../src/agent/modes.js';
import { emptyHome, setActiveHome } from '../src/agent/library/bob_home.js';
import { clearShelter } from '../src/agent/library/shelter_state.js';
import { foodStockEnabled } from '../src/agent/library/survival.js';

const FOOD_REASON = 'no food, food/health below target';

function mkAgent({ food = 17, health = 20, timeOfDay = 6000, items = [] } = {}) {
    const state = { consumed: 0 };
    const errors = [];
    const inv = [...items];
    const bot = {
        food, health, output: '', entities: {},
        registry: { foodsByName: { bread: { foodPoints: 5 } } },
        inventory: {
            items: () => inv,
            findInventoryItem: (n) => { const i = inv.find(x => x.name === n); return i ? { ...i } : undefined; },
            get slots() { return []; },
        },
        equip: async () => {}, consume: async () => { state.consumed += 1; }, toss: async () => {},
        entity: {
            position: {
                x: 0, y: 64, z: 0,
                distanceTo: (o) => Math.hypot(0 - o.x, 64 - o.y, 0 - o.z),
                clone() { return this; },
                floored() { return this; },
            },
        },
        autoEat: { isEating: false, options: {} },
        time: { timeOfDay },
        nearestEntity: () => null,
        findBlocks: () => [],
        blockAt: () => null,
        modes: { flushBehaviorLog: () => '' },
        pathfinder: { stop() {} },
    };
    const agent = {
        bot,
        prompter: { getInitModes: () => null },
        isIdle: () => true,
        openChat: () => {},
        actions: {
            currentActionLabel: '',
            // mirrors the real ActionManager: an action error is caught, not thrown into the mode
            runAction: async (l, fn) => { try { await fn(); } catch (e) { errors.push(String((e && e.message) || e)); } return { message: '' }; },
            stop: async () => {},
        },
        self_prompter: { isActive: () => false, isStopped: () => true, isPaused: () => false, stopLoop() {}, start() {}, prompt: '' },
    };
    return { agent, bot, state, errors };
}

// Run the hunger mode `ticks` times and return the log lines it produced. BOB_FOOD_STOCK is read from
// process.env by the mode (as in production), so it is set around the run and restored afterwards.
async function runHunger(agent, { env = {}, ticks = 1 } = {}) {
    const saved = process.env.BOB_FOOD_STOCK;
    if (env.BOB_FOOD_STOCK === undefined) delete process.env.BOB_FOOD_STOCK;
    else process.env.BOB_FOOD_STOCK = env.BOB_FOOD_STOCK;
    const lines = [];
    const real = console.log;
    console.log = (...a) => { lines.push(a.map(String).join(' ')); };
    try {
        initModes(agent);
        const hunger = getMode('hunger');
        hunger.active = false;
        hunger.hungry_since = Date.now() - 20000; // past the mode's 15 s "let auto-eat try first" window
        hunger.next_stock_food = 0;
        for (let t = 0; t < ticks; t++) {
            await hunger.update(agent);
            for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));
        }
        return { lines, hunger };
    } finally {
        console.log = real;
        if (saved === undefined) delete process.env.BOB_FOOD_STOCK;
        else process.env.BOB_FOOD_STOCK = saved;
    }
}

test('food 17 with nothing edible in the daytime goes to get food', async () => {
    clearShelter(); setActiveHome(emptyHome());
    const { agent, errors } = mkAgent();
    const { lines } = await runHunger(agent);
    assert.ok(lines.some(l => l.includes(FOOD_REASON)), `expected the new food trip; logs: ${lines.join(' | ')}`);
    assert.deepEqual(errors, [], 'and getFood ran to completion');
});

test('at night he does not go for food (the old food <= 12 gate still applies)', async () => {
    const { agent } = mkAgent({ timeOfDay: 18000 });
    const { lines } = await runHunger(agent);
    assert.equal(lines.some(l => l.includes(FOOD_REASON)), false, 'the new trip is daytime only');
});

test('food in the inventory keeps eating first: no food trip, and he eats when hurt', async () => {
    const a = mkAgent({ items: [{ name: 'bread', count: 2 }] });
    const r1 = await runHunger(a.agent);
    assert.equal(r1.lines.some(l => l.includes(FOOD_REASON)), false, 'food in hand: no trip');

    const b = mkAgent({ food: 12, health: 12, items: [{ name: 'bread', count: 2 }] });
    const r2 = await runHunger(b.agent);
    assert.equal(b.state.consumed, 1, 'hurt with food in hand: he eats from the inventory');
    assert.equal(r2.lines.some(l => l.includes(FOOD_REASON)), false, 'and still no trip');
});

test('health under 20 with nothing edible also triggers the trip', async () => {
    const { agent } = mkAgent({ food: 19, health: 15 });
    const { lines } = await runHunger(agent);
    assert.ok(lines.some(l => l.includes(FOOD_REASON)), 'health < 20 is enough on its own');
});

test('full health and food >= 18 with nothing edible does not trigger it', async () => {
    const { agent } = mkAgent({ food: 18, health: 20 });
    const { lines } = await runHunger(agent);
    assert.equal(lines.some(l => l.includes(FOOD_REASON)), false);
});

test('BOB_FOOD_STOCK=0 opts out', async () => {
    assert.equal(foodStockEnabled({}), true);
    assert.equal(foodStockEnabled({ BOB_FOOD_STOCK: '1' }), true);
    assert.equal(foodStockEnabled({ BOB_FOOD_STOCK: '0' }), false);
    const { agent } = mkAgent();
    const { lines } = await runHunger(agent, { env: { BOB_FOOD_STOCK: '0' } });
    assert.equal(lines.some(l => l.includes(FOOD_REASON)), false, 'the opt-out disables the trip');
});

test('the food trip is on a cooldown', async () => {
    const { agent } = mkAgent();
    const { lines, hunger } = await runHunger(agent, { ticks: 3 });
    assert.equal(lines.filter(l => l.includes(FOOD_REASON)).length, 1, 'only one trip inside the cooldown');
    assert.ok(hunger.next_stock_food > Date.now(), 'and the cooldown is armed');
});

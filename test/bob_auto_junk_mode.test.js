// [ai-player] Fix 4 review - run the auto_junk mode's update() for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyHome, setActiveHome } from '../src/agent/library/bob_home.js';
import { getMode } from '../src/agent/modes.js';

const pos = (x, y, z) => ({ x, y, z, distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z) });

// the mode fires execute() without awaiting it; let the queued work settle
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };

function makeAgent(position) {
    const tossed = [];
    const inv = [{ name: 'clay_ball', count: 40, type: 1 }];
    const bot = {
        output: '',
        entity: { position },
        time: { timeOfDay: 6000 },
        registry: { foodsByName: {} },
        inventory: {
            items: () => inv,
            emptySlotCount: () => 2,
            findInventoryItem: (n) => { const i = inv.find(x => x.name === n); return i ? { ...i } : undefined; },
        },
        toss: async (type, _n, n) => { tossed.push([type, n]); },
        modes: { flushBehaviorLog: () => '' },
        pathfinder: { stop() {} },
    };
    const agent = {
        bot,
        isIdle: () => true,
        self_prompter: { isActive: () => false },
        actions: {
            currentActionLabel: '',
            resume_func: null,
            runAction: async (label, fn) => { await fn(); return { message: '' }; },
            stop: async () => {},
        },
    };
    return { agent, tossed, bot };
}

test('the auto_junk mode runs autoJunk and discards junk when idle, in daylight, away from home', async () => {
    setActiveHome(emptyHome());
    const mode = getMode('auto_junk');
    assert.ok(mode, 'the auto_junk mode exists');
    mode.active = false; mode.holding = false; mode.next_try = 0;
    const { agent, tossed, bot } = makeAgent(pos(200, 64, 200));
    await mode.update(agent);
    await settle();
    assert.deepEqual(tossed, [[1, 8]], 'the excess clay_ball was tossed');
    assert.match(bot.output, /Cleared junk: clay_ball/);
});

test('the auto_junk mode refuses near the claim centre / bed', async () => {
    setActiveHome(emptyHome());
    const mode = getMode('auto_junk');
    mode.active = false; mode.holding = false; mode.next_try = 0;
    const { agent, tossed } = makeAgent(pos(-1144, 68, 752));
    await mode.update(agent);
    await settle();
    assert.deepEqual(tossed, [], 'no junk dropped at the claim centre/bed');
});


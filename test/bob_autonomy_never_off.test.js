// [ai-player] 2026-11-01 - autonomy never stays off: a model stop is ignored, a player's stop is a pause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SelfPrompter } from '../src/agent/self_prompter.js';
import { getCommand } from '../src/agent/commands/index.js';
import { getMode, initModes, releaseNightHold } from '../src/agent/modes.js';
import { emptyHome, setActiveHome } from '../src/agent/library/bob_home.js';
import { clearShelter } from '../src/agent/library/shelter_state.js';
import { DEFAULT_SURVIVAL_GOAL, autonomyEnabled, playerStopMs } from '../src/agent/library/autonomy.js';
import convoManager from '../src/agent/conversation.js';
import fs from 'node:fs';

// A SelfPrompter whose loop is stubbed: these tests drive the state machine, not the model.
// `shutUp` mirrors agent.shutUp() (the real one is asserted against its source below).
function mkAgent({ idle = true, blocked = false, env = {} } = {}) {
    const agent = {
        idle,
        isIdle: () => agent.idle,
        autonomyBlocked: () => blocked,
        openChat: () => {},
        shutUp: (by = 'player') => {
            agent.shut_up = true;
            if (agent.self_prompter.isActive()) agent.self_prompter.stop(false, by);
        },
        actions: { stop: async () => {}, currentActionLabel: '' },
        self_prompter: null,
    };
    const sp = new SelfPrompter(agent, { env });
    sp.startLoop = () => { sp.loop_active = false; };
    agent.self_prompter = sp;
    convoManager.initAgent(agent); // so shutUp() -> endAllConversations() has an agent
    return { agent, sp };
}

test('agent.shutUp passes the stop source through to the self-prompter', () => {
    const src = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    assert.match(src, /shutUp\(by = 'player'\)/, 'shutUp takes the stop source');
    assert.match(src, /this\.self_prompter\.stop\(false, by\)/, 'and records it on the self-prompter');
    assert.match(src, /_commandSelfPrompt = self_prompt/, 'the model turn is marked before executeCommand');
    assert.match(src, /_commandSelfPrompt = false/, 'a player command is marked as not a model turn');
    assert.match(src, /this\.self_prompter\.handleLoad\(null, save_data\?\.self_prompting_state/, 'boot restores a saved stop');
    assert.match(src, /autonomyBlocked\(\)/, 'the watchdog can ask what is blocking');
});

test('the autonomy flag is ON by default and BOB_AUTONOMY=0 opts out', () => {
    assert.equal(autonomyEnabled({}), true);
    assert.equal(autonomyEnabled({ BOB_AUTONOMY: '1' }), true);
    assert.equal(autonomyEnabled({ BOB_AUTONOMY: '0' }), false);
    assert.equal(playerStopMs({}), 30000, 'a player stop holds 30 s by default');
    assert.equal(playerStopMs({ BOB_PLAYER_STOP_SEC: '5' }), 5000, 'BOB_PLAYER_STOP_SEC is honoured');
    assert.equal(playerStopMs({ BOB_PLAYER_STOP_SEC: 'nonsense' }), 30000, 'a bad value falls back to 30 s');
});

test("a model-sent !stfu is ignored; a player's still stops him", async () => {
    const { agent, sp } = mkAgent();
    sp.start('mine stone');
    const stfu = getCommand('!stfu');
    assert.ok(stfu, '!stfu exists');

    agent._commandSelfPrompt = true; // the model, during a self-prompt or system turn
    const note = await stfu.perform(agent);
    assert.match(String(note), /ignored/, 'the model is told the stop is ignored');
    assert.equal(sp.isActive(), true, 'autonomy is still active');
    assert.notEqual(agent.shut_up, true, 'he was not silenced');

    agent._commandSelfPrompt = false; // a player's direct command
    await stfu.perform(agent);
    assert.equal(sp.isStopped(), true, "a player's !stfu still stops him");
    assert.equal(sp.stopped_by, 'player');
    assert.equal(agent.shut_up, true, 'and silences his chat');
});

test("a model-sent !endGoal is ignored; a player's still stops him", async () => {
    const { agent, sp } = mkAgent();
    sp.start('mine stone');
    const endGoal = getCommand('!endGoal');

    agent._commandSelfPrompt = true;
    const note = await endGoal.perform(agent);
    assert.match(String(note), /ignored/);
    assert.equal(sp.isActive(), true, 'autonomy is still active');

    agent._commandSelfPrompt = false;
    await endGoal.perform(agent);
    assert.equal(sp.isStopped(), true);
    assert.equal(sp.stopped_by, 'player');
});

test('the idle watchdog restarts a model stop after ~2 min, and only when he is idle and free', async () => {
    const { agent, sp } = mkAgent();
    sp.start('mine stone');
    await sp.stop(false, 'model');
    assert.equal(sp.stopped_by, 'model');

    sp.update(60000);
    assert.equal(sp.isStopped(), true, 'not yet: it needs about 2 minutes');
    sp.update(60000);
    assert.equal(sp.isActive(), true, 'the watchdog restarted him');
    assert.equal(sp.prompt, 'mine stone', 'and resumed the saved goal');

    // busy: a conversation or a night hold blocks it
    const busy = mkAgent({ blocked: true });
    busy.sp.start('x');
    await busy.sp.stop(false, 'model');
    busy.sp.update(60000); busy.sp.update(60000); busy.sp.update(60000);
    assert.equal(busy.sp.isStopped(), true, 'a conversation or night hold blocks the watchdog');

    // not idle: nothing is running, so he is not stuck
    const working = mkAgent({ idle: false });
    working.sp.start('x');
    await working.sp.stop(false, 'model');
    working.sp.update(60000); working.sp.update(60000); working.sp.update(60000);
    assert.equal(working.sp.isStopped(), true, 'a busy Bob is not restarted under his own action');
});

test('boot: a legacy STOPPED (no stopped_by) counts as a model stop and starts right away', async () => {
    const { sp } = mkAgent();
    await sp.handleLoad(null, 0);
    assert.equal(sp.isActive(), true, 'boot does not leave him stopped');
    assert.equal(sp.prompt, DEFAULT_SURVIVAL_GOAL, 'with no saved goal the default survival goal is used');
    // The mapping itself: with autonomy off there is no auto-start, so the stop record stays visible.
    const off = mkAgent({ env: { BOB_AUTONOMY: '0' } });
    await off.sp.handleLoad(null, 0);
    assert.equal(off.sp.stopped_by, 'model', 'a legacy save has no stopped_by, so it counts as a model stop');
    assert.equal(off.sp.isStopped(), true);
});

test('a player stop holds for BOB_PLAYER_STOP_SEC, then resumes', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const { sp } = mkAgent();
    sp.start('mine stone');
    return sp.stop(false, 'player').then(() => {
        assert.equal(sp.stopped_by, 'player');
        assert.equal(sp.canAutoRestart(), false, 'holding right after the stop');
        t.mock.timers.tick(29000);
        sp.update(1000);
        assert.equal(sp.isStopped(), true, 'still paused at 29 s');
        t.mock.timers.tick(1000);
        sp.update(1000);
        assert.equal(sp.isActive(), true, 'resumed at 30 s - the pause, not the 2-minute watchdog');
        assert.equal(sp.prompt, 'mine stone', 'the saved goal is resumed');
    });
});

test('BOB_PLAYER_STOP_SEC=5 is respected', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const { sp } = mkAgent({ env: { BOB_PLAYER_STOP_SEC: '5' } });
    sp.start('x');
    return sp.stop(false, 'player').then(() => {
        t.mock.timers.tick(4999);
        sp.update(1);
        assert.equal(sp.isStopped(), true, 'still paused just before 5 s');
        t.mock.timers.tick(1);
        sp.update(1);
        assert.equal(sp.isActive(), true, 'resumed at 5 s');
    });
});

test('the watchdog, the night release and the respawn handler do not resume him during the pause', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const { agent, sp } = mkAgent();
    agent.bot = { modes: null };
    agent.prompter = { getInitModes: () => null };
    initModes(agent);
    sp.start('mine stone');
    await sp.stop(false, 'player');

    sp.update(60000); sp.update(60000); sp.update(60000);
    assert.equal(sp.isStopped(), true, 'the 2-minute watchdog does not resume him early');

    const night = getMode('night');
    night.release(agent, 'death');
    assert.equal(sp.isStopped(), true, 'release() does not resume him early');
    releaseNightHold('respawn');
    assert.equal(sp.isStopped(), true, 'the death/respawn handler does not resume him early');

    t.mock.timers.tick(30000);
    night.release(agent, 'morning');
    assert.equal(sp.isActive(), true, 'once the pause has passed, release() resumes him');
});

test("a player's new !goal resumes him immediately, inside the pause", (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const { agent, sp } = mkAgent();
    sp.start('mine stone');
    return sp.stop(false, 'player').then(async () => {
        t.mock.timers.tick(1000); // 1 s into the pause
        await getCommand('!goal').perform(agent, 'build a wall');
        assert.equal(sp.isActive(), true, 'a new goal wins over the pause');
        assert.equal(sp.prompt, 'build a wall');
        assert.equal(sp.stopped_by, null, 'the stop record is cleared');
    });
});

test('boot: a player pause that already passed starts right away', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 60000 });
    const { sp } = mkAgent();
    await sp.handleLoad(null, 0, 'player', 1000); // stopped 59 s ago
    assert.equal(sp.isActive(), true, 'the pause was over while he was down');
    assert.equal(sp.prompt, DEFAULT_SURVIVAL_GOAL);
});

test('boot: a player pause still running waits, then resumes when it ends', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 5000 });
    const { sp } = mkAgent();
    await sp.handleLoad(null, 0, 'player', 1000); // 4 s into a 30 s pause
    assert.equal(sp.isStopped(), true, 'still paused at boot');
    assert.equal(sp.stopped_at, 1000, 'stopped_at is kept across the restart');
    t.mock.timers.tick(26000); // 30 s after the stop at 1000
    sp.update(1000);
    assert.equal(sp.isActive(), true, 'resumed as soon as the pause ended');
});

test('BOB_AUTONOMY=0 keeps the old behaviour: the model may stop him and the stop sticks', async () => {
    const { agent, sp } = mkAgent({ env: { BOB_AUTONOMY: '0' } });
    // The command gate reads process.env (as it does in production); the prompter reads its injected env.
    const saved = process.env.BOB_AUTONOMY;
    process.env.BOB_AUTONOMY = '0';
    try {
        sp.start('mine stone');
        agent._commandSelfPrompt = true;
        const note = await getCommand('!stfu').perform(agent);
        assert.equal(note, undefined, 'the model stop is not ignored');
        assert.equal(sp.isStopped(), true);
        assert.equal(sp.stopped_by, 'model', 'recorded as a model stop');
        sp.update(60000); sp.update(60000); sp.update(60000);
        assert.equal(sp.isStopped(), true, 'the watchdog is off, so the stop sticks');
    } finally {
        if (saved === undefined) delete process.env.BOB_AUTONOMY;
        else process.env.BOB_AUTONOMY = saved;
    }
});

// The hunger mode needs: food < 18, health < 20 and something edible. `inventory.slots` is read only by
// world.getInventoryCounts (i.e. only by cookRaw), which is how the eat path is observed.
function mkHungerAgent() {
    const state = { consumed: 0 };
    const inv = [{ name: 'bread', count: 3, type: 1 }];
    const bot = {
        food: 12, health: 12, output: '',
        registry: { foodsByName: { bread: { foodPoints: 5 } } },
        inventory: {
            items: () => inv,
            findInventoryItem: (n) => { const i = inv.find(x => x.name === n); return i ? { ...i } : undefined; },
            get slots() { return []; },
        },
        equip: async () => {}, consume: async () => { state.consumed += 1; }, toss: async () => {},
        entity: { position: { x: 0, y: 64, z: 0, distanceTo: (o) => Math.hypot(0 - o.x, 64 - o.y, 0 - o.z) } },
        autoEat: { isEating: false, options: {} },
        time: { timeOfDay: 6000 },
        modes: { flushBehaviorLog: () => '' },
        pathfinder: { stop() {} },
    };
    const agent = {
        bot,
        prompter: { getInitModes: () => null },
        isIdle: () => true,
        autonomyBlocked: () => false,
        openChat: () => {},
        actions: { currentActionLabel: '', runAction: async (l, fn) => { await fn(); return { message: '' }; }, stop: async () => {} },
        self_prompter: null,
    };
    const sp = new SelfPrompter(agent, { env: {} });
    sp.startLoop = () => { sp.loop_active = false; };
    agent.self_prompter = sp;
    return { agent, bot, sp, state };
}

test('a player-stopped Bob still eats: survival modes run whatever the self-prompt state is', async () => {
    clearShelter();
    setActiveHome(emptyHome());
    const { agent, state } = mkHungerAgent();
    await agent.self_prompter.stop(false, 'player');
    assert.equal(agent.self_prompter.isStopped(), true, 'he is stopped');
    assert.equal(agent.self_prompter.stopped_by, 'player');
    initModes(agent);
    const hunger = getMode('hunger');
    hunger.active = false;
    hunger.hungry_since = Date.now() - 20000; // past the mode's 15 s "let auto-eat try first" window
    await hunger.update(agent);
    for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));
    assert.equal(state.consumed, 1, 'he ate while a player had stopped him');
    assert.equal(agent.self_prompter.isStopped(), true, 'and he is still stopped');
});

test('boot survives a saved state with no prompt (degrades to STOPPED instead of throwing)', async () => {
    // history.js saves self_prompt: '' for a paused empty goal, and an older save may have a state but no
    // prompt. A throw here happens inside the spawn handler, so it would abort boot.
    const { sp } = mkAgent();
    await assert.doesNotReject(() => sp.handleLoad(null, 2), 'a PAUSED state with no prompt must not throw');
    assert.equal(sp.isActive(), true, 'and it recovers with the default goal');
    assert.equal(sp.prompt, DEFAULT_SURVIVAL_GOAL);

    const off = mkAgent({ env: { BOB_AUTONOMY: '0' } });
    await assert.doesNotReject(() => off.sp.handleLoad(null, 1), 'nor an ACTIVE state with no prompt');
    assert.equal(off.sp.isStopped(), true, 'with autonomy off it stays stopped, but boot is not killed');
});

test('a resume un-silences him: shut_up clears when the pause ends, on the watchdog and on a new !goal', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const { agent, sp } = mkAgent();
    sp.start('mine stone');
    return sp.stop(false, 'player').then(async () => {
        agent.shut_up = true; // as agent.shutUp() leaves it
        t.mock.timers.tick(30000);
        sp.update(1000);
        assert.equal(sp.isActive(), true, 'the pause ended');
        assert.equal(agent.shut_up, false, 'and he is un-silenced, so he really resumes');

        // the idle watchdog (a model stop) un-silences him too
        const m = mkAgent();
        m.sp.start('x');
        await m.sp.stop(false, 'model');
        m.agent.shut_up = true;
        m.sp.update(60000); m.sp.update(60000);
        assert.equal(m.sp.isActive(), true, 'the watchdog resumed him');
        assert.equal(m.agent.shut_up, false, 'and cleared the silence');

        // a player's new !goal inside the pause clears it immediately
        sp.start('x');
        await sp.stop(false, 'player');
        agent.shut_up = true;
        await getCommand('!goal').perform(agent, 'build a wall');
        assert.equal(agent.shut_up, false, 'a new goal un-silences him');
        assert.equal(sp.isActive(), true);
    });
});


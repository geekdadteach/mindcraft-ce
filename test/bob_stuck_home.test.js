// stuck-home-20261026: trigger conditions, rate limit, fixed command, cheat lock, '/' chat filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { decide, DEFAULTS, DOOR, HOME_CMD, StuckHome, STUCK_HOME_NOTE, loadConfig } from '../src/agent/library/stuck_home.js';
import { installChatGuard, isSlashCommand, stripCommandPrefix, sendFixedHomeCommand } from '../src/agent/library/chat_guard.js';
import { ResetRecovery, readRequest } from '../src/agent/library/reset_recovery.js';

const T0 = 10_000_000;
const base = { dist: 15, fails: 0, goalActive: false, stalledMs: 0, lastAttemptMs: 0, lastDamageMs: -Infinity, combat: false, busy: false };

test('command string is fixed', () => {
    assert.equal(HOME_CMD, '/home house');
    const src = fs.readFileSync(new URL('../src/agent/library/stuck_home.js', import.meta.url), 'utf8');
    assert.ok(!/bot\.chat\(/.test(src), 'stuck_home never calls bot.chat');
    assert.equal(sendFixedHomeCommand.length, 1, 'only the bot argument');
});

test('trigger conditions', () => {
    assert.equal(decide({ ...base, fails: 2 }, T0).go, false);
    assert.equal(decide({ ...base, fails: 3 }, T0).go, true);
    assert.equal(decide({ ...base, goalActive: true, stalledMs: 119_000 }, T0).go, false);
    assert.equal(decide({ ...base, goalActive: true, stalledMs: 120_000 }, T0).go, true);
    assert.equal(decide({ ...base, goalActive: false, stalledMs: 600_000 }, T0).go, false, 'no home goal');
    assert.match(decide({ ...base, fails: 3, dist: 65 }, T0).why, /> 64/);
    assert.equal(decide({ ...base, fails: 3, dist: 63.9 }, T0).go, true);
    assert.match(decide({ ...base, fails: 3, dist: 2 }, T0).why, /already at the door/);
    assert.match(decide({ ...base, fails: 3, combat: true }, T0).why, /combat/);
    assert.match(decide({ ...base, fails: 3, lastDamageMs: T0 - 5000 }, T0).why, /damage/);
    assert.equal(decide({ ...base, fails: 3, lastDamageMs: T0 - 16000 }, T0).go, true);
    assert.match(decide({ ...base, fails: 3, busy: true }, T0).why, /already/);
    assert.equal(decide({ ...base, dist: null, fails: 9 }, T0).go, false);
    assert.equal(decide({ ...base }, T0).go, false, 'not stuck');
});

test('rate limit: 10 min, force 35 s, manual still needs radius/combat', () => {
    const last = { ...base, fails: 3, lastAttemptMs: T0 - 599_000 };
    assert.match(decide(last, T0).why, /backoff/);
    assert.equal(decide({ ...last, lastAttemptMs: T0 - 600_000 }, T0).go, true);
    assert.match(decide({ ...base, manual: true, lastAttemptMs: T0 - 60_000 }, T0).why, /backoff/, 'manual respects 10 min');
    assert.equal(decide({ ...base, manual: true, force: true, lastAttemptMs: T0 - 60_000 }, T0).go, true);
    assert.match(decide({ ...base, manual: true, force: true, lastAttemptMs: T0 - 20_000 }, T0).why, /backoff/, 'force respects Essentials 30 s cooldown');
    assert.equal(decide({ ...base, manual: true, force: true, dist: 100 }, T0).go, false);
    assert.equal(decide({ ...base, manual: true, force: true, combat: true }, T0).go, false);
});

function rig({ teleportTo = DOOR, chat = null, auto = true } = {}) { // pr20-reconciled: auto opt-in for trigger tests
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
    let t = T0;
    const bot = new EventEmitter();
    bot.entity = { position: { x: -807, y: 118, z: 576 } };
    bot.health = 20;
    bot.pathfinder = { stop() {}, setGoal() {} }; bot.clearControlStates = () => {};
    const rec = { sent: [], notes: [], lessons: [], stops: 0, resets: [] };
    const agent = { name: 'MineBobNE', bot, actions: { currentActionLabel: 'mode:night', executing: false, cancelResume() {}, async stop() { rec.stops++; } },
        resetRecovery: { detector: { setLastTrigger(x) { rec.suppressed = x; } }, async recordReset(r) { rec.resets.push(r); } } };
    const sh = new StuckHome(agent, { file: path.join(dir, 'stuck_home.json'), now: () => t, wait: async (ms) => { t += ms; },
        cfg: { ...DEFAULTS, warmupMs: 3500, auto },
        send: () => { rec.sent.push(HOME_CMD); if (chat) bot.emit('messagestr', chat); rec.sentAt = t; if (teleportTo) setTimeout0(); } });
    // move Bob once the warmup has passed (simulated clock)
    const setTimeout0 = () => { const at = t + 3000; const orig = sh.wait; sh.wait = async (ms) => { t += ms; if (t >= at) bot.entity.position = { ...teleportTo, z: teleportTo.z + 1 }; }; };
    return { dir, bot, agent, sh, rec, clock: { get: () => t, add: (ms) => { t += ms; } } };
}

test('3 failed walk-home attempts -> one /home house, note+lesson via recordReset, persisted backoff', async () => {
    const r = rig();
    assert.equal(r.sh.reportHomeAttempt(false, 'home-route'), null);
    assert.equal(r.sh.reportHomeAttempt(false, 'home-route'), null);
    const res = await r.sh.reportHomeAttempt(false, 'goToRememberedPlace');
    assert.match(res, /teleported home/);
    assert.deepEqual(r.rec.sent, ['/home house']);
    assert.equal(r.rec.stops >= 1, true, 'action stopped before sending');
    assert.equal(r.rec.resets.length, 1);
    assert.equal(r.rec.resets[0].reason, 'stuck-home');
    assert.equal(r.rec.resets[0].note, STUCK_HOME_NOTE);
    assert.equal(r.rec.resets[0].action, 'mode:night');
    assert.ok(r.rec.suppressed, '20-block detector suppressed');
    assert.equal(r.sh.fails, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(r.dir, 'stuck_home.json'), 'utf8'));
    assert.equal(saved.last_result, 'ok');
    // a new process (restart) still honours the 10-min backoff
    r.bot.entity.position = { x: -807, y: 118, z: 576 };
    const sh2 = new StuckHome(r.agent, { file: path.join(r.dir, 'stuck_home.json'), now: r.clock.get, send: () => assert.fail('must not send') });
    sh2.fails = 3;
    assert.equal(sh2.maybeTrigger(), null);
    assert.match(await sh2.request({}), /backoff/);
    fs.rmSync(r.dir, { recursive: true, force: true });
});

test('failure: no permission -> logged, no note, backoff kept', async () => {
    const r = rig({ teleportTo: null, chat: 'You do not have permission to use that command.' });
    const res = await r.sh.request({ by: 'test' });
    assert.match(res, /failed: .*permission/);
    assert.equal(r.rec.resets.length, 0);
    assert.match(r.sh.state.last_result, /^fail/);
    assert.match(await r.sh.request({ by: 'test' }), /backoff/);
    r.clock.add(36_000);
    assert.match(await r.sh.request({ by: 'test', force: true }), /failed/);
    fs.rmSync(r.dir, { recursive: true, force: true });
});

test('failure: position unchanged -> failed', async () => {
    const r = rig({ teleportTo: null });
    assert.match(await r.sh.request({}), /position did not change/);
    fs.rmSync(r.dir, { recursive: true, force: true });
});

test('no progress for 2 min with a home goal triggers; progress resets it', async () => {
    const r = rig();
    r.sh.markHomeGoal();
    r.clock.add(60_000); assert.equal(r.sh.tick(), null);
    r.bot.entity.position = { x: -810, y: 120, z: 572 }; // > 2 blocks closer
    assert.equal(r.sh.tick(), null);
    r.sh.markHomeGoal();
    r.clock.add(119_000); assert.equal(r.sh.tick(), null);
    r.clock.add(2_000);
    assert.match(await r.sh.tick(), /teleported/);
    fs.rmSync(r.dir, { recursive: true, force: true });
});

test('damage in the last 15 s blocks the trigger', () => {
    const r = rig();
    r.sh.tick(); r.bot.health = 18; r.sh.tick();
    r.sh.fails = 3;
    assert.equal(r.sh.maybeTrigger(), null);
    assert.deepEqual(r.rec.sent, []);
    fs.rmSync(r.dir, { recursive: true, force: true });
});

test('own stop() interrupting a walk is not counted', () => {
    const r = rig(); r.sh.holding = true;
    r.sh.reportHomeAttempt(false, 'home-route');
    assert.equal(r.sh.fails, 0);
});

test('warmup config: env overrides, clamped', () => {
    assert.equal(loadConfig({}, '/nonexistent').warmupMs, 3500);
    assert.equal(loadConfig({ BOB_STUCK_HOME_WARMUP_MS: '0' }, '/nonexistent').warmupMs, 0);
    assert.equal(loadConfig({ BOB_STUCK_HOME_WARMUP_MS: '99999' }, '/nonexistent').warmupMs, 15000);
});

test("chat guard: '/' lines never leave, fixed command does", () => {
    const sent = [];
    const bot = { _client: { chat: (m) => sent.push(m) } };
    bot.chat = (m) => { for (let i = 0; i < m.length; i += 256) bot._client.chat(m.slice(i, i + 256)); }; // mineflayer-like splitter
    assert.equal(installChatGuard(bot, () => {}), true);
    bot.chat('/op MineBobNE'); bot.chat('  /gamemode creative'); bot.chat('\u200b/tp @s 0 0 0');
    bot._client.chat('/give MineBobNE diamond 64');
    bot.chat('x'.repeat(256) + '/home house');            // 2nd chunk would start with '/'
    bot.chat('hello there');
    assert.deepEqual(sent, ['x'.repeat(256), 'hello there']);
    assert.equal(sendFixedHomeCommand(bot), '/home house');
    assert.deepEqual(sent.slice(-1), ['/home house']);
    assert.throws(() => sendFixedHomeCommand({ _client: { chat() {} } }), /not installed/);
    assert.ok(isSlashCommand(' /x') && !isSlashCommand('a /x'));
    assert.equal(stripCommandPrefix('//home house'), 'home house');
    assert.equal(stripCommandPrefix(' \u200b / /tp me'), 'tp me');
    assert.equal(stripCommandPrefix('hi /tp'), 'hi /tp');
});

test('inbox kind tphome is accepted and routed; force via reason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shi-'));
    const f = path.join(dir, 'a.json');
    fs.writeFileSync(f, JSON.stringify({ v: 1, kind: 'tphome', reason: 'force', by: 'discord', ts: 1 }), { mode: 0o600 });
    const req = readRequest(f);
    assert.equal(req.kind, 'tphome');
    const calls = [];
    const rr = new ResetRecovery({ stuckHome: { request: async (o) => { calls.push(o); return 'ok'; } } }, { inboxDir: dir });
    assert.equal(await rr.handle(req), 'ok');
    assert.deepEqual(calls, [{ force: true, by: 'discord' }]);
    assert.match(await new ResetRecovery({}, { inboxDir: dir }).handle(req), /not installed/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('cheat mode cannot be enabled (profile, setOn, assignment, !setMode)', async () => {
    const src = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    assert.match(src, /get on\(\) \{ return false; \}/);
    let modes;
    modes = await import('../src/agent/modes.js');
    {
        const agent = { bot: {}, prompter: { getInitModes: () => ({ cheat: true }) } };
        modes.initModes(agent);
        assert.equal(agent.bot.modes.isOn('cheat'), false, 'profile cheat:true ignored');
        assert.equal(agent.bot.modes.setOn('cheat', true), false);
        assert.equal(agent.bot.modes.isOn('cheat'), false);
        assert.equal(agent.bot.modes.getJson().cheat, false);
    }
    const { actionsList } = await import('../src/agent/commands/actions.js');
    const setMode = actionsList.find(a => a.name === '!setMode');
    const fakeAgent = { bot: { modes: (() => { const a = { bot: {}, prompter: { getInitModes: () => null } }; modes.initModes(a); return a.bot.modes; })() } };
    assert.match(await setMode.perform(fakeAgent, 'cheat', true), /locked off/);
    assert.equal(fakeAgent.bot.modes.isOn('cheat'), false);
    const acts = fs.readFileSync(new URL('../src/agent/commands/actions.js', import.meta.url), 'utf8');
    assert.match(acts, /if \(mode_name === 'cheat'\) return 'Mode cheat is locked off/);
    const prof = JSON.parse(fs.readFileSync(new URL('../profiles/andy-api-lite.json', import.meta.url), 'utf8'));
    assert.equal(prof.modes.cheat, false);
});

test('nodistance-20261026: radius null/0 = unlimited, other triggers kept', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-radius-'));
    const f = path.join(tmp, 'cfg.json');
    try {
        fs.writeFileSync(f, JSON.stringify({ radius: null }));
        const un = loadConfig({}, f);
        assert.equal(un.radius, null);
        fs.writeFileSync(f, JSON.stringify({ radius: 0, warmup_ms: 3000 }));
        assert.equal(loadConfig({}, f).radius, null);
        assert.equal(loadConfig({}, f).warmupMs, 3000);
        fs.writeFileSync(f, JSON.stringify({ radius: 100 }));
        assert.equal(loadConfig({}, f).radius, 100);
        fs.writeFileSync(f, JSON.stringify({ radius: -5 }));
        assert.equal(loadConfig({}, f).radius, 64, 'invalid keeps default');
        fs.writeFileSync(f, JSON.stringify({ warmup_ms: 3500 }));
        assert.equal(loadConfig({}, f).radius, 64, 'absent keeps default');
        assert.equal(loadConfig({}, '/nonexistent').radius, 64);
        for (const dist of [72, 500, 5000]) {
            assert.equal(decide({ ...base, fails: 3, dist }, T0, un).go, true, `unlimited at ${dist}`);
            assert.equal(decide({ ...base, manual: true, force: true, dist }, T0, un).go, true);
            assert.match(decide({ ...base, fails: 3, dist, lastAttemptMs: T0 - 599_000 }, T0, un).why, /backoff/, '10 min kept');
            assert.match(decide({ ...base, fails: 3, dist, combat: true }, T0, un).why, /combat/);
            assert.match(decide({ ...base, fails: 3, dist, lastDamageMs: T0 - 5000 }, T0, un).why, /damage/);
            assert.equal(decide({ ...base, dist }, T0, un).go, false, 'not stuck');
        }
        assert.match(decide({ ...base, fails: 3, dist: 2 }, T0, un).why, /already at the door/);
        assert.match(decide({ ...base, fails: 3, dist: 101 }, T0, { ...DEFAULTS, radius: 100 }).why, /> 100/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

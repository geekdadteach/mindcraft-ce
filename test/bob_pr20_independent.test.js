// pr20-reconciled-20261027: Bob explores independently; automatic home recovery is opt-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULTS, HOME_CMD, StuckHome, loadConfig } from '../src/agent/library/stuck_home.js';
import { exampleVerifiedHome, setActiveHome } from '../src/agent/library/bob_home.js';

const DOOR = exampleVerifiedHome().entrance;
function nearDoor({ dx = 12.5, dy = -6, dz = 10.5 } = {}) {
    return { x: DOOR.x + dx, y: DOOR.y + dy, z: DOOR.z + dz };
}

const T0 = 10_000_000;
function rig(cfg) {
    setActiveHome(exampleVerifiedHome());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr20-'));
    let t = T0;
    const bot = new EventEmitter();
    bot.entity = { position: nearDoor() };
    bot.health = 20;
    bot.pathfinder = { stop() {}, setGoal() {} }; bot.clearControlStates = () => {};
    const sent = [];
    const agent = { name: 'MineBobNE', bot, actions: { currentActionLabel: 'action:explore', executing: false, cancelResume() {}, async stop() {} },
        resetRecovery: { detector: { setLastTrigger() {} }, async recordReset() {} } };
    const sh = new StuckHome(agent, { file: path.join(dir, 'stuck_home.json'), now: () => t, wait: async (ms) => { t += ms; if (sent.length) bot.entity.position = { ...DOOR, z: DOOR.z + 1 }; },
        cfg: { ...DEFAULTS, warmupMs: 0, ...cfg }, send: () => sent.push(HOME_CMD) });
    return { dir, bot, sh, sent, add: (ms) => { t += ms; } };
}

test('automatic stuck-home teleport is off by default (config absent or no "auto")', () => {
    assert.equal(DEFAULTS.auto, false);
    assert.equal(loadConfig({}, '/nonexistent').auto, false);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr20-cfg-'));
    const f = path.join(tmp, 'cfg.json');
    try {
        fs.writeFileSync(f, JSON.stringify({ radius: null })); // the live run/stuck-home.config.json
        const c = loadConfig({}, f);
        assert.equal(c.auto, false); assert.equal(c.radius, null, 'nodistance kept');
        fs.writeFileSync(f, JSON.stringify({ radius: null, auto: true }));
        assert.equal(loadConfig({}, f).auto, true);
        assert.equal(loadConfig({ BOB_STUCK_HOME_AUTO: '0' }, f).auto, false, 'env 0 overrides file');
        assert.equal(loadConfig({ BOB_STUCK_HOME_AUTO: '1' }, '/nonexistent').auto, true);
        fs.writeFileSync(f, JSON.stringify({ auto: 'yes' }));
        assert.equal(loadConfig({}, f).auto, false, 'non-boolean ignored');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('auto off: 3 failed walk-home attempts and 2 min no progress do not teleport', async () => {
    const r = rig({});
    for (let i = 0; i < 5; i++) assert.equal(r.sh.reportHomeAttempt(false, 'goToRememberedPlace'), null);
    r.sh.markHomeGoal(); r.sh.tick(); r.add(200_000);
    assert.equal(r.sh.tick(), null);
    assert.deepEqual(r.sent, []);
    fs.rmSync(r.dir, { recursive: true, force: true });
});

test('auto off: manual operator request still teleports with its checks', async () => {
    const r = rig({ radius: null });
    assert.match(await r.sh.request({ by: 'test' }), /teleported/);
    assert.deepEqual(r.sent, [HOME_CMD]);
    fs.rmSync(r.dir, { recursive: true, force: true });
});

test('auto off: damage tracking in tick() still runs so manual requests keep the 15 s damage check', async () => {
    const r = rig({});
    r.sh.tick(); r.bot.health = 15; r.sh.tick();
    assert.match(await r.sh.request({ by: 'test' }), /damage/);
    fs.rmSync(r.dir, { recursive: true, force: true });
});

test('auto on (opt-in) restores the old trigger', async () => {
    const r = rig({ auto: true });
    r.sh.reportHomeAttempt(false, 'x'); r.sh.reportHomeAttempt(false, 'x');
    assert.match(await r.sh.reportHomeAttempt(false, 'x'), /teleported/);
    fs.rmSync(r.dir, { recursive: true, force: true });
});

test('night-home and unstuck walk-home are opt-in; unstuck ignores its own action', async () => {
    const m = await import('../src/agent/modes.js');
    assert.equal(m.nightHomeEnabled({}), false);
    assert.equal(m.nightHomeEnabled({ BOB_NIGHT_HOME: '1' }), true);
    assert.equal(m.unstuckWalkHomeEnabled({}), false);
    assert.equal(m.unstuckWalkHomeEnabled({ BOB_UNSTUCK_HOME: '1' }), true);
    const src = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    assert.match(src, /if \(agent\.actions\.currentActionLabel === 'mode:unstuck'\) \{/);
    assert.match(src, /if \(!this\.home_at_night\) \{/);
    assert.match(src, /if \(UNSTUCK_WALK_HOME && !where && home_d < 64/);
    assert.doesNotMatch(src, /if \(false &&/);
    // protection / survival paths still present
    for (const re of [/name: 'self_preservation'/, /name: 'self_defense'/, /name: 'hunger'/, /get on\(\) \{ return false; \}/, /stuckHome\?\.holding/])
        assert.match(src, re);
});

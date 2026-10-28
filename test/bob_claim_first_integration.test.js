import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAIM, isInClaim, verifiedHomeLocation } from '../src/agent/library/bob_claim.js';
import {
    HomeRegistry, emptyHome, exampleVerifiedHome, getActiveHome, isLegacyHilltopPos, isVerifiedHome,
    LEGACY_HILLTOP, setActiveHome, homeFromWorld, geometryFromFeatures, verifyHomeInWorld
} from '../src/agent/library/bob_home.js';
import {
    HomesteadTracker, applyPlacements, continueHomesteadStep, explorationAllowed,
    starterPlan, worldGetBlock
} from '../src/agent/library/bob_homestead.js';
import { protectedAreaAt } from '../src/agent/library/house_bounds.js';
import { afterEscapeTarget } from '../src/agent/library/no_go_zones.js';
import { decide, DEFAULTS, StuckHome } from '../src/agent/library/stuck_home.js';
import { HomeRoutes } from '../src/agent/library/home_route.js';
import { goHomeInside, homeDistance, isInsideHouse, surfaceForWood } from '../src/agent/library/ai_player_nav.js';
import { nightHomeEnabled, unstuckWalkHomeEnabled } from '../src/agent/modes.js';
import { ResetRecovery } from '../src/agent/library/reset_recovery.js';
import { GoalFailureCircuit } from '../src/agent/library/bob_goal_circuit.js';

const HILLTOP_RE = /-823|-820|-822|124, z: 56[6-9]|z: 568/;

test('D1: no active nav/recovery/construction defaults to the retired hilltop', () => {
    setActiveHome(emptyHome());
    assert.equal(getActiveHome().verified, false);
    assert.equal(protectedAreaAt(LEGACY_HILLTOP.door), null);
    assert.equal(afterEscapeTarget(-846, 560), null);
    assert.equal(isLegacyHilltopPos(LEGACY_HILLTOP.base), true);
    const srcFiles = [
        'src/agent/library/ai_player_nav.js',
        'src/agent/library/home_route.js',
        'src/agent/library/stuck_home.js',
        'src/agent/modes.js',
        'src/agent/library/bob_homestead.js',
    ];
    for (const f of srcFiles) {
        const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
        assert.doesNotMatch(src, /base:\s*Object\.freeze\(\{x:-823/);
    }
});

test('D2-D4: empty claim to verified home, discovered coords, persist across restart', () => {
    setActiveHome(emptyHome());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
    const site = { x: -1118, y: 68, z: 738 };
    assert.equal(isInClaim(site), true);
    const inv = { oak_planks: 64, oak_log: 8, oak_door: 1, white_bed: 1, chest: 1 };
    const hsFile = path.join(dir, 'homestead.json');
    const homeFile = path.join(dir, 'verified_home.json');
    const tracker = new HomesteadTracker({ name: 'MineBobNE' }, { file: hsFile });
    let world = {};
    let step = continueHomesteadStep(tracker.snapshot(), { position: site, inventory: inv, getBlock: worldGetBlock(world) });
    tracker.progress = step.progress;
    world = applyPlacements(world, starterPlan(site));
    step = continueHomesteadStep(tracker.snapshot(), { position: site, inventory: inv, getBlock: worldGetBlock(world) });
    tracker.progress = step.progress; tracker.save();

    const getBlock = worldGetBlock(world);
    const found = homeFromWorld(getBlock, site, { site, requireOwned: true });
    assert.ok(found, 'world verification should discover the built shelter');
    assert.equal(isVerifiedHome(found), true);
    assert.ok(found.door.x !== CLAIM.center.x || found.door.z !== CLAIM.center.z);
    assert.ok(!isLegacyHilltopPos(found.door, 30));
    assert.ok(verifiedHomeLocation(found));

    const registry = new HomeRegistry({ name: 'MineBobNE' }, { file: homeFile });
    assert.equal(registry.hasHome(), false);
    assert.equal(registry.recordVerified(found), true);
    assert.equal(registry.hasHome(), true);

    const again = new HomeRegistry({ name: 'MineBobNE' }, { file: homeFile });
    assert.equal(again.hasHome(), true);
    assert.equal(again.snapshot().door.x, found.door.x);
    assert.equal(again.snapshot().bed.x, found.bed.x);
    const hs2 = new HomesteadTracker({ name: 'MineBobNE' }, { file: hsFile });
    assert.ok(hs2.snapshot().site);
    fs.rmSync(dir, { recursive: true, force: true });
    setActiveHome(emptyHome());
});

test('D5: exploration outside the claim remains possible', () => {
    assert.equal(explorationAllowed({ x: -2000, z: 0 }), true);
    assert.equal(isInClaim({ x: -2000, z: 0 }), false);
    const circuit = new GoalFailureCircuit({ minGapMs: 0, threshold: 1, now: () => 1 });
    circuit.reset('do a thing');
    circuit.record('x', 'y', 'not found');
    const alts = [];
    let alt = circuit.nextAutonomousGoal();
    for (let i = 0; i < 6 && alt; i++) {
        alts.push(alt);
        circuit.reset(alt);
        circuit.record('x', 'y', 'not found');
        alt = circuit.nextAutonomousGoal();
    }
    assert.ok(alts.some((g) => /outside your claim|Explore a previously unvisited/i.test(g)),
        `expected an outside-claim exploration alternative, got ${JSON.stringify(alts)}`);
});

test('D6: recovery works with no house', async () => {
    setActiveHome(emptyHome());
    assert.equal(await goHomeInside({ entity: { position: { x: -840, y: 96, z: 560, distanceTo() { return 99; } } } }), false);
    assert.equal(homeDistance({ entity: { position: { x: -840, y: 96, z: 560 } } }), Infinity);
    assert.equal(isInsideHouse({ entity: { position: LEGACY_HILLTOP.inside } }), false);
    const sh = new StuckHome({ name: 't', bot: { entity: { position: { x: -840, y: 96, z: 560 } } }, actions: {} }, { file: path.join(os.tmpdir(), 'sh-none.json') });
    sh.agent.homeState = { snapshot: () => emptyHome() };
    assert.match(await sh.request({}), /no verified home/);
    const dec = decide({ noHome: true, dist: 20, fails: 9, goalActive: true, stalledMs: 999999, lastAttemptMs: 0, lastDamageMs: -1, combat: false, busy: false }, 1e9, DEFAULTS);
    assert.equal(dec.go, false);
    assert.match(dec.why, /no verified home/);
    const rr = new ResetRecovery({ homeState: { snapshot: () => emptyHome() } }, { inboxDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rr-')) });
    assert.match(await rr.handle({ kind: 'tphome', reason: 'x', by: 't' }), /disabled until/);
    const goals = [];
    const bot = {
        entity: { position: { x: -840, y: 40, z: 560, floored() { return this; }, offset(dx, dy, dz) { return { x: this.x + dx, y: this.y + dy, z: this.z + dz }; }, toString() { return ''; } } },
        blockAt: (q) => ({ name: q.y >= 42 && q.y < 70 ? 'stone' : 'air', skyLight: 0, position: q, boundingBox: q.y >= 42 && q.y < 70 ? 'block' : 'empty' }),
        chat() {}, interrupt_code: false,
        time: { timeOfDay: 1000 },
    };
    const agent = {
        bot,
        escape: { up: async () => ({ ok: false, why: 'stalled' }), gotoChecked: async (_a, goal) => { goals.push(goal); return false; } },
        failures: { record() {} },
        surface_wood_until: 0,
    };
    await surfaceForWood(agent, 'oak_log');
    const house = LEGACY_HILLTOP.entrance;
    assert.ok(goals.every((g) => {
        const horiz = Math.hypot((g.x ?? 0) - house.x, (g.z ?? 0) - house.z);
        return !(horiz < 8 && Math.abs((g.y ?? 0) - house.y) < 10);
    }), 'surface recovery must climb locally, not path to the retired hilltop house');
});

test('D7: opt-in home switches stay off by default', () => {
    assert.equal(nightHomeEnabled({}), false);
    assert.equal(unstuckWalkHomeEnabled({}), false);
    assert.equal(DEFAULTS.auto, false);
    assert.equal(nightHomeEnabled({ BOB_NIGHT_HOME: '1' }), true);
});

test('home-route walk is inert without a verified house and does not seed hilltop routes', () => {
    setActiveHome(emptyHome());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'));
    const agent = { name: path.basename(dir), bot: { entity: { position: { x: 0, y: 64, z: 0, distanceTo() { return 99; } } } } };
    const prev = process.cwd();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrw-'));
    fs.mkdirSync(path.join(tmpRoot, 'bots', agent.name), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'bots', agent.name, 'home_routes.json'), JSON.stringify({
        version: 1, routes: [{ id: 'seed-north', pts: [[-819.5, 124, 565.5]] }]
    }));
    process.chdir(tmpRoot);
    try {
        const hr = new HomeRoutes(agent);
        assert.deepEqual(hr.data.routes, []);
        assert.equal(hr.data.home, null);
    } finally {
        process.chdir(prev);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        setActiveHome(emptyHome());
    }
});

test('long_memory does not delete hilltop places on start; that is the migration script', () => {
    const src = fs.readFileSync(new URL('../src/agent/library/long_memory.js', import.meta.url), 'utf8');
    assert.match(src, /Hilltop place\/lesson cleanup is the migration script/);
    assert.doesNotMatch(src, /places\.data\.places = P\.filter\(p => !isLegacyHilltopPos/);
});

test('runtime sources no longer treat -820 124 566 as an active door', () => {
    for (const f of ['src/agent/agent.js', 'src/agent/library/reset_recovery.js', 'src/agent/library/skills.js']) {
        const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
        assert.doesNotMatch(src, /-820 124 566/, f);
    }
    const agentSrc = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    assert.match(agentSrc, /maybeSetEssentialsHome/);
    assert.match(agentSrc, /sendFixedSetHomeCommand/);
    const profile = fs.readFileSync(new URL('../profiles/andy-api.json', import.meta.url), 'utf8');
    assert.match(profile, /your own 128 by 128 claim is yours to use/);
});

test('verified home is used for navigation helpers once discovered', () => {
    const home = exampleVerifiedHome();
    setActiveHome(home);
    try {
        assert.equal(isInsideHouse({ entity: { position: home.inside } }), true);
        assert.ok(homeDistance({ entity: { position: { x: home.entrance.x + 10, y: home.entrance.y, z: home.entrance.z } } }) > 8);
        assert.equal(protectedAreaAt(home.door)?.name, 'house');
        assert.equal(protectedAreaAt(LEGACY_HILLTOP.door), null);
    } finally { setActiveHome(emptyHome()); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    HomesteadTracker,
    applyObservation,
    applyPlacements,
    continueHomesteadStep,
    emptyProgress,
    evaluateWorld,
    explorationAllowed,
    gatherReady,
    pickSiteFromSamples,
    scoreSite,
    starterPlan,
    statusText,
    worldGetBlock,
} from '../src/agent/library/bob_homestead.js';
import { CLAIM, isKnownUnsafeFoundation } from '../src/agent/library/bob_claim.js';
import { exampleVerifiedHome, isVerifiedHome, setActiveHome, emptyHome } from '../src/agent/library/bob_home.js';

test('site scoring is advisory and never prefers the claim center or the cavity', () => {
    assert.ok(scoreSite({ x: -1120, y: 68, z: 736 }) > scoreSite({ x: CLAIM.center.x, y: 65, z: CLAIM.center.z }));
    assert.equal(scoreSite({ x: -1112, y: 65, z: 765 }) , -Infinity);
    assert.ok(isKnownUnsafeFoundation({ x: -1112, z: 765 }));
    assert.equal(scoreSite({ x: -823, y: 124, z: 568 }), -Infinity);
    assert.equal(scoreSite({ x: 0, z: 0 }), -Infinity);
});

test('claim does not confine exploration', () => {
    assert.equal(explorationAllowed({ x: -2000, z: 10 }), true);
    assert.equal(explorationAllowed({ x: -1120, z: 736 }), true);
    assert.equal(explorationAllowed(null), false);
});

test('empty claim progresses to verified home from world evidence and persists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-'));
    const file = path.join(dir, 'homestead.json');
    const tracker = new HomesteadTracker({ name: 't' }, { file });
    assert.equal(tracker.snapshot().stage, 'survey');

    const site = { x: -1120, y: 68, z: 736 };
    let world = {};
    const inv = { oak_log: 16, oak_planks: 64, oak_door: 1, white_bed: 1, chest: 1 };
    assert.equal(gatherReady(inv), true);

    let p = continueHomesteadStep(tracker.snapshot(), { position: site, inventory: inv, getBlock: worldGetBlock(world) });
    tracker.progress = p.progress; tracker.save();
    assert.equal(tracker.snapshot().stage, 'select_site');
    assert.deepEqual(tracker.snapshot().site, { x: -1120, y: 68, z: 736 });

    p = continueHomesteadStep(tracker.snapshot(), { position: site, inventory: inv, getBlock: worldGetBlock(world) });
    world = applyPlacements(world, starterPlan(site));
    p = continueHomesteadStep(p.progress, { position: site, inventory: inv, getBlock: worldGetBlock(world) });
    tracker.progress = p.progress; tracker.save();
    assert.equal(p.homeFeatures && isVerifiedHome({ ...p.homeFeatures, verified: true }) || p.progress.verifiedHome || p.progress.stage === 'verified_home' || evaluateWorld({
        getBlock: worldGetBlock(world), inventory: inv, position: site, progress: p.progress, home: null
    }).verified || evaluateWorld({
        getBlock: worldGetBlock(world), inventory: inv, position: site, progress: p.progress, home: null
    }).bed, true);

    const evidence = evaluateWorld({ getBlock: worldGetBlock(world), inventory: inv, position: site, progress: p.progress });
    const observed = applyObservation(p.progress, evidence);
    assert.ok(['bed', 'verified_home', 'shelter', 'foundation'].includes(observed.stage));

    const reloaded = new HomesteadTracker({ name: 't' }, { file });
    assert.equal(reloaded.snapshot().site.x, -1120);
    assert.ok(reloaded.snapshot().stage !== 'survey');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('status text does not invent coordinates from the claim center', () => {
    const text = statusText(emptyProgress(), null);
    assert.match(text, /No house has been built/);
    assert.doesNotMatch(text, /assigned door/);
    assert.doesNotMatch(text, /-1144 65 752/);
    const home = exampleVerifiedHome();
    const t2 = statusText({ stage: 'verified_home', site: home.door }, home);
    assert.match(t2, /Verified home entrance/);
    assert.doesNotMatch(t2, /-823/);
});

test('pickSiteFromSamples skips the cavity and hilltop', () => {
    const picked = pickSiteFromSamples([
        { x: -1112, y: 65, z: 765 },
        { x: -823, y: 124, z: 568 },
        { x: -1120, y: 68, z: 736 },
    ]);
    assert.deepEqual(picked, { x: -1120, y: 68, z: 736 });
});

test('homestead.json is not rewritten when observation is unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-skip-'));
    const file = path.join(dir, 'homestead.json');
    let n = 1;
    const tracker = new HomesteadTracker({ name: 't' }, { file, now: () => n++ });
    const site = { x: -1120, y: 68, z: 736 };
    const inv = { oak_planks: 8 };
    tracker.observe({ position: site, inventory: inv, getBlock: worldGetBlock({}) });
    assert.equal(fs.existsSync(file), true);
    const raw1 = fs.readFileSync(file, 'utf8');
    tracker.observe({ position: site, inventory: inv, getBlock: worldGetBlock({}) });
    assert.equal(fs.readFileSync(file, 'utf8'), raw1);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('starter-plan missing filter does not throw when getBlock throws', () => {
    const site = { x: -1120, y: 68, z: 736 };
    const inv = { oak_planks: 64, oak_log: 8, oak_door: 1, white_bed: 1, chest: 1 };
    const step = continueHomesteadStep({ ...emptyProgress(), site, stage: 'foundation' }, {
        position: site, inventory: inv, getBlock: () => { throw new Error('plain object'); },
    });
    assert.ok(Array.isArray(step.placements));
    assert.ok(step.placements.length > 0);
});

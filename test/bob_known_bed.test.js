// [ai-player] 2026-11-01 (item 3) - a known bed (the claim bed, or the last bed he slept in) counts as a
// bed Bob can reach: at night he walks to it and sleeps, and the emergency shelter is only the fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initModes, getMode } from '../src/agent/modes.js';
import { emptyHome, setActiveHome } from '../src/agent/library/bob_home.js';
import { BOB_BED, claimBed, recordSleptBed } from '../src/agent/library/protected_area.js';
import {
    KNOWN_BED_MATCH_RANGE, KNOWN_BED_RANGE, hasVerifiedBed, knownBedEnabled, knownBedNear,
    shelterReason, shouldShelter,
} from '../src/agent/library/night_shelter.js';

// A bot standing in a tiny fake world with a few named blocks.
function bedBot({ at = { x: -1140, y: 68, z: 752 }, beds = [], timeOfDay = 18000, health = 20, entities = {} } = {}) {
    const cells = new Map();
    for (const b of beds) cells.set(`${b.x},${b.y},${b.z}`, { name: b.name || 'red_bed', boundingBox: 'block', position: { x: b.x, y: b.y, z: b.z } });
    const position = {
        x: at.x, y: at.y, z: at.z,
        distanceTo: (o) => Math.hypot(at.x - o.x, at.y - o.y, at.z - o.z),
    };
    return {
        entity: { position },
        time: { timeOfDay },
        health, entities, output: '',
        blockAt: (v) => cells.get(`${v.x},${v.y},${v.z}`) || null,
        findBlocks: () => [],
    };
}

test('knownBedNear finds a bed at the claim bed when Bob is close', () => {
    setActiveHome(emptyHome());
    assert.deepEqual(BOB_BED, { x: -1144, y: 68, z: 752 }, 'the claim bed default is unchanged');
    const bot = bedBot({ at: { x: -1140, y: 68, z: 752 }, beds: [{ x: -1144, y: 68, z: 752 }] });
    const bed = knownBedNear(bot);
    assert.ok(bed, 'the bed is found');
    assert.deepEqual(bed.pos, { x: -1144, y: 68, z: 752 });
    assert.equal(bed.name, 'red_bed');
    assert.equal(KNOWN_BED_MATCH_RANGE, 3);
    assert.equal(KNOWN_BED_RANGE, 48);
});

test('a known bed further than about 48 blocks is not counted', () => {
    const bed = [{ x: -1144, y: 68, z: 752 }];
    assert.equal(knownBedNear(bedBot({ at: { x: -1144 + 60, y: 68, z: 752 }, beds: bed })), null, '60 blocks: too far');
    assert.ok(knownBedNear(bedBot({ at: { x: -1144 + 40, y: 68, z: 752 }, beds: bed })), '40 blocks: reachable');
});

test('a bed within 3 blocks of the last bed he slept in counts', () => {
    setActiveHome(emptyHome());
    recordSleptBed({ x: 100, y: 64, z: 200 });
    const bot = bedBot({ at: { x: 120, y: 64, z: 200 }, beds: [{ x: 102, y: 64, z: 200, name: 'white_bed' }] });
    const bed = knownBedNear(bot);
    assert.ok(bed, 'the slept-bed anchor is used');
    assert.equal(bed.name, 'white_bed');
    assert.deepEqual(bed.anchor, { x: 100, y: 64, z: 200 });
});

test('BOB_BED=x,y,z overrides the claim bed, and BOB_KNOWN_BED=0 opts out', () => {
    assert.equal(knownBedEnabled({}), true);
    assert.equal(knownBedEnabled({ BOB_KNOWN_BED: '1' }), true);
    assert.equal(knownBedEnabled({ BOB_KNOWN_BED: '0' }), false);
    assert.deepEqual(claimBed({}), { x: -1144, y: 68, z: 752 });
    assert.deepEqual(claimBed({ BOB_BED: '10,70,-20' }), { x: 10, y: 70, z: -20 });
    assert.deepEqual(claimBed({ BOB_BED: 'nonsense' }), { x: -1144, y: 68, z: 752 }, 'a bad value falls back');

    const bot = bedBot({ at: { x: 12, y: 70, z: -20 }, beds: [{ x: 10, y: 70, z: -20 }] });
    assert.ok(knownBedNear(bot, { env: { BOB_BED: '10,70,-20' } }), 'the override is used');
    assert.equal(knownBedNear(bot, { env: {} }), null, 'without the override the claim bed is elsewhere');
    assert.equal(knownBedNear(bot, { env: { BOB_BED: '10,70,-20', BOB_KNOWN_BED: '0' } }), null, 'the opt-out wins');
});

test('a reachable known bed suppresses the emergency shelter; a failed trip allows it', () => {
    setActiveHome(emptyHome());
    const zombie = { name: 'zombie', type: 'mob', position: { x: -1136, y: 68, z: 752 } };
    const bot = bedBot({ at: { x: -1140, y: 68, z: 752 }, beds: [{ x: -1144, y: 68, z: 752 }], entities: { z: zombie } });
    assert.equal(shelterReason(bot, { knownBed: false }), 'hostiles', 'without the bed rule the shelter would fire');
    assert.equal(shelterReason(bot), null, 'with the bed reachable he sleeps instead');
    assert.equal(shouldShelter(bot), false);
    assert.equal(hasVerifiedBed(bot), true, 'the known bed counts as a bed');
    assert.equal(hasVerifiedBed(bot, emptyHome(), { knownBed: false }), false, 'unless the trip already failed');
});

test('the night mode walks to the known bed before the emergency shelter', () => {
    const src = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    const bed = src.indexOf('this.tryKnownBed(agent)');
    const shel = src.indexOf('this.tryEmergencyShelter(agent)');
    assert.ok(bed > 0 && shel > bed, 'the bed path is tried first');
    assert.match(src, /await skills\.goToBed\(agent\.bot\)/, 'and it sleeps with skills.goToBed');
    assert.match(src, /const knownBed = now >= this\.bed_failed_until/, 'a failed bed trip lets the shelter run');
});

test('tryKnownBed starts the night-mode bed action and holds until dawn', async () => {
    setActiveHome(emptyHome());
    const bot = bedBot({ at: { x: -1140, y: 68, z: 752 }, beds: [{ x: -1144, y: 68, z: 752 }] });
    const labels = [];
    const agent = {
        bot,
        isIdle: () => true,
        openChat: () => {},
        prompter: { getInitModes: () => null },
        actions: {
            currentActionLabel: '',
            runAction: async (l, fn) => { labels.push(l); try { await fn(); } catch (_) {} return { message: '' }; },
            stop: async () => {},
        },
        self_prompter: { isActive: () => false, isPaused: () => false, isStopped: () => false, stopLoop() {}, start() {}, setPromptPaused() {} },
    };
    initModes(agent);
    const night = getMode('night');
    night.active = false; night.holding = false; night.boot_checked = true; night.next_bed = 0; night.bed_failed_until = 0;
    night.tryKnownBed(agent);
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    assert.ok(labels.includes('mode:night'), 'the bed trip ran as the night mode action');
    assert.equal(night.holding, true, 'and he holds until dawn, like the shelter');
    assert.ok(night.bed_failed_until > 0, 'an unusable bed is recorded so the shelter can run');
    assert.ok(night.next_bed > Date.now(), 'and the trip is on a cooldown');
});

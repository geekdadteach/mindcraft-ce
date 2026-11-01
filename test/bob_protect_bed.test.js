// [ai-player] Bed protection - bot.dig and safeToBreak must refuse Bob's own bed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    installProtectedAreaGuard,
    ownBedAt,
    bedProtectEnabled,
    recordSleptBed,
    lastSleptBed,
    knownBeds,
    BOB_BED,
} from '../src/agent/library/protected_area.js';
import { emptyHome, setActiveHome } from '../src/agent/library/bob_home.js';

test('bed protection is ON by default and BOB_PROTECT_BED=0 opts out', () => {
    assert.equal(bedProtectEnabled({}), true);
    assert.equal(bedProtectEnabled({ BOB_PROTECT_BED: '1' }), true);
    assert.equal(bedProtectEnabled({ BOB_PROTECT_BED: '0' }), false);
});

test('ownBedAt covers the claim bed, the home bed and the last bed he slept in', () => {
    setActiveHome(emptyHome());
    assert.deepEqual(knownBeds()[0], BOB_BED, 'the claim bed is always known');
    assert.ok(ownBedAt({ x: -1144, y: 68, z: 752 }, 'red_bed'), 'the claim bed is protected');
    assert.ok(ownBedAt({ x: -1144, y: 69, z: 752 }, 'red_bed'), 'within 2 blocks counts');
    assert.equal(ownBedAt({ x: -1144, y: 68, z: 760 }, 'red_bed'), null, 'far away is not protected');
    assert.equal(ownBedAt({ x: -1144, y: 68, z: 752 }, 'stone'), null, 'only *_bed blocks count');
    assert.equal(ownBedAt({ x: -1144, y: 68, z: 752 }, 'red_bed', { env: { BOB_PROTECT_BED: '0' } }), null, 'opt-out');

    recordSleptBed({ x: 100.5, y: 64, z: 100 });
    assert.deepEqual(lastSleptBed(), { x: 100, y: 64, z: 100 }, 'the slept bed is floored and remembered');
    assert.ok(ownBedAt({ x: 101, y: 64, z: 100 }, 'white_bed'), 'the slept bed is protected');
    assert.equal(ownBedAt({ x: 104, y: 64, z: 100 }, 'white_bed'), null, 'more than 2 blocks away is fine');
    assert.equal(recordSleptBed(null), lastSleptBed(), 'a bad position does not clobber the record');
});

test('bot.dig refuses his own bed', async () => {
    setActiveHome(emptyHome());
    const calls = [];
    const bot = {
        entity: { position: { x: 0, y: 64, z: 0 } },
        dig: async (block) => { calls.push(block); return 'dug'; },
    };
    installProtectedAreaGuard({ bot });
    const bed = { name: 'red_bed', position: { x: -1144, y: 68, z: 752 } };
    await assert.rejects(() => bot.dig(bed), /is your bed/, 'digging his bed throws');
    assert.deepEqual(calls, [], 'the original dig was never called');
    const stone = { name: 'stone', position: { x: 0, y: 64, z: 0 } };
    assert.equal(await bot.dig(stone), 'dug', 'other blocks still dig');
    assert.deepEqual(calls, [stone]);
});

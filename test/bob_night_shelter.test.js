// [ai-player] Fix 1e — emergency night shelter gating (protected areas, no-go zones, opt-out).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { emptyHome, exampleVerifiedHome, setActiveHome } from '../src/agent/library/bob_home.js';
import { NO_GO_ZONES } from '../src/agent/library/no_go_zones.js';
import {
    SHELTER_HOSTILE_RANGE, SHELTER_LOW_HEALTH, blockedForShelter, buildShelter,
    sealSpots, shelterEnabled, shelterReason, shouldShelter,
    clearShelter, dawnExit, isSheltered, markSheltered, placedBlocksToDig,
    pocketCellsToRefill, shelterGuard, shelterState,
} from '../src/agent/library/night_shelter.js';

const at = (x, y, z) => ({ x, y, z, distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z) });

function nightBot({ timeOfDay = 18000, health = 20, entities = {}, position = at(0, 64, 0) } = {}) {
    return { entity: { position }, time: { timeOfDay }, health, entities };
}
const zombieAt = (d) => ({ z: { name: 'zombie', type: 'mob', position: at(d, 64, 0) } });

test('shelter is ON by default and BOB_NIGHT_SHELTER=0 opts out', () => {
    assert.equal(shelterEnabled({}), true);
    assert.equal(shelterEnabled({ BOB_NIGHT_SHELTER: '1' }), true);
    assert.equal(shelterEnabled({ BOB_NIGHT_SHELTER: '0' }), false);
    setActiveHome(emptyHome());
    const bot = nightBot({ entities: zombieAt(4) });
    assert.equal(shouldShelter(bot), true, 'a hostile at night with no bed: shelter');
    assert.equal(shouldShelter(bot, { env: { BOB_NIGHT_SHELTER: '0' } }), false, 'the opt-out disables it');
    assert.equal(shelterReason(bot, { env: { BOB_NIGHT_SHELTER: '0' } }), null);
});

test('shelterReason: night plus hostiles or low health, and only without a verified bed', () => {
    setActiveHome(emptyHome());
    assert.equal(shelterReason(nightBot({ entities: zombieAt(SHELTER_HOSTILE_RANGE - 1) })), 'hostiles');
    assert.equal(shelterReason(nightBot({ entities: zombieAt(SHELTER_HOSTILE_RANGE + 2) })), null, 'a distant hostile does not trigger it');
    assert.equal(shelterReason(nightBot({ health: SHELTER_LOW_HEALTH })), 'low-health');
    assert.equal(shelterReason(nightBot({ health: SHELTER_LOW_HEALTH + 1 })), null, 'a quiet night with no bed is not enough alone');
    assert.equal(shelterReason(nightBot({ timeOfDay: 6000, entities: zombieAt(4) })), null, 'not at night');
    setActiveHome(exampleVerifiedHome());
    try {
        assert.equal(shelterReason(nightBot({ entities: zombieAt(4) })), null, 'a verified home bed means night-home handles it');
    } finally { setActiveHome(emptyHome()); }
});

test('the shelter never touches a protected house area or a no-go zone', () => {
    setActiveHome(emptyHome());
    try {
        assert.equal(blockedForShelter({ x: 0, y: 64, z: 0 }, 'dirt'), false, 'open ground is allowed');
        const market = NO_GO_ZONES[0];
        assert.equal(blockedForShelter({ x: market.x, y: market.y, z: market.z }, 'dirt'), true, 'a no-go zone is refused');
        const home = exampleVerifiedHome();
        setActiveHome(home);
        assert.equal(blockedForShelter({ x: home.inside.x, y: home.inside.y, z: home.inside.z }, 'dirt'), true, 'the house box is refused');
        assert.equal(blockedForShelter({ x: home.entrance.x, y: home.entrance.y, z: home.entrance.z }, 'cobblestone'), true, 'the porch is refused');
    } finally { setActiveHome(emptyHome()); }
});

test('buildShelter is a no-op when disabled or when a verified bed exists', async () => {
    setActiveHome(emptyHome());
    try {
        const bot = nightBot({ entities: zombieAt(4) });
        assert.equal(await buildShelter(bot, { env: { BOB_NIGHT_SHELTER: '0' } }), false, 'opt-out: no build');
        setActiveHome(exampleVerifiedHome());
        assert.equal(await buildShelter(bot, { env: {} }), false, 'verified bed: night-home handles it');
    } finally { setActiveHome(emptyHome()); }
});

test('sealSpots covers the four sides at feet and head height plus the block above', () => {
    const spots = sealSpots({ x: 0, y: 64, z: 0 });
    assert.equal(spots.length, 9);
    assert.ok(spots.some(s => s.x === 0 && s.y === 66 && s.z === 0), 'caps above the head');
    assert.ok(spots.some(s => s.x === 1 && s.y === 64 && s.z === 0), 'a feet-level side');
});

// ---- Fix 1e follow-up: the stay-in hold and the dawn exit ----

test('the shelter hold blocks travel commands but never blocks eating', () => {
    clearShelter();
    try {
        assert.equal(shelterGuard('!searchForEntity'), null, 'nothing is blocked while not sheltered');
        markSheltered({ day: 3, placed: [], dug: [] });
        assert.equal(isSheltered(), true);
        for (const cmd of ['!searchForEntity', '!searchForBlock', '!collectBlocks', '!gatherWood', '!getFood',
            '!goToCoordinates', '!goToPlayer', '!goToRememberedPlace', '!goToSurface', '!goToBed']) {
            assert.match(shelterGuard(cmd) || '', /SHELTERED/, `${cmd} must be blocked while sheltered`);
        }
        for (const cmd of ['!consume', '!eat', '!stop', '!stfu', '!stay', '!inventory', '!stats', '!health']) {
            assert.equal(shelterGuard(cmd), null, `${cmd} must never be blocked`);
        }
    } finally { clearShelter(); }
});

test('the modes skip unstuck and item_collecting while sheltered and hold night until dawn', () => {
    const src = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    const gates = (src.match(/shelter\.isSheltered\(\)/g) || []).length;
    assert.ok(gates >= 4, `unstuck, item_collecting, self_defense and night should gate on shelter.isSheltered() (found ${gates})`);
    assert.match(src, /do not try to unstick/, 'unstuck is skipped');
    assert.match(src, /stay put while sealed in/, 'item_collecting is skipped');
    assert.match(src, /holds until dawn, whatever BOB_NIGHT_HOME says/, 'night holds the shelter until dawn');
    assert.match(src, /holdShelter: function/, 'the hold is implemented');
    assert.match(src, /dawnExit: function/, 'the dawn exit is implemented');
});

function cellKey(v) { return `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`; }

function fakeShelterBot({ blocks = [], held = [{ name: 'dirt' }] } = {}) {
    const cells = new Map();
    for (const b of blocks) cells.set(cellKey(b), { name: b.name, boundingBox: b.boundingBox || 'block', position: { x: b.x, y: b.y, z: b.z } });
    const dug = [];
    const bot = {
        interrupt_code: false,
        inventory: { items: () => held },
        blockAt: (v) => cells.get(cellKey(v)) || null,
        dig: async (b) => { dug.push(cellKey(b.position)); cells.delete(cellKey(b.position)); },
    };
    return { bot, dug, cells };
}

test('dawn exit digs back only the blocks the shelter itself placed', async () => {
    clearShelter();
    const { bot, dug } = fakeShelterBot({
        blocks: [
            { x: 1, y: 64, z: 0, name: 'dirt' },        // the shelter placed this
            { x: 2, y: 64, z: 0, name: 'oak_planks' },  // somebody else's block, not ours
            { x: 3, y: 64, z: 0, name: 'stone' },       // we placed dirt here but it is now stone
        ],
    });
    markSheltered({
        day: 5,
        placed: [
            { x: 1, y: 64, z: 0, name: 'dirt' },
            { x: 2, y: 64, z: 0, name: 'dirt' },
            { x: 3, y: 64, z: 0, name: 'dirt' },
        ],
        dug: [],
    });
    assert.equal(await dawnExit(bot), true);
    assert.deepEqual(dug, ['1,64,0'], 'only the block still matching what the shelter placed is dug');
    assert.equal(isSheltered(), false, 'the shelter state is cleared');
});

test('placedBlocksToDig ignores cells that no longer hold our block', () => {
    const { bot } = fakeShelterBot({ blocks: [
        { x: 1, y: 64, z: 0, name: 'dirt' },
        { x: 2, y: 64, z: 0, name: 'oak_planks' },
    ] });
    const placed = [
        { x: 1, y: 64, z: 0, name: 'dirt' },
        { x: 2, y: 64, z: 0, name: 'dirt' },
        { x: 3, y: 64, z: 0, name: 'dirt' }, // gone
    ];
    assert.deepEqual(placedBlocksToDig(bot, placed).map(x => x.pos.x), [1]);
});

test('pocketCellsToRefill needs a held seal block and an empty cell', () => {
    const dug = [{ x: 0, y: 63, z: 0 }, { x: 0, y: 62, z: 0 }];
    const withSeal = fakeShelterBot({
        blocks: [
            { x: 0, y: 63, z: 0, name: 'air', boundingBox: 'empty' },
            { x: 0, y: 62, z: 0, name: 'stone', boundingBox: 'block' },
        ],
        held: [{ name: 'cobblestone' }],
    });
    assert.deepEqual(pocketCellsToRefill(withSeal.bot, dug).map(p => p.y), [63]);
    const noSeal = fakeShelterBot({
        blocks: [{ x: 0, y: 63, z: 0, name: 'air', boundingBox: 'empty' }],
        held: [{ name: 'iron_sword' }],
    });
    assert.deepEqual(pocketCellsToRefill(noSeal.bot, dug), [], 'no seal block: nothing to refill with');
});

test('shelter state is a single record that mark/clear manage', () => {
    clearShelter();
    assert.equal(isSheltered(), false);
    assert.equal(shelterState(), null);
    const s = markSheltered({ day: 9, placed: [{ x: 1, y: 2, z: 3, name: 'dirt' }], dug: [] });
    assert.equal(isSheltered(), true);
    assert.equal(shelterState(), s);
    assert.equal(s.day, 9);
    clearShelter();
    assert.equal(isSheltered(), false);
});

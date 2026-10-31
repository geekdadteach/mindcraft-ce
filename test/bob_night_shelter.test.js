// [ai-player] Fix 1e — emergency night shelter gating (protected areas, no-go zones, opt-out).
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyHome, exampleVerifiedHome, setActiveHome } from '../src/agent/library/bob_home.js';
import { NO_GO_ZONES } from '../src/agent/library/no_go_zones.js';
import {
    SHELTER_HOSTILE_RANGE, SHELTER_LOW_HEALTH, blockedForShelter, buildShelter,
    sealSpots, shelterEnabled, shelterReason, shouldShelter,
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

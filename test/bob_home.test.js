import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bobBuiltHome, emptyHome, exampleVerifiedHome, getActiveHome, homeFromWorld, isVerifiedHome,
    LEGACY_HILLTOP, setActiveHome, verifyHomeInWorld, geometryFromFeatures,
} from '../src/agent/library/bob_home.js';
import { worldGetBlock, applyPlacements, starterPlan } from '../src/agent/library/bob_homestead.js';
import { HOUSE_AREA, houseDoor, plateSupportOf, protectedAreaAt } from '../src/agent/library/house_bounds.js';
import { HOUSE_AREA as ENCLOSURE_HOUSE_AREA, EXIT_WAYPOINT } from '../src/agent/library/bob_enclosure.js';
import { doorOf } from '../src/agent/library/stuck_home.js';
import { HOMESTEAD } from '../src/agent/library/no_go_zones.js';
import { entranceOf, insideOf } from '../src/agent/library/home_route.js';

test('no verified home means no hilltop destination and no house protection', () => {
    setActiveHome(emptyHome());
    assert.equal(isVerifiedHome(getActiveHome()), false);
    assert.equal(houseDoor(), null);
    assert.equal(doorOf(), null);
    assert.equal(HOMESTEAD, null);
    assert.equal(entranceOf(), null);
    assert.equal(insideOf(), null);
    assert.equal(protectedAreaAt(LEGACY_HILLTOP.door), null);
    assert.equal(protectedAreaAt(LEGACY_HILLTOP.plateSupport, 'dirt'), null);
    assert.equal(typeof HOUSE_AREA, 'object');
    assert.equal(typeof ENCLOSURE_HOUSE_AREA, 'object');
    assert.equal(typeof HOUSE_AREA, typeof ENCLOSURE_HOUSE_AREA);
    assert.equal(HOUSE_AREA.x1, null);
    assert.equal(HOUSE_AREA.name, null);
    assert.equal(EXIT_WAYPOINT.x, null);
});

test('verified home geometry is derived from discovered features, not the claim center', () => {
    const home = exampleVerifiedHome();
    setActiveHome(home);
    try {
        assert.equal(isVerifiedHome(home), true);
        assert.ok(Math.hypot(home.door.x - -1144, home.door.z - 752) > 8);
        assert.equal(houseDoor().x, home.door.x);
        assert.deepEqual(plateSupportOf(), home.plateSupport);
        assert.equal(doorOf().x, home.entrance.x);
        assert.equal(entranceOf().x, home.entrance.x);
        assert.equal(insideOf().z, home.inside.z);
        assert.equal(protectedAreaAt(home.door)?.name, 'house');
        assert.equal(protectedAreaAt(LEGACY_HILLTOP.door), null);
    } finally { setActiveHome(emptyHome()); }
});

test('a village or off-claim house is not adopted as Bob\'s home', () => {
    const offClaim = geometryFromFeatures({
        door: { x: -500, y: 70, z: 400 }, facing: 'north',
        bed: { x: -502, y: 70, z: 403 }, storage: { x: -498, y: 70, z: 403 },
    });
    const world = applyPlacements({}, starterPlan({ x: -500, y: 70, z: 402 }));
    const getBlock = worldGetBlock(world);
    const check = verifyHomeInWorld(getBlock, { ...offClaim, verified: true }, { requireOwned: false });
    assert.equal(check.ok, false);
    assert.match(check.why, /outside Bob's claim/);

    const site = { x: -1120, y: 68, z: 736 };
    const hut = applyPlacements({}, starterPlan(site));
    const found = homeFromWorld(worldGetBlock(hut), site, { site, requireOwned: true });
    assert.ok(found);
    assert.equal(isVerifiedHome(found), true);

    const stranger = homeFromWorld(worldGetBlock(hut), site, { site: { x: -1190, y: 65, z: 800 }, placed: [], requireOwned: true });
    assert.equal(stranger, null);
    assert.equal(bobBuiltHome(found, { site: { x: 0, z: 0 }, placed: [] }), false);
    assert.equal(bobBuiltHome(found, { site }), true);
});

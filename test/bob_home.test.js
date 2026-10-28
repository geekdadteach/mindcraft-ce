import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyHome, exampleVerifiedHome, getActiveHome, isVerifiedHome, LEGACY_HILLTOP, setActiveHome } from '../src/agent/library/bob_home.js';
import { houseDoor, plateSupportOf, protectedAreaAt } from '../src/agent/library/house_bounds.js';
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

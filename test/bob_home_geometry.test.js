import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyHome, exampleVerifiedHome, geometryFromFeatures, LEGACY_HOME_ENTRANCE, LEGACY_HILLTOP, sameHomeEntrance, setActiveHome } from '../src/agent/library/bob_home.js';
import { houseArea, housePorch, isDiggableLaneFill, isInsideHouseArea, protectedAreaAt, walkingLane } from '../src/agent/library/house_bounds.js';

test('unverified home has no live geometry', () => {
    setActiveHome(emptyHome());
    assert.equal(houseArea(), null);
    assert.equal(housePorch(), null);
    assert.equal(walkingLane(), null);
    assert.equal(isInsideHouseArea(LEGACY_HILLTOP.inside), false);
});

test('derived porch and plate support stay protected while loose fill is diggable', () => {
    const home = exampleVerifiedHome();
    setActiveHome(home);
    try {
        assert.equal(isInsideHouseArea(home.inside), true);
        assert.equal(isInsideHouseArea(home.entrance), false);
        assert.equal(protectedAreaAt(home.plateSupport, 'dirt')?.name, 'house-porch');
        const lane = walkingLane();
        const fillCell = { x: lane.x1 + 1, y: home.door.y, z: lane.z1 };
        if (!(fillCell.x === home.plateSupport.x && fillCell.z === home.plateSupport.z && fillCell.y === home.plateSupport.y)) {
            assert.equal(isDiggableLaneFill(fillCell, 'dirt'), true);
        }
        assert.equal(protectedAreaAt(home.entrance, 'oak_log')?.name, 'house-porch');
        assert.ok(houseArea().name === 'house');
        assert.ok(housePorch().name === 'house-porch');
    } finally { setActiveHome(emptyHome()); }
});

test('route seed terminates at the discovered entrance', () => {
    const home = exampleVerifiedHome();
    assert.deepEqual(home.seedRoute.at(-1), [home.entrance.x, home.entrance.y, home.entrance.z]);
    const out = { north: { dz: -1 }, south: { dz: 1 }, west: { dx: -1 }, east: { dx: 1 } }[home.facing];
    if (out.dz) assert.equal(Math.sign(home.exitWaypoint.z - home.entrance.z), Math.sign(out.dz) || Math.sign(home.exitWaypoint.z - home.door.z));
});

test('legacy hilltop entrance is not the active home', () => {
    assert.equal(sameHomeEntrance(LEGACY_HOME_ENTRANCE, exampleVerifiedHome().entrance), false);
    assert.equal(sameHomeEntrance(LEGACY_HOME_ENTRANCE, LEGACY_HILLTOP.entrance), true);
    assert.equal(sameHomeEntrance(null, LEGACY_HOME_ENTRANCE), false);
});

test('geometryFromFeatures does not use the claim center', () => {
    const g = geometryFromFeatures({ door: { x: -1100, y: 66, z: 740 }, facing: 'south', bed: { x: -1100, y: 66, z: 738 }, storage: { x: -1098, y: 66, z: 738 } });
    assert.equal(g.door.x, -1100);
    assert.ok(Math.abs(g.entrance.z - 740) > 0.4);
});

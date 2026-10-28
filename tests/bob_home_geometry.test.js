import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME } from '../src/agent/library/bob_home.js';
import { HOUSE_AREA, HOUSE_PORCH, WALKING_LANE, isInsideHouseArea, protectedAreaAt, isDiggableLaneFill } from '../src/agent/library/house_bounds.js';

test('canonical home geometry matches live snapshot', () => {
    assert.deepEqual(HOME.base, {x:-823,y:124,z:568});
    assert.deepEqual(HOME.door, {x:-820,y:124,z:566});
    assert.deepEqual(HOUSE_AREA, {name:'house',...HOME.geometry.area});
    assert.deepEqual(HOUSE_PORCH, {name:'house-porch',...HOME.geometry.porch});
    assert.deepEqual(WALKING_LANE, {name:'door-lane',...HOME.geometry.walkingLane});
});

test('porch and plate support stay protected while loose fill is diggable', () => {
    assert.equal(isInsideHouseArea(HOME.inside), true);
    assert.equal(isInsideHouseArea(HOME.entrance), false);
    assert.equal(protectedAreaAt(HOME.plateSupport, 'dirt')?.name, 'house-porch');
    assert.equal(isDiggableLaneFill({x:-820,y:124,z:564}, 'dirt'), true);
    assert.equal(protectedAreaAt({x:-820,y:124,z:564}, 'oak_log')?.name, 'house-porch');
});

test('route seed terminates at canonical entrance', () => {
    assert.deepEqual(HOME.seedRoute.at(-1), [HOME.entrance.x, HOME.entrance.y, HOME.entrance.z]);
    assert.equal(HOME.exitWaypoint.z < HOME.entrance.z, true);
});

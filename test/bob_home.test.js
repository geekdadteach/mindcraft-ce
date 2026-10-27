import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME } from '../src/agent/library/bob_home.js';
import { HOUSE_DOOR, PLATE_SUPPORT } from '../src/agent/library/house_bounds.js';
import { DOOR } from '../src/agent/library/stuck_home.js';
import { HOMESTEAD } from '../src/agent/library/no_go_zones.js';
import { ENTRANCE, INSIDE } from '../src/agent/library/home_route.js';

test('every home subsystem uses canonical coordinates', () => {
    assert.equal(HOUSE_DOOR, HOME.door);
    assert.equal(PLATE_SUPPORT, HOME.plateSupport);
    assert.equal(DOOR, HOME.entrance);
    assert.equal(HOMESTEAD, HOME.base);
    assert.deepEqual([ENTRANCE.x,ENTRANCE.y,ENTRANCE.z],Object.values(HOME.entrance));
    assert.deepEqual([INSIDE.x,INSIDE.y,INSIDE.z],Object.values(HOME.inside));
});

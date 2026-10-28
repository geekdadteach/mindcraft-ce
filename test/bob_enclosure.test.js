import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EnclosureWatch,
    EXIT_WAYPOINT,
    formatBlockers,
    inspectExitBlockers,
    isOutsideHouseTarget,
    exitProbeCells
} from '../src/agent/library/bob_enclosure.js';
import {
    HOUSE_AREA,
    HOUSE_DOOR,
    WALKING_LANE,
    isInsideHouseArea,
    isWalkingLane,
    protectedAreaAt,
    isDiggableLaneFill,
    walkingLane,
    houseArea,
    houseDoor
} from '../src/agent/library/house_bounds.js';
import { emptyHome, exampleVerifiedHome, LEGACY_HILLTOP, setActiveHome } from '../src/agent/library/bob_home.js';

const home = exampleVerifiedHome();
const inside = home.inside;
const outsideA = { x: -800, y: 70, z: 500 };
const outsideB = { x: -780, y: 72, z: 480 };
const outsideC = { x: -760, y: 80, z: 450 };

function withHome(fn) {
    setActiveHome(home);
    try { return fn(); } finally { setActiveHome(emptyHome()); }
}

test('enclosure is inert without a verified home', () => {
    setActiveHome(emptyHome());
    const watch = new EnclosureWatch({ requiredTargets: 3 });
    const r = watch.record(LEGACY_HILLTOP.inside, outsideA);
    assert.equal(r.recorded, false);
    assert.equal(r.reason, 'no_verified_home');
    assert.equal(isInsideHouseArea(LEGACY_HILLTOP.inside), false);
    assert.equal(protectedAreaAt(LEGACY_HILLTOP.door), null);
});

test('enclosure trips on several distinct outside NoPaths from inside the house', () => withHome(() => {
    let now = 100_000;
    const watch = new EnclosureWatch({
        now: () => now,
        windowMs: 8 * 60_000,
        requiredTargets: 3
    });

    assert.equal(watch.record(inside, outsideA).enclosed, false);
    assert.equal(watch.record(inside, outsideA).reason, 'insufficient_distinct_targets');
    now += 30_000;
    assert.equal(watch.record(inside, outsideB).enclosed, false);
    now += 30_000;
    const third = watch.record(inside, outsideC);
    assert.equal(third.enclosed, true);
    assert.equal(third.distinctTargets, 3);
}));

test('same outside target and outside-to-outside failures do not enclose', () => withHome(() => {
    const watch = new EnclosureWatch({ requiredTargets: 3 });
    watch.record(inside, outsideA);
    watch.record(inside, outsideA);
    watch.record({ x: -700, y: 80, z: 400 }, outsideB);
    assert.equal(watch.record(inside, outsideA).enclosed, false);
    assert.equal(watch.record(inside, outsideA).distinctTargets, 1);
}));

test('enclosure window expires so old targets do not count', () => withHome(() => {
    let now = 100_000;
    const watch = new EnclosureWatch({
        now: () => now,
        windowMs: 8 * 60_000,
        requiredTargets: 3
    });

    watch.record(inside, outsideA);
    now += 9 * 60_000;
    watch.record(inside, outsideB);
    const again = watch.record(inside, outsideC);
    assert.equal(again.enclosed, false);
    assert.equal(again.distinctTargets, 2);
}));

test('inspectExitBlockers reports sealed porch cells and ignores air, plate and door', () => withHome(() => {
    const door = houseDoor();
    const world = {};
    world[`${door.x},${door.y},${door.z}`] = { name: 'oak_door' };
    world[`${door.x},${door.y + 1},${door.z}`] = { name: 'oak_door' };
    const cells = exitProbeCells();
    const dirt = cells.find((c) => c.y === door.y && !(c.x === door.x && c.z === door.z));
    assert.ok(dirt);
    world[`${dirt.x},${dirt.y},${dirt.z}`] = { name: 'dirt' };
    world[`${dirt.x},${dirt.y + 1},${dirt.z}`] = { name: 'dirt' };
    const blockers = inspectExitBlockers((x, y, z) => world[`${x},${y},${z}`] || { name: 'air' });
    assert.ok(blockers.some((b) => b.name === 'dirt' && b.x === dirt.x && b.z === dirt.z && b.y === dirt.y));
    assert.equal(blockers.some((b) => /door|pressure_plate|air/.test(b.name)), false);
    assert.match(formatBlockers(blockers), new RegExp(`dirt at ${dirt.x} ${dirt.y} ${dirt.z}`));
}));

test('walking lane: only loose fill is diggable; walls, roof and door stay protected', () => withHome(() => {
    const lane = walkingLane();
    const door = houseDoor();
    const fill = { x: lane.x1, y: door.y, z: lane.z1 };
    if (!(fill.x === home.plateSupport.x && fill.y === home.plateSupport.y && fill.z === home.plateSupport.z)) {
        assert.equal(protectedAreaAt(fill, 'dirt'), null);
        assert.equal(isWalkingLane(fill), true);
    }
    assert.equal(protectedAreaAt(door)?.name, 'house');
    assert.equal(isInsideHouseArea(inside), true);
    assert.equal(isInsideHouseArea(outsideA), false);
    assert.equal(isOutsideHouseTarget(outsideA), true);
    assert.equal(isOutsideHouseTarget(inside), false);
    assert.equal(HOUSE_DOOR.x, door.x);
    assert.equal(HOUSE_AREA.name, 'house');
    assert.ok(WALKING_LANE.x1 <= WALKING_LANE.x2);
    assert.ok(Number.isFinite(EXIT_WAYPOINT.x));
}));

test('porch row: house blocks on the discovered porch are never diggable', () => withHome(() => {
    const support = home.plateSupport;
    assert.equal(protectedAreaAt(support, 'grass_block')?.name, 'house-porch');
    assert.equal(protectedAreaAt(support, 'dirt')?.name, 'house-porch');
    const lane = walkingLane();
    const porchCell = { x: lane.x1, y: home.door.y, z: lane.z1 };
    for (const name of ['oak_planks', 'cobblestone', 'glass', 'oak_stairs', 'oak_fence', 'oak_door']) {
        assert.equal(protectedAreaAt({ ...porchCell, y: home.door.y + 1 }, name)?.name, 'house-porch', name);
    }
    assert.equal(isDiggableLaneFill(support, 'dirt'), false);
    assert.equal(protectedAreaAt(LEGACY_HILLTOP.door, 'oak_log'), null);
}));

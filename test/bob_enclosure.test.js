import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EnclosureWatch,
    EXIT_WAYPOINT,
    formatBlockers,
    inspectExitBlockers,
    isOutsideHouseTarget
} from '../src/agent/library/bob_enclosure.js';
import {
    HOUSE_AREA,
    HOUSE_DOOR,
    WALKING_LANE,
    isInsideHouseArea,
    isWalkingLane,
    protectedAreaAt,
    isDiggableLaneFill
} from '../src/agent/library/house_bounds.js';

const inside = { x: -821, y: 124, z: 568 };
const outsideA = { x: -800, y: 70, z: 500 };
const outsideB = { x: -780, y: 72, z: 480 };
const outsideC = { x: -760, y: 80, z: 450 };

test('enclosure trips on several distinct outside NoPaths from inside the house', () => {
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
});

test('same outside target and outside-to-outside failures do not enclose', () => {
    const watch = new EnclosureWatch({ requiredTargets: 3 });
    watch.record(inside, outsideA);
    watch.record(inside, outsideA);
    watch.record({ x: -700, y: 80, z: 400 }, outsideB);
    assert.equal(watch.record(inside, outsideA).enclosed, false);
    assert.equal(watch.record(inside, outsideA).distinctTargets, 1);
});

test('enclosure window expires so old targets do not count', () => {
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
});

test('inspectExitBlockers reports sealed porch cells and ignores air, plate and door', () => {
    const world = {
        '-820,124,566': { name: 'oak_door' },
        '-820,125,566': { name: 'oak_door' },
        '-820,124,565': { name: 'oak_pressure_plate' },
        '-820,124,564': { name: 'dirt' },
        '-820,125,564': { name: 'dirt' },
        '-820,124,563': { name: 'dirt' },
        '-819,124,564': { name: 'air' }
    };
    const blockers = inspectExitBlockers((x, y, z) => world[`${x},${y},${z}`] || { name: 'air' });
    assert.ok(blockers.some((b) => b.name === 'dirt' && b.x === -820 && b.z === 564 && b.y === 124));
    assert.ok(blockers.some((b) => b.name === 'dirt' && b.x === -820 && b.z === 564 && b.y === 125));
    assert.equal(blockers.some((b) => /door|pressure_plate|air/.test(b.name)), false);
    assert.match(formatBlockers(blockers), /dirt at -820 124 564/);
});

test('walking lane: only loose fill is diggable; walls, roof and door stay protected', () => {
    assert.equal(protectedAreaAt({ x: -820, y: 124, z: 564 }, 'dirt'), null);
    assert.equal(protectedAreaAt({ x: -820, y: 125, z: 564 }, 'gravel'), null);
    assert.equal(protectedAreaAt({ x: -820, y: 124, z: 565 }, 'dirt'), null);
    assert.equal(isWalkingLane({ x: -820, y: 124, z: 564 }), true);

    assert.equal(protectedAreaAt({ x: -820, y: 124, z: 566 })?.name, 'house');
    assert.equal(protectedAreaAt({ x: -823, y: 124, z: 568 })?.name, 'house');
    assert.equal(protectedAreaAt({ x: -816, y: 127, z: 570 })?.name, 'house');
    assert.equal(protectedAreaAt({ x: -827, y: 123, z: 573 })?.name, 'house');

    assert.equal(isInsideHouseArea(inside), true);
    assert.equal(isInsideHouseArea(outsideA), false);
    assert.equal(isOutsideHouseTarget(outsideA), true);
    assert.equal(isOutsideHouseTarget(inside), false);
    assert.equal(HOUSE_DOOR.z, HOUSE_AREA.z1);
    assert.ok(WALKING_LANE.z2 < HOUSE_AREA.z1);
    assert.equal(EXIT_WAYPOINT.z < WALKING_LANE.z1, true);
});

// nav-on-live-20261026: porch row z 564..565 holds real house blocks (oak_log posts beside the plate,
// seen in the .20 log at -823/-821/-819 124 565; outside plate -820 124 565 and its support below).
test('porch row: house blocks at z 564..565 are never diggable', () => {
    for (const x of [-823, -821, -819]) {
        assert.equal(protectedAreaAt({ x, y: 124, z: 565 }, 'oak_log')?.name, 'house-porch');
    }
    assert.equal(protectedAreaAt({ x: -820, y: 124, z: 565 }, 'oak_pressure_plate')?.name, 'house-porch');
    assert.equal(protectedAreaAt({ x: -820, y: 124, z: 565 }, 'stone_pressure_plate')?.name, 'house-porch');
    // plate support stays protected even if it is dirt/grass
    assert.equal(protectedAreaAt({ x: -820, y: 123, z: 565 }, 'grass_block')?.name, 'house-porch');
    assert.equal(protectedAreaAt({ x: -820, y: 123, z: 565 }, 'dirt')?.name, 'house-porch');
    // planks, cobblestone, glass, stairs in the lane are building blocks, protected
    for (const name of ['oak_planks', 'cobblestone', 'glass', 'oak_stairs', 'oak_fence', 'torch', 'oak_door']) {
        assert.equal(protectedAreaAt({ x: -820, y: 125, z: 564 }, name)?.name, 'house-porch', name);
    }
    // unknown block name (position-only query) is protected
    assert.equal(protectedAreaAt({ x: -820, y: 124, z: 564 })?.name, 'house-porch');
    // outside the lane on the porch row, even fill is protected (front wall side cells)
    assert.equal(protectedAreaAt({ x: -824, y: 124, z: 565 }, 'dirt')?.name, 'house-porch');
    assert.equal(protectedAreaAt({ x: -818, y: 124, z: 565 }, 'dirt')?.name, 'house-porch');
    assert.equal(protectedAreaAt({ x: -816, y: 124, z: 564 }, 'oak_log')?.name, 'house-porch');
    // live .20 box (x -824..-816 z 564..572) is still covered in full
    for (let x = -824; x <= -816; x++) for (let z = 564; z <= 572; z++) for (let y = 123; y <= 127; y++) {
        if (isDiggableLaneFill({ x, y, z }, 'oak_log')) assert.fail('oak_log diggable');
        assert.ok(protectedAreaAt({ x, y, z }, 'oak_log'), `${x} ${y} ${z}`);
    }
    // outside everything
    assert.equal(protectedAreaAt({ x: -820, y: 124, z: 563 }, 'oak_log'), null);
    assert.equal(protectedAreaAt({ x: -828, y: 124, z: 568 }, 'oak_log'), null);
});

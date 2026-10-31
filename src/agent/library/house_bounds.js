import { getActiveHome, isVerifiedHome } from './bob_home.js';
// House geometry only. No mineflayer import so unit tests can load this
// without node_modules. The dig/pathfinder guard lives in protected_area.js.
// Boxes come from a verified home. With no house, nothing is house-protected.

export const LANE_FILL = new Set([
    'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud', 'dirt_path',
    'gravel', 'sand', 'red_sand', 'snow', 'snow_block', 'netherrack'
]);

export function inBox(pos, box) {
    if (!pos || !box) return false;
    const x = Math.floor(Number(pos.x)), y = Math.floor(Number(pos.y)), z = Math.floor(Number(pos.z));
    if (![x, y, z].every(Number.isFinite)) return false;
    return x >= box.x1 && x <= box.x2
        && y >= box.y1 && y <= box.y2
        && z >= box.z1 && z <= box.z2;
}

export function geometryFromHome(home = getActiveHome()) {
    if (!isVerifiedHome(home) || !home.geometry) {
        return { door: null, area: null, porch: null, walkingLane: null, plateSupport: null };
    }
    return {
        door: home.door,
        area: { name: 'house', ...home.geometry.area },
        porch: { name: 'house-porch', ...home.geometry.porch },
        walkingLane: { name: 'door-lane', ...home.geometry.walkingLane },
        plateSupport: home.plateSupport,
    };
}

export function houseDoor(home = getActiveHome()) { return geometryFromHome(home).door; }
export function houseArea(home = getActiveHome()) { return geometryFromHome(home).area; }
export function housePorch(home = getActiveHome()) { return geometryFromHome(home).porch; }
export function walkingLane(home = getActiveHome()) { return geometryFromHome(home).walkingLane; }
export function plateSupportOf(home = getActiveHome()) { return geometryFromHome(home).plateSupport; }

export function protectedAreas(home = getActiveHome()) {
    const g = geometryFromHome(home);
    const areas = [];
    if (g.area) areas.push(g.area);
    if (g.porch) areas.push(g.porch);
    return areas;
}

export function isWalkingLane(pos, home = getActiveHome()) {
    const lane = walkingLane(home);
    return !!lane && inBox(pos, lane);
}

export function isInsideHouseArea(pos, home = getActiveHome()) {
    const area = houseArea(home);
    return !!area && inBox(pos, area);
}

export function isDiggableLaneFill(pos, blockName, home = getActiveHome()) {
    if (!pos || !isWalkingLane(pos, home) || !LANE_FILL.has(blockName)) return false;
    const support = plateSupportOf(home);
    if (!support) return true;
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    return !(x === support.x && y === support.y && z === support.z);
}

export function protectedAreaAt(pos, blockName = null, home = getActiveHome()) {
    if (!pos || isDiggableLaneFill(pos, blockName, home)) return null;
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    return protectedAreas(home).find((a) =>
        x >= a.x1 && x <= a.x2 && y >= a.y1 && y <= a.y2 && z >= a.z1 && z <= a.z2
    ) || null;
}

// Names used by older callers. These read the active verified home and are
// null/empty when Bob has not yet built one.
export const HOUSE_DOOR = { get x() { return houseDoor()?.x ?? null; }, get y() { return houseDoor()?.y ?? null; }, get z() { return houseDoor()?.z ?? null; } };
export const PLATE_SUPPORT = { get x() { return plateSupportOf()?.x ?? null; }, get y() { return plateSupportOf()?.y ?? null; }, get z() { return plateSupportOf()?.z ?? null; } };
export const HOUSE_AREA = { get name() { return houseArea()?.name ?? null; }, get x1() { return houseArea()?.x1 ?? null; }, get x2() { return houseArea()?.x2 ?? null; }, get y1() { return houseArea()?.y1 ?? null; }, get y2() { return houseArea()?.y2 ?? null; }, get z1() { return houseArea()?.z1 ?? null; }, get z2() { return houseArea()?.z2 ?? null; } };
export const HOUSE_PORCH = { get name() { return housePorch()?.name ?? null; }, get x1() { return housePorch()?.x1 ?? null; }, get x2() { return housePorch()?.x2 ?? null; }, get y1() { return housePorch()?.y1 ?? null; }, get y2() { return housePorch()?.y2 ?? null; }, get z1() { return housePorch()?.z1 ?? null; }, get z2() { return housePorch()?.z2 ?? null; } };
export const WALKING_LANE = { get name() { return walkingLane()?.name ?? null; }, get x1() { return walkingLane()?.x1 ?? null; }, get x2() { return walkingLane()?.x2 ?? null; }, get y1() { return walkingLane()?.y1 ?? null; }, get y2() { return walkingLane()?.y2 ?? null; }, get z1() { return walkingLane()?.z1 ?? null; }, get z2() { return walkingLane()?.z2 ?? null; } };
export const PROTECTED_AREAS = { [Symbol.iterator]: function* () { yield* protectedAreas(); }, map: (fn) => protectedAreas().map(fn) };

import { HOME } from './bob_home.js';
// House / claim geometry only. No mineflayer import so unit tests can load this
// without node_modules. The dig/pathfinder guard lives in protected_area.js.

export const HOUSE_DOOR = HOME.door;
export const HOUSE_AREA = { name: 'house', ...HOME.geometry.area };
export const WALKING_LANE = { name: 'door-lane', ...HOME.geometry.walkingLane };

// [ai-player] nav-on-live-20261026: the porch row in front of the door (z 564..565) holds real house
// blocks: oak_log posts at -823/-821/-819 124 565 beside the outside pressure plate -820 124 565 (seen
// in the .20 log), and the plate's support block -820 123 565. The live guard protected z 564..572, so
// PR #14's box starting at z 566 would have made them breakable. The porch row stays protected; inside
// the walking lane only loose fill (dirt, gravel, sand...) can be dug, so a sealed porch can still be cleared.
export const HOUSE_PORCH = { name: 'house-porch', ...HOME.geometry.porch };
export const PLATE_SUPPORT = HOME.plateSupport;
export const LANE_FILL = new Set([
    'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud', 'dirt_path',
    'gravel', 'sand', 'red_sand', 'snow', 'snow_block', 'netherrack'
]);

export const PROTECTED_AREAS = [HOUSE_AREA, HOUSE_PORCH];

export function inBox(pos, box) {
    if (!pos || !box) return false;
    // nav-on-live-20261026: compare block cells (floor), so an entity standing at -819.5 124 565.5
    // (the door plate, where stuck-home / resets land) counts as cell -820 124 565
    const x = Math.floor(Number(pos.x)), y = Math.floor(Number(pos.y)), z = Math.floor(Number(pos.z));
    if (![x, y, z].every(Number.isFinite)) return false;
    return x >= box.x1 && x <= box.x2
        && y >= box.y1 && y <= box.y2
        && z >= box.z1 && z <= box.z2;
}

export function isWalkingLane(pos) {
    return inBox(pos, WALKING_LANE);
}

export function isInsideHouseArea(pos) {
    return inBox(pos, HOUSE_AREA);
}

// Lane cells are diggable only when the block is known loose fill (blockName given and in LANE_FILL).
// Unknown names (position-only queries) stay protected. The plate support is never diggable.
export function isDiggableLaneFill(pos, blockName) {
    if (!pos || !isWalkingLane(pos) || !LANE_FILL.has(blockName)) return false;
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    return !(x === PLATE_SUPPORT.x && y === PLATE_SUPPORT.y && z === PLATE_SUPPORT.z);
}

export function protectedAreaAt(pos, blockName = null) {
    if (!pos || isDiggableLaneFill(pos, blockName)) return null;
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    return PROTECTED_AREAS.find((a) =>
        x >= a.x1 && x <= a.x2 && y >= a.y1 && y <= a.y2 && z >= a.z1 && z <= a.z2
    ) || null;
}

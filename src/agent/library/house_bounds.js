// House / claim geometry only. No mineflayer import so unit tests can load this
// without node_modules. The dig/pathfinder guard lives in protected_area.js.

export const HOUSE_DOOR = { x: -820, y: 124, z: 566 };
export const HOUSE_AREA = {
    name: 'house',
    x1: -827, x2: -816,
    y1: 123, y2: 127,
    z1: 566, z2: 573
};
export const WALKING_LANE = {
    name: 'door-lane',
    x1: -821, x2: -819,
    y1: 123, y2: 126,
    z1: 564, z2: 565
};

export const PROTECTED_AREAS = [HOUSE_AREA];

export function inBox(pos, box) {
    if (!pos || !box) return false;
    const x = Number(pos.x), y = Number(pos.y), z = Number(pos.z);
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

export function protectedAreaAt(pos) {
    if (!pos || isWalkingLane(pos)) return null;
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    return PROTECTED_AREAS.find((a) =>
        x >= a.x1 && x <= a.x2 && y >= a.y1 && y <= a.y2 && z >= a.z1 && z <= a.z2
    ) || null;
}

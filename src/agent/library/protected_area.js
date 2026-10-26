// [ai-player] Protect Bob's house: no block inside the box may be broken by the bot.
// Two layers: pathfinder/collectBlocks treat these blocks as unbreakable (Movements.safeToBreak), and
// bot.dig refuses them outright as a backstop for any other caller.
//
// House box is aligned with the claim (x -827..-819, z 565..573) plus the built east wall
// (out to x -816). It starts at the door row (z 566), so the walking lane north of the door
// is not protected and destructive pathing can clear a sealed porch. Walls, roof and door stay
// protected. The walking-lane exclusion is also applied explicitly so a later box expansion
// cannot re-protect the exit.
import pf from 'mineflayer-pathfinder';

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

let movementsPatched = false;

export function installProtectedAreaGuard(agent) {
    const bot = agent.bot;
    if (!movementsPatched) {
        const proto = pf.Movements.prototype;
        const origSafeToBreak = proto.safeToBreak;
        proto.safeToBreak = function (block) {
            if (block && protectedAreaAt(block.position)) return false;
            return origSafeToBreak.call(this, block);
        };
        movementsPatched = true;
    }
    if (!bot._aiPlayerDigGuard) {
        const origDig = bot.dig.bind(bot);
        bot.dig = async function (block, ...rest) {
            const area = block && protectedAreaAt(block.position);
            if (area) {
                const p = block.position;
                console.log(`[ai-player] protected-area: refused to break ${block.name} at ${p.x} ${p.y} ${p.z} (${area.name})`);
                throw new Error(`The ${block.name} at ${p.x}, ${p.y}, ${p.z} is part of your ${area.name}; do not break it.`);
            }
            return origDig(block, ...rest);
        };
        bot._aiPlayerDigGuard = true;
    }
    console.log(`[ai-player] protected-area guard on: ${PROTECTED_AREAS.map(a => `${a.name} x ${a.x1}..${a.x2} y ${a.y1}..${a.y2} z ${a.z1}..${a.z2}`).join('; ')}; walking lane x ${WALKING_LANE.x1}..${WALKING_LANE.x2} z ${WALKING_LANE.z1}..${WALKING_LANE.z2} is not protected`);
}

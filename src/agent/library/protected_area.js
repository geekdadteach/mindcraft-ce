// [ai-player] Protect Bob's house: no block inside the box may be broken by the bot.
// Two layers: pathfinder/collectBlocks treat these blocks as unbreakable (Movements.safeToBreak), and
// bot.dig refuses them outright as a backstop for any other caller.
//
// House boxes come from a verified home (door + facing). With no verified home, nothing is
// house-protected. Inside the walking lane only loose fill (dirt, gravel, sand...) may be dug
// so a sealed porch can be cleared without touching house blocks. Walls, roof, door, plate
// and posts stay protected. The retired hilltop is never a protected destination.
import pf from 'mineflayer-pathfinder';
import {
    HOUSE_AREA,
    HOUSE_PORCH,
    LANE_FILL,
    isDiggableLaneFill,
    HOUSE_DOOR,
    PROTECTED_AREAS,
    WALKING_LANE,
    inBox,
    isInsideHouseArea,
    isWalkingLane,
    protectedAreaAt,
    protectedAreas,
    walkingLane
} from './house_bounds.js';

export {
    HOUSE_AREA,
    HOUSE_PORCH,
    LANE_FILL,
    isDiggableLaneFill,
    HOUSE_DOOR,
    PROTECTED_AREAS,
    WALKING_LANE,
    inBox,
    isInsideHouseArea,
    isWalkingLane,
    protectedAreaAt
};

let movementsPatched = false;

export function installProtectedAreaGuard(agent) {
    const bot = agent.bot;
    if (!movementsPatched) {
        const proto = pf.Movements.prototype;
        const origSafeToBreak = proto.safeToBreak;
        proto.safeToBreak = function (block) {
            if (block && protectedAreaAt(block.position, block.name)) return false;
            return origSafeToBreak.call(this, block);
        };
        movementsPatched = true;
    }
    if (!bot._aiPlayerDigGuard) {
        const origDig = bot.dig.bind(bot);
        bot.dig = async function (block, ...rest) {
            const area = block && protectedAreaAt(block.position, block.name);
            if (area) {
                const p = block.position;
                console.log(`[ai-player] protected-area: refused to break ${block.name} at ${p.x} ${p.y} ${p.z} (${area.name})`);
                throw new Error(`The ${block.name} at ${p.x}, ${p.y}, ${p.z} is part of your ${area.name}; do not break it.`);
            }
            return origDig(block, ...rest);
        };
        bot._aiPlayerDigGuard = true;
    }
    const areas = protectedAreas();
    const lane = walkingLane();
    console.log(`[ai-player] protected-area guard on: ${areas.length ? areas.map(a => `${a.name} x ${a.x1}..${a.x2} y ${a.y1}..${a.y2} z ${a.z1}..${a.z2}`).join('; ') : 'no verified house yet'}; walking lane ${lane ? `x ${lane.x1}..${lane.x2} z ${lane.z1}..${lane.z2}: loose fill only (${[...LANE_FILL].slice(0, 4).join('/')}...)` : 'none'}`);
}

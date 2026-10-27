// [ai-player] Protect Bob's house: no block inside the box may be broken by the bot.
// Two layers: pathfinder/collectBlocks treat these blocks as unbreakable (Movements.safeToBreak), and
// bot.dig refuses them outright as a backstop for any other caller.
//
// House box is aligned with the claim (x -827..-819, z 565..573) plus the built east wall
// (out to x -816), door row z 566. The porch row z 564..565 (oak_log posts, outside pressure plate and
// its support) is protected too; inside the walking lane x -821..-819 z 564..565 only loose fill
// (dirt, gravel, sand...) may be dug, so destructive pathing can clear a sealed porch without
// touching house blocks. Walls, roof, door, plate and posts stay protected.
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
    protectedAreaAt
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
    console.log(`[ai-player] protected-area guard on: ${PROTECTED_AREAS.map(a => `${a.name} x ${a.x1}..${a.x2} y ${a.y1}..${a.y2} z ${a.z1}..${a.z2}`).join('; ')}; walking lane x ${WALKING_LANE.x1}..${WALKING_LANE.x2} z ${WALKING_LANE.z1}..${WALKING_LANE.z2}: loose fill only (${[...LANE_FILL].slice(0, 4).join('/')}...)`);
}

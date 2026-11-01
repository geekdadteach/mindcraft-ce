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
import { getActiveHome } from './bob_home.js';

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

// [ai-player] Bed protection: never let Bob break his own bed. A bed is a *_bed block within 2
// blocks of a known bed: the active home's bed, the last bed he slept in, and the claim bed -1144 68 752.
export const BOB_BED = Object.freeze({ x: -1144, y: 68, z: 752 });
export const BED_PROTECT_RANGE = 2;
let _lastSleptBed = null;

// ON by default; only BOB_PROTECT_BED=0 turns it off.
export function bedProtectEnabled(env = process.env) {
    return env?.BOB_PROTECT_BED !== '0';
}

export function recordSleptBed(pos) {
    if (pos && [pos.x, pos.y, pos.z].every(Number.isFinite)) {
        _lastSleptBed = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    }
    return _lastSleptBed;
}
export function lastSleptBed() { return _lastSleptBed; }

export function knownBeds() {
    const out = [BOB_BED];
    const homeBed = getActiveHome()?.bed;
    if (homeBed && [homeBed.x, homeBed.y, homeBed.z].every(Number.isFinite)) out.push(homeBed);
    if (_lastSleptBed) out.push(_lastSleptBed);
    return out;
}

// The bed this block belongs to, or null. Only *_bed blocks within BED_PROTECT_RANGE of a known bed count.
export function ownBedAt(pos, blockName, { env = process.env } = {}) {
    if (!bedProtectEnabled(env)) return null;
    if (!pos || !/_bed$/.test(String(blockName || ''))) return null;
    for (const bed of knownBeds()) {
        const d = Math.hypot(Number(pos.x) - bed.x, Number(pos.y) - bed.y, Number(pos.z) - bed.z);
        if (Number.isFinite(d) && d <= BED_PROTECT_RANGE) return { name: 'your bed', bed };
    }
    return null;
}

let movementsPatched = false;

export function installProtectedAreaGuard(agent) {
    const bot = agent.bot;
    if (!movementsPatched) {
        const proto = pf.Movements.prototype;
        const origSafeToBreak = proto.safeToBreak;
        proto.safeToBreak = function (block) {
            if (block && protectedAreaAt(block.position, block.name)) return false;
            if (block && ownBedAt(block.position, block.name)) return false; // [ai-player] own bed is never diggable
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
            const bed = block && ownBedAt(block.position, block.name);
            if (bed) {
                const p = block.position;
                console.log(`[ai-player] protect-bed: refused to break ${block.name} at ${p.x} ${p.y} ${p.z} (your bed)`);
                throw new Error(`The ${block.name} at ${p.x}, ${p.y}, ${p.z} is your bed; do not break it.`);
            }
            return origDig(block, ...rest);
        };
        bot._aiPlayerDigGuard = true;
    }
    const areas = protectedAreas();
    const lane = walkingLane();
    console.log(`[ai-player] protected-area guard on: ${areas.length ? areas.map(a => `${a.name} x ${a.x1}..${a.x2} y ${a.y1}..${a.y2} z ${a.z1}..${a.z2}`).join('; ') : 'no verified house yet'}; walking lane ${lane ? `x ${lane.x1}..${lane.x2} z ${lane.z1}..${lane.z2}: loose fill only (${[...LANE_FILL].slice(0, 4).join('/')}...)` : 'none'}`);
}

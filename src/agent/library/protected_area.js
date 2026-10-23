// [ai-player] Protect Bob's house: no block inside the box may be broken by the bot.
// Two layers: pathfinder/collectBlocks treat these blocks as unbreakable (Movements.safeToBreak), and
// bot.dig refuses them outright as a backstop for any other caller.
import pf from 'mineflayer-pathfinder';

export const PROTECTED_AREAS = [
    { name: 'house', x1: -824, x2: -816, y1: 123, y2: 127, z1: 564, z2: 572 },
];

export function protectedAreaAt(pos) {
    if (!pos) return null;
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    return PROTECTED_AREAS.find(a => x >= a.x1 && x <= a.x2 && y >= a.y1 && y <= a.y2 && z >= a.z1 && z <= a.z2) || null;
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
    console.log(`[ai-player] protected-area guard on: ${PROTECTED_AREAS.map(a => `${a.name} x ${a.x1}..${a.x2} y ${a.y1}..${a.y2} z ${a.z1}..${a.z2}`).join('; ')}`);
}

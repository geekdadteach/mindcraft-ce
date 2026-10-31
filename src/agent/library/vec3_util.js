// prismarine-world's blockAt calls pos.floored(). Plain {x,y,z} throws in loaded
// chunks and returns null otherwise. Always pass a Vec3.
import Vec3 from 'vec3';

export function isVec3Like(p) {
    return !!(p && typeof p.floored === 'function'
        && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
}

export function vec3(x, y, z) {
    if (isVec3Like(x) && y == null) return x;
    if (x && typeof x === 'object' && Number.isFinite(x.x) && y == null)
        return new Vec3(x.x, x.y ?? 0, x.z ?? 0);
    const vx = Number(x), vy = Number(y), vz = Number(z);
    if (![vx, vy, vz].every(Number.isFinite)) return null;
    return new Vec3(vx, vy, vz);
}

export function botBlockAt(bot, x, y, z) {
    if (!bot?.blockAt) return null;
    const p = vec3(x, y, z);
    if (!p) return null;
    return bot.blockAt(p);
}

export function botGetBlock(bot) {
    return (x, y, z) => botBlockAt(bot, x, y, z);
}

// Test helper: a mineflayer-like blockAt that rejects plain objects the way
// prismarine-world does (pos.floored() is required).
export function strictBlockAt(impl) {
    return (pos) => {
        if (!isVec3Like(pos)) {
            const kind = pos && typeof pos === 'object' ? 'plain object' : typeof pos;
            throw new TypeError(`blockAt requires a Vec3 with .floored(); got ${kind}`);
        }
        const p = pos.floored();
        return impl(p.x, p.y, p.z, p);
    };
}

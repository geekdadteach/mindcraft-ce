// [ai-player] Fix 1e — emergency night shelter.
//
// Bob's night mode goes home and sleeps only when BOB_NIGHT_HOME=1 and there is a verified house.
// With no bed to reach he used to stand in the open and get killed (report 4.1: 15 deaths, all at
// night, at his base). This module is the fallback: at night, with hostiles within 12 blocks or
// health <= 10, and no verified home bed, seal up (wall in with a held dirt/cobble block) or dig a
// 1x2 pocket down. It is ON by default; BOB_NIGHT_SHELTER=0 disables it.
//
// It never breaks or places a block inside a protected house area (house_bounds) or a no-go zone
// (no_go_zones), and never throws — the model still decides what Bob does; this only keeps him alive.
import Vec3 from 'vec3';
import * as mc from '../../utils/mcdata.js';
import * as skills from './skills.js';
import { getActiveHome, isVerifiedHome } from './bob_home.js';
import { isNightTime } from './ai_player_nav.js';
import { protectedAreaAt } from './house_bounds.js';
import { zoneAt } from './no_go_zones.js';

export const SHELTER_HOSTILE_RANGE = 12;
export const SHELTER_LOW_HEALTH = 10;

// Blocks Bob may wall himself in with: plain dirt and cobble families, no crafted or built blocks
// (never a plank/log/door/chest — those are somebody's build and are also in KEEP_BLOCKS elsewhere).
export const SHELTER_SEAL_BLOCKS = new Set([
    'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'mud',
    'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite',
    'granite', 'tuff', 'netherrack', 'sand', 'red_sand', 'gravel', 'clay'
]);

// ON by default; only an explicit BOB_NIGHT_SHELTER=0 turns it off.
export function shelterEnabled(env = process.env) {
    return env?.BOB_NIGHT_SHELTER !== '0';
}

// A verified home always carries a bed (bob_home.isVerifiedHome requires one), so a verified home
// means there is a bed to reach and the shelter is not the fallback.
export function hasVerifiedBed(bot, home = getActiveHome()) {
    return isVerifiedHome(home);
}

// Nearest mob that is actually a threat to Bob right now (neutral mobs only if they just hit him).
export function nearestHostile(bot, range = SHELTER_HOSTILE_RANGE) {
    const p = bot?.entity?.position;
    if (!p || typeof p.distanceTo !== 'function') return null;
    let best = null, bestD = range;
    for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || !e.position) continue;
        if (!mc.isAggressiveHostile(e)) continue;
        const d = p.distanceTo(e.position);
        if (d < bestD) { best = e; bestD = d; }
    }
    return best;
}

// Why Bob should shelter right now, or null. 'hostiles' | 'low-health' | null.
export function shelterReason(bot, { env = process.env, now = Date.now() } = {}) {
    if (!shelterEnabled(env)) return null;
    if (!bot?.entity?.position) return null;
    if (hasVerifiedBed(bot)) return null;
    if (!isNightTime(bot)) return null;
    if (nearestHostile(bot)) return 'hostiles';
    if (Number.isFinite(bot.health) && bot.health <= SHELTER_LOW_HEALTH) return 'low-health';
    return null;
}

export function shouldShelter(bot, opts = {}) {
    return shelterReason(bot, opts) !== null;
}

// A position is off-limits if it is inside the protected house box or a no-go zone. The lookups are
// injectable so tests can exercise the protection rule without a live world.
export function blockedForShelter(pos, blockName = null, { protectedAt = protectedAreaAt, zone = zoneAt } = {}) {
    if (!pos) return true;
    try { if (protectedAt(pos, blockName)) return true; } catch (_) {}
    try { if (zone(pos.x, pos.z)) return true; } catch (_) {}
    return false;
}

// The first held block Bob can seal with, or null.
export function sealBlockName(bot) {
    try {
        const held = bot.inventory.items().find(i => SHELTER_SEAL_BLOCKS.has(i.name));
        return held ? held.name : null;
    } catch (_) { return null; }
}

// Positions to fill: the four horizontal neighbours at feet and head height, plus the block above
// the head. Already-solid spots count as filled and are skipped by the caller.
export function sealSpots(base) {
    const { x, y, z } = base;
    const spots = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        spots.push({ x: x + dx, y, z: z + dz });
        spots.push({ x: x + dx, y: y + 1, z: z + dz });
    }
    spots.push({ x, y: y + 2, z });
    return spots;
}

function baseOf(bot) {
    const p = bot?.entity?.position;
    if (!p) return null;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function isSolid(bot, pos) {
    try {
        const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
        return !!(b && b.boundingBox === 'block');
    } catch (_) { return true; } // unknown: treat as solid so we never touch it
}

// Wall in with the held seal block. Returns true once at least two spots are filled.
export async function wallIn(bot, seal = sealBlockName(bot)) {
    const base = baseOf(bot);
    if (!base || !seal) return false;
    let filled = 0;
    for (const spot of sealSpots(base)) {
        if (bot.interrupt_code) break;
        if (isSolid(bot, spot)) { filled++; continue; }
        if (blockedForShelter(spot, seal)) continue;
        try {
            if (await skills.placeBlock(bot, seal, spot.x, spot.y, spot.z, 'side')) filled++;
        } catch (_) { /* placement is best-effort */ }
    }
    return filled >= 2;
}

// Fallback when Bob holds nothing to seal with: dig a 1x2 pocket down and cap the top if we can.
export async function digPocket(bot, seal = sealBlockName(bot)) {
    const base = baseOf(bot);
    if (!base) return false;
    let dug = 0;
    for (const spot of [{ x: base.x, y: base.y - 1, z: base.z }, { x: base.x, y: base.y - 2, z: base.z }]) {
        if (bot.interrupt_code) break;
        if (!isSolid(bot, spot)) { dug++; continue; }
        if (blockedForShelter(spot, null)) continue;
        try { await bot.dig(bot.blockAt(new Vec3(spot.x, spot.y, spot.z))); dug++; } catch (_) {}
    }
    if (dug < 1) return false;
    const cap = { x: base.x, y: base.y, z: base.z };
    if (seal && !blockedForShelter(cap, seal)) {
        try { await skills.placeBlock(bot, seal, cap.x, cap.y, cap.z, 'bottom'); } catch (_) {}
    }
    return true;
}

// The whole shelter step: no-op unless shelterReason says so, then wall in (preferred) or dig down.
export async function buildShelter(bot, opts = {}) {
    if (!shouldShelter(bot, opts)) return false;
    const seal = sealBlockName(bot);
    if (seal && await wallIn(bot, seal)) return true;
    return await digPocket(bot, seal);
}

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
import pf from 'mineflayer-pathfinder';
import * as mc from '../../utils/mcdata.js';
import * as skills from './skills.js';
import { getActiveHome, isVerifiedHome } from './bob_home.js';
import { isNightTime } from './ai_player_nav.js';
import { protectedAreaAt } from './house_bounds.js';
import { zoneAt } from './no_go_zones.js';
import { shelterState, isSheltered, markSheltered, clearShelter } from './shelter_state.js';

export const SHELTER_HOSTILE_RANGE = 12;
export const SHELTER_LOW_HEALTH = 10;

// Blocks Bob may wall himself in with: plain dirt and cobble families, no crafted or built blocks
// (never a plank/log/door/chest — those are somebody's build and are also in KEEP_BLOCKS elsewhere).
export const SHELTER_SEAL_BLOCKS = new Set([
    'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'mud',
    'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite',
    'granite', 'tuff', 'netherrack', 'sand', 'red_sand', 'gravel', 'clay'
]);

// How far a mob must be to count as "inside the box with him" while sheltered.
export const SHELTER_INSIDE_RANGE = 2;

// Commands that would take Bob out of the shelter. Eating and harmless control are never here.
export const SHELTER_TRAVEL_COMMANDS = new Set([
    '!searchForEntity', '!searchForBlock', '!searchForBlocks', '!collectBlocks', '!collectBlock',
    '!gatherWood', '!getFood', '!moveAway', '!followPlayer',
    '!goToCoordinates', '!goToPlayer', '!goToRememberedPlace', '!goToSurface',
    '!goToNearestBlock', '!goToNearestEntity', '!goToDefault', '!goToBed', '!goHome',
]);
// Never blocked while sheltered: eating (must always work) and harmless control commands.
export const SHELTER_ALLOWED_COMMANDS = new Set([
    '!consume', '!eat', '!stop', '!stfu', '!stay', '!inventory', '!stats', '!health',
]);

// The shelter state lives in its own leaf module (shelter_state.js) so movement code can read it
// without importing this heavier module. Re-exported here for the existing callers.
export { shelterState, isSheltered, markSheltered, clearShelter };

// [ai-player] Fix 1e round 2: while sealed in, no pathfinding may dig (that would tunnel Bob out of the
// shelter). shelterMovements() is the testable core; installShelterMovementGuard() applies it to every
// pf.Movements (same monkey-patch pattern as installProtectedAreaGuard in protected_area.js).
export function shelterMovements(m) {
    if (isSheltered() && m && typeof m === 'object') m.canDig = false;
    return m;
}

let movementsGuarded = false;
export function installShelterMovementGuard() {
    if (movementsGuarded || typeof pf?.Movements !== 'function') return false;
    const Orig = pf.Movements;
    const Guarded = function (bot, ...rest) { return shelterMovements(new Orig(bot, ...rest)); };
    Guarded.prototype = Orig.prototype;
    Object.setPrototypeOf(Guarded, Orig);
    pf.Movements = Guarded;
    movementsGuarded = true;
    return true;
}

// True when Bob holds at least one edible item.
export function hasEdibleFood(bot) {
    try {
        const foods = bot?.registry?.foodsByName;
        const items = bot?.inventory?.items?.() || [];
        if (foods) return items.some(i => i && i.name in foods);
        return items.some(i => /^(bread|apple|golden_apple|cooked_|carrot|potato|baked_potato|beetroot|sweet_berries|melon_slice|dried_kelp|mutton|beef|porkchop|chicken|rabbit|cod|salmon|spider_eye|rotten_flesh)/.test(String(i?.name || '')));
    } catch (_) { return false; }
}

// [ai-player] Fix 1e round 2: eating must never be blocked. If Bob is starving with nothing to eat, the
// shelter ends early so !getFood can run (his food chest sits by the bed at -1143 68 752).
export function shouldLeaveEarlyForFood(bot) {
    if (!isSheltered()) return false;
    if (!Number.isFinite(bot?.food) || bot.food > 6) return false;
    return !hasEdibleFood(bot);
}

// True when the shelter was built in a different dimension than Bob is in now (portal / respawn).
export function dimensionChanged(bot) {
    const s = shelterState();
    if (!s || s.dimension == null) return false;
    const now = bot?.game?.dimension;
    return now != null && now !== s.dimension;
}


// Guard model commands while sheltered: travel commands are refused, eating is always allowed.
export function shelterGuard(commandName) {
    if (!isSheltered()) return null;
    const cmd = String(commandName || '');
    if (!cmd || SHELTER_ALLOWED_COMMANDS.has(cmd)) return null;
    if (SHELTER_TRAVEL_COMMANDS.has(cmd) || /^!goTo/i.test(cmd) || /^!searchFor/i.test(cmd) || /^!collect/i.test(cmd)) {
        return 'SHELTERED: you are sealed in your night shelter until dawn. Do not travel or try to leave; wait it out. ' +
            'You may eat from your inventory with !consume("item").';
    }
    return null;
}

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
export async function wallIn(bot, seal = sealBlockName(bot), record = {}) {
    const placed = record.placed || (record.placed = []);
    const base = baseOf(bot);
    if (!base || !seal) return false;
    let filled = 0;
    for (const spot of sealSpots(base)) {
        if (bot.interrupt_code) break;
        if (isSolid(bot, spot)) { filled++; continue; }
        if (blockedForShelter(spot, seal)) continue;
        try {
            if (await skills.placeBlock(bot, seal, spot.x, spot.y, spot.z, 'side')) {
                filled++;
                placed.push({ x: spot.x, y: spot.y, z: spot.z, name: seal });
            }
        } catch (_) { /* placement is best-effort */ }
    }
    return filled >= 2;
}

// Fallback when Bob holds nothing to seal with: dig a 1x2 pocket down and cap the top if we can.
export async function digPocket(bot, seal = sealBlockName(bot), record = {}) {
    const dug = record.dug || (record.dug = []);
    const placed = record.placed || (record.placed = []);
    const base = baseOf(bot);
    if (!base) return false;
    let count = 0;
    for (const spot of [{ x: base.x, y: base.y - 1, z: base.z }, { x: base.x, y: base.y - 2, z: base.z }]) {
        if (bot.interrupt_code) break;
        if (!isSolid(bot, spot)) { count++; continue; }
        if (blockedForShelter(spot, null)) continue;
        try {
            await bot.dig(bot.blockAt(new Vec3(spot.x, spot.y, spot.z)));
            count++;
            dug.push({ x: spot.x, y: spot.y, z: spot.z });
        } catch (_) {}
    }
    if (count < 1) return false;
    const cap = { x: base.x, y: base.y, z: base.z };
    if (seal && !blockedForShelter(cap, seal)) {
        try {
            if (await skills.placeBlock(bot, seal, cap.x, cap.y, cap.z, 'bottom'))
                placed.push({ x: cap.x, y: cap.y, z: cap.z, name: seal });
        } catch (_) {}
    }
    return true;
}

// ---- Dawn exit ----

// Only the blocks the shelter itself placed may be dug back. A cell that no longer holds the block we
// put there (someone built over it, or it is gone) is left alone.
export function placedBlocksToDig(bot, placed = []) {
    const out = [];
    for (const p of placed) {
        try {
            const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
            if (b && String(b.name) === p.name) out.push({ pos: p, block: b });
        } catch (_) {}
    }
    return out;
}

// Dug pocket cells to fill back in: only when Bob still holds a seal block and the cell is empty.
export function pocketCellsToRefill(bot, dug = []) {
    if (!sealBlockName(bot)) return [];
    const out = [];
    for (const p of dug) {
        try {
            const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
            if (b && b.boundingBox === 'empty') out.push(p);
        } catch (_) {}
    }
    return out;
}

async function recover(bot, placed, dug) {
    let removed = 0;
    for (const { block } of placedBlocksToDig(bot, placed)) {
        if (bot.interrupt_code) break;
        try { await bot.dig(block); removed++; } catch (_) {}
    }
    const seal = sealBlockName(bot);
    if (seal) {
        for (const p of pocketCellsToRefill(bot, dug)) {
            if (bot.interrupt_code) break;
            try { await skills.placeBlock(bot, seal, p.x, p.y, p.z, 'bottom'); } catch (_) {}
        }
    }
    return removed;
}

// At dawn: dig back the blocks the shelter placed (to collect them), refill a dug pocket if a seal
// block is held, and clear the shelter state. Never digs a block the shelter did not place.
export async function dawnExit(bot) {
    const s = shelterState();
    if (!s) return false;
    const removed = await recover(bot, s.placed, s.dug);
    clearShelter();
    console.log(`[ai-player] shelter: packed up (${removed}/${s.placed.length} placed blocks recovered, ${s.dug.length} pocket cell(s))`);
    return true;
}

// The whole shelter step: no-op unless shelterReason says so, then wall in (preferred) or dig down.
// On success Bob is marked sheltered until dawn.
export async function buildShelter(bot, opts = {}) {
    if (!shouldShelter(bot, opts)) return false;
    const seal = sealBlockName(bot);
    const record = { placed: [], dug: [] };
    let ok = false;
    if (seal && await wallIn(bot, seal, record)) ok = true;
    else ok = await digPocket(bot, seal, record);
    if (!ok) { await recover(bot, record.placed, record.dug); return false; } // no stray blocks from a failed attempt
    markSheltered({ day: bot.time?.day ?? null, dimension: bot.game?.dimension ?? null, placed: record.placed, dug: record.dug });
    console.log(`[ai-player] shelter: sealed in for the night (placed ${record.placed.length}, dug ${record.dug.length})`);
    return true;
}

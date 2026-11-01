import { getActiveHome, isVerifiedHome } from './bob_home.js';
// [ai-player] Oct 20: navigation helpers for Bob (MineBobNE): surface before tree searches, and going home at night.
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import * as skills from './skills.js';
import { isInsideHouseArea } from './house_bounds.js';
import { EXIT_WAYPOINT, exitWaypoint } from './bob_enclosure.js';
import { navConsole } from './bob_nav_memory.js';
import { isSheltered } from './shelter_state.js';

export function houseEntrance(home = getActiveHome()) { return isVerifiedHome(home) ? home.entrance : null; }
export function houseInside(home = getActiveHome()) { return isVerifiedHome(home) ? home.inside : null; }
export function houseBedHint(home = getActiveHome()) { return isVerifiedHome(home) ? home.bed : null; }
export const HOUSE_ENTRANCE = { get x() { return houseEntrance()?.x; }, get y() { return houseEntrance()?.y; }, get z() { return houseEntrance()?.z; } };
export const HOUSE_INSIDE = { get x() { return houseInside()?.x; }, get y() { return houseInside()?.y; }, get z() { return houseInside()?.z; } };
export const HOUSE_BED_HINT = { get x() { return houseBedHint()?.x; }, get y() { return houseBedHint()?.y; }, get z() { return houseBedHint()?.z; } };
export { EXIT_WAYPOINT, isInsideHouseArea };
// never dig through anything that looks built (house, chests, beds, doors)
export const KEEP_BLOCKS = /planks|_log$|_wood$|door|stairs|slab|glass|carpet|_bed$|chest|furnace|crafting_table|fence|torch|wool|banner|lantern|pressure_plate/;
const SEE_THROUGH = /^(air|cave_air|void_air|water|lava)$|leaves|vine|glass|torch|_carpet$|^short_grass$|^tall_grass$|^snow$|moss_carpet|glow_lichen|spore_blossom|azalea|dripleaf|cave_vines|hanging_roots/;

function newMovements(bot) {
    try {
        return new pf.Movements(bot);
    } catch {
        // Unit tests (and a bot without a loaded registry) still need a movements object.
        return {
            canDig: false,
            allow1by1towers: false,
            allowParkour: false,
            allowSprinting: false,
            canOpenDoors: true,
            maxDropDown: 1,
            blocksCantBreak: new Set(),
        };
    }
}

export function escapeMovements(bot) {
    const m = newMovements(bot);
    m.canDig = true;
    m.allow1by1towers = true;
    m.allowParkour = false;
    m.allowSprinting = false;
    if (bot.health <= 4) m.maxDropDown = 2;
    for (const b of bot.registry?.blocksArray || []) if (KEEP_BLOCKS.test(b.name)) m.blocksCantBreak.add(b.id);
    if (isSheltered()) m.canDig = false; // [ai-player] Fix 1e: never dig Bob out of the night shelter
    return m;
}

export function walkMovements(bot) {
    const m = newMovements(bot);
    m.canDig = false;
    m.allowParkour = false;
    m.canOpenDoors = true;
    return m;
}

export async function gotoWithin(bot, goal, ms, movements = null) {
    bot.pathfinder.setMovements(movements || escapeMovements(bot));
    let timer;
    const ok = await Promise.race([
        bot.pathfinder.goto(goal).then(() => true, (e) => { navConsole(`path: ${e.message}`); return false; }),
        new Promise(r => { timer = setTimeout(() => r(false), ms); }),
    ]);
    clearTimeout(timer);
    if (!ok) { try { bot.pathfinder.stop(); } catch (e) {} }
    return ok;
}

export function homeDistance(bot, home = getActiveHome()) {
    const p = bot?.entity?.position;
    const e = houseEntrance(home);
    if (!p || !e) return Infinity;
    return Math.hypot(p.x - e.x, p.z - e.z);
}

// Underground = natural solid blocks (stone, dirt...) somewhere above the head, and little sky light.
// Leaves, glass and built blocks (the house roof) do not count as cover.
export function skyCheck(bot) {
    const p = bot.entity.position.floored();
    const head = bot.blockAt(p.offset(0, 1, 0));
    const sky = head?.skyLight;
    let cover = null, built = false;
    for (let y = p.y + 2; y <= Math.min(319, p.y + 96); y++) {
        const b = bot.blockAt(new Vec3(p.x, y, p.z));
        if (!b) break;
        if (SEE_THROUGH.test(b.name)) continue;
        if (KEEP_BLOCKS.test(b.name)) { built = true; continue; }
        cover = b; break;
    }
    const underground = !!cover && !(sky >= 12);
    return { underground, sky, cover: cover ? `${cover.name}@y${cover.position.y}` : null, built, pos: p };
}

export function isUnderground(bot) { return skyCheck(bot).underground; }

function surfaceTarget(bot) {
    const pos = bot.entity.position;
    for (let y = Math.min(319, Math.floor(pos.y) + 96); y > pos.y + 1; y--) {
        const b = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!b || SEE_THROUGH.test(b.name) || /_log$|_wood$/.test(b.name)) continue; // skip trees and air
        if (KEEP_BLOCKS.test(b.name)) return null; // under a build: don't tunnel up into it
        return new Vec3(Math.floor(pos.x), y + 1, Math.floor(pos.z));
    }
    return null;
}

const WOOD_RE = /_(log|wood)$/;
// pr20-reconciled-20261027: helpers for the no-home surface fallback (exported for tests).
export function surfaceFallbackGoal(t) { return t ? new pf.goals.GoalNear(t.x, t.y, t.z, 2) : null; }
export function surfaceFailNote(at, type) {
    return `Navigation failed: could not get up to the surface from ${at.x} ${at.y} ${at.z}, so the ${type} search here is abandoned. Do not retry the same route; choose a different objective or a different reachable place to get wood, wherever it is safe and permitted.`;
}
const SURFACE_COOLDOWN_MS = 3 * 60e3;

// Fix 1: before !collectBlocks / !searchForBlock on a *_log or *_wood while underground, go up first.
// Returns true to go on with the search, false if Bob could not get out (the search is skipped once).
export async function surfaceForWood(agent, type) {
    const bot = agent.bot;
    if (!WOOD_RE.test(String(type || ''))) return true;
    const chk = skyCheck(bot);
    if (!chk.underground) return true;
    const now = Date.now();
    if (agent.surface_wood_until && now < agent.surface_wood_until) {
        console.log(`[ai-player] surface-for-wood: underground at ${chk.pos} but tried ${Math.round((now - agent.surface_wood_last) / 1000)}s ago; searching from here`);
        return true;
    }
    agent.surface_wood_until = now + SURFACE_COOLDOWN_MS;
    agent.surface_wood_last = now;
    console.log(`[ai-player] surface-for-wood: underground at ${chk.pos} (cover=${chk.cover} sky=${chk.sky}); going up before ${type} search`);
    skills.log(bot, `You are underground; going up to the surface first to look for ${type}.`);
    let where = null;
    const t = surfaceTarget(bot);
    // [ai-player] item 3: climb out step by step (escape.js) instead of one long goto to a far surface block
    const up = agent.escape?.up ? await agent.escape.up(agent, { reason: 'wood', maxMs: 60000 }) : { ok: false };
    if (up.ok && !isUnderground(bot)) where = 'the surface';
    // pr20-reconciled-20261027: the house is never the fallback. One bounded, progress-checked goto to the open
    // surface block above (gotoChecked blacklists the route after it fails twice); if that fails too, report the
    // navigation failure, record it, and abandon this wood objective so the model picks another activity.
    const surf = surfaceFallbackGoal(t);
    if (!where && !bot.interrupt_code && surf && agent.escape?.gotoChecked &&
        await agent.escape.gotoChecked(agent, surf, { ms: 45000, label: 'surface-for-wood surface' }) && !isUnderground(bot)) where = 'the surface';
    const at = bot.entity.position.floored();
    console.log(`[ai-player] surface-for-wood: ${where ? 'reached ' + where : 'could not get out; abandoning this ' + type + ' search (no home fallback)'} (target=${t}); now at ${at}`);
    if (!where) {
        try { agent.failures?.record(`surface-for-wood:${type}`, 'surface', at, 'could not reach the surface'); } catch (_) {}
        skills.log(bot, surfaceFailNote(at, type));
        return false;
    }
    skills.log(bot, `Reached ${where} at ${at.x} ${at.y} ${at.z}; now searching for ${type}.`);
    return true;
}

// ---- Fix 2: night -> home -> bed ----

// [ai-player] 2026-11-01: normalised time of day (0..23999), or null when the world time is unknown.
export function timeOfDay(bot) {
    const t = bot?.time?.timeOfDay;
    if (t == null || !Number.isFinite(Number(t))) return null;
    return ((Number(t) % 24000) + 24000) % 24000;
}

export function isNightTime(bot) {
    const tod = timeOfDay(bot);
    if (tod == null) return false;
    return (tod >= 12542 && tod <= 23460) || (bot.thunderState ?? 0) > 0;
}

export function isInsideHouse(bot, home = getActiveHome()) {
    if (!isVerifiedHome(home) || !home.indoor) return false;
    const p = bot?.entity?.position;
    if (!p) return false;
    const a = home.indoor;
    return p.z >= a.z1 && p.z <= a.z2 && p.x >= a.x1 && p.x <= a.x2 && p.y >= a.y1 && p.y <= a.y2;
}

export function findHomeBed(bot, home = getActiveHome()) {
    const hintPos = houseBedHint(home);
    if (!hintPos || !bot?.findBlocks) return null;
    const hint = new Vec3(hintPos.x, hintPos.y, hintPos.z);
    const beds = bot.findBlocks({ matching: (b) => b && /_bed$/.test(b.name), maxDistance: 32, count: 8, point: hint })
        .filter(p => p.distanceTo(hint) <= 6);
    return beds.length ? bot.blockAt(beds[0]) : null;
}

// Walk home and in through the door. Returns true when inside. No-ops without a verified house.
export async function goHomeInside(bot, home = getActiveHome()) {
    if (!isVerifiedHome(home)) return false;
    if (isInsideHouse(bot, home)) return true;
    const E = houseEntrance(home), I = houseInside(home);
    if (!E || !I) return false;
    const nearE = bot.entity.position.distanceTo(new Vec3(E.x, E.y, E.z)) <= 2;
    if (!nearE) {
        const under = isUnderground(bot);
        const goal = new pf.goals.GoalNear(E.x, E.y, E.z, 1);
        console.log(`[ai-player] night: heading for the outside plate ${under ? '(underground: dig-out route)' : '(walking)'}`);
        let ok = await gotoWithin(bot, goal, 60000, under ? null : walkMovements(bot));
        if (!ok && !bot.interrupt_code) ok = await gotoWithin(bot, goal, 50000, under ? walkMovements(bot) : null);
        if (!ok) return false;
    }
    if (bot.interrupt_code) return false;
    await gotoWithin(bot, new pf.goals.GoalBlock(Math.floor(I.x), I.y, Math.floor(I.z)), 20000, walkMovements(bot));
    return isInsideHouse(bot, home);
}

// One scripted walk through the door to a waypoint a few blocks north of the porch.
// Walking first (doors already work); if the porch is sealed, one destructive attempt
// that can dig the walking lane but not walls, roof or the door.
export async function tryScriptedHouseExit(bot, home = getActiveHome()) {
    const from = bot?.entity?.position;
    if (!from) return { ok: false, reason: 'no_position' };
    if (!isVerifiedHome(home)) return { ok: true, reason: 'no_verified_home' };
    if (!isInsideHouseArea(from, home) && !isInsideHouse(bot, home))
        return { ok: true, reason: 'already_outside' };

    const W = exitWaypoint(home);
    const E = houseEntrance(home), I = houseInside(home);
    if (!W || !E || !I) return { ok: false, reason: 'no_verified_home' };
    navConsole(`enclosure: scripted exit through the door toward ${W.x} ${W.y} ${W.z}`);
    skills.log(bot, `Trying a scripted exit through the front door to ${W.x} ${W.y} ${W.z}.`);

    if (bot.interrupt_code) return { ok: false, reason: 'interrupted' };

    await gotoWithin(
        bot,
        new pf.goals.GoalNear(I.x, I.y, I.z, 1),
        15000,
        walkMovements(bot)
    );
    if (bot.interrupt_code) return { ok: false, reason: 'interrupted' };

    let ok = await gotoWithin(
        bot,
        new pf.goals.GoalNear(E.x, E.y, E.z, 1),
        20000,
        walkMovements(bot)
    );
    if (!ok && !bot.interrupt_code) {
        ok = await gotoWithin(
            bot,
            new pf.goals.GoalNear(W.x, W.y, W.z, 1),
            25000,
            escapeMovements(bot)
        );
    }
    if ((ok || bot.entity.position.distanceTo(new Vec3(E.x, E.y, E.z)) <= 2) && !bot.interrupt_code) {
        ok = await gotoWithin(
            bot,
            new pf.goals.GoalNear(W.x, W.y, W.z, 1),
            15000,
            walkMovements(bot)
        ) || ok;
    }

    const outside = !isInsideHouse(bot, home) && !isInsideHouseArea(bot.entity.position, home);
    if (outside) {
        navConsole(`enclosure: scripted exit reached ${bot.entity.position.floored()}`);
        skills.log(bot, `Exited through the door to ${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.y)} ${Math.floor(bot.entity.position.z)}. Do not retry the original unreachable target.`);
        return { ok: true, reason: 'exited' };
    }
    navConsole('enclosure: scripted exit failed; still inside. reset is last resort only');
    skills.log(bot, 'Scripted house exit failed. Do not keep retrying outside coordinates. A reset is last resort if a player cannot clear the exit.');
    return { ok: false, reason: 'blocked' };
}

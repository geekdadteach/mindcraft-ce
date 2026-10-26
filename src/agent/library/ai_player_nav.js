// [ai-player] Oct 20: navigation helpers for Bob (MineBobNE): surface before tree searches, and going home at night.
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import * as skills from './skills.js';
import { isInsideHouseArea } from './house_bounds.js';
import { EXIT_WAYPOINT } from './bob_enclosure.js';
import { navConsole } from './bob_nav_memory.js';

export const HOUSE_ENTRANCE = { x: -819.5, y: 124, z: 565.5 }; // on the outside plate, north of the door
export const HOUSE_INSIDE = { x: -819.5, y: 124, z: 567.5 };   // on the inside plate, south of the door
export const HOUSE_BED_HINT = { x: -823, y: 124, z: 568 };
export { EXIT_WAYPOINT, isInsideHouseArea };
// never dig through anything that looks built (house, chests, beds, doors)
export const KEEP_BLOCKS = /planks|_log$|_wood$|door|stairs|slab|glass|carpet|_bed$|chest|furnace|crafting_table|fence|torch|wool|banner|lantern|pressure_plate/;
const SEE_THROUGH = /^(air|cave_air|void_air|water|lava)$|leaves|vine|glass|torch|_carpet$|^short_grass$|^tall_grass$|^snow$|moss_carpet|glow_lichen|spore_blossom|azalea|dripleaf|cave_vines|hanging_roots/;

export function escapeMovements(bot) {
    const m = new pf.Movements(bot);
    m.canDig = true;
    m.allow1by1towers = true;
    m.allowParkour = false;
    m.allowSprinting = false;
    if (bot.health <= 4) m.maxDropDown = 2;
    for (const b of bot.registry.blocksArray) if (KEEP_BLOCKS.test(b.name)) m.blocksCantBreak.add(b.id);
    return m;
}

export function walkMovements(bot) {
    const m = new pf.Movements(bot);
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

export function homeDistance(bot) {
    const p = bot.entity.position;
    return Math.hypot(p.x - HOUSE_ENTRANCE.x, p.z - HOUSE_ENTRANCE.z);
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
    if (!where && !bot.interrupt_code && homeDistance(bot) < 96 && agent.escape?.gotoChecked &&
        await agent.escape.gotoChecked(agent, new pf.goals.GoalNear(HOUSE_ENTRANCE.x, HOUSE_ENTRANCE.y, HOUSE_ENTRANCE.z, 1), { ms: 60000, label: 'surface-for-wood home' })) where = 'the house entrance';
    const at = bot.entity.position.floored();
    console.log(`[ai-player] surface-for-wood: ${where ? 'reached ' + where : 'could not get out'} (target=${t}); now at ${at}`);
    if (!where) {
        skills.log(bot, `Could not get up to the surface from ${at.x} ${at.y} ${at.z}; skipped the ${type} search. Do something else for a few minutes.`);
        return false;
    }
    skills.log(bot, `Reached ${where} at ${at.x} ${at.y} ${at.z}; now searching for ${type}.`);
    return true;
}

// ---- Fix 2: night -> home -> bed ----
export function isNightTime(bot) {
    const t = bot.time?.timeOfDay;
    if (t == null) return false;
    const tod = ((t % 24000) + 24000) % 24000;
    return (tod >= 12542 && tod <= 23460) || (bot.thunderState ?? 0) > 0;
}

export function isInsideHouse(bot) {
    const p = bot.entity.position;
    return p.z >= 566.8 && p.z <= 572 && p.x >= -827 && p.x <= -817 && Math.abs(p.y - 124) <= 1.5;
}

export function findHomeBed(bot) {
    const hint = new Vec3(HOUSE_BED_HINT.x, HOUSE_BED_HINT.y, HOUSE_BED_HINT.z);
    const beds = bot.findBlocks({ matching: (b) => b && /_bed$/.test(b.name), maxDistance: 32, count: 8, point: hint })
        .filter(p => p.distanceTo(hint) <= 6);
    return beds.length ? bot.blockAt(beds[0]) : null;
}

// Walk home and in through the door (north to south). Returns true when inside.
export async function goHomeInside(bot) {
    if (isInsideHouse(bot)) return true;
    const E = HOUSE_ENTRANCE, I = HOUSE_INSIDE;
    const nearE = bot.entity.position.distanceTo(new Vec3(E.x, E.y, E.z)) <= 2;
    if (!nearE) {
        // underground (the lush cave under the house) walking paths wedge; dig out first (built blocks are protected)
        const under = isUnderground(bot);
        const goal = new pf.goals.GoalNear(E.x, E.y, E.z, 1);
        console.log(`[ai-player] night: heading for the outside plate ${under ? '(underground: dig-out route)' : '(walking)'}`);
        let ok = await gotoWithin(bot, goal, 60000, under ? null : walkMovements(bot));
        if (!ok && !bot.interrupt_code) ok = await gotoWithin(bot, goal, 50000, under ? walkMovements(bot) : null);
        if (!ok) return false;
    }
    if (bot.interrupt_code) return false;
    await gotoWithin(bot, new pf.goals.GoalBlock(Math.floor(I.x), I.y, Math.floor(I.z)), 20000, walkMovements(bot));
    return isInsideHouse(bot);
}

// One scripted walk through the door to a waypoint a few blocks north of the porch.
// Walking first (doors already work); if the porch is sealed, one destructive attempt
// that can dig the walking lane but not walls, roof or the door.
export async function tryScriptedHouseExit(bot) {
    const from = bot?.entity?.position;
    if (!from) return { ok: false, reason: 'no_position' };
    if (!isInsideHouseArea(from) && !isInsideHouse(bot))
        return { ok: true, reason: 'already_outside' };

    navConsole(`enclosure: scripted exit through the door toward ${EXIT_WAYPOINT.x} ${EXIT_WAYPOINT.y} ${EXIT_WAYPOINT.z}`);
    skills.log(bot, `Trying a scripted exit through the front door to ${EXIT_WAYPOINT.x} ${EXIT_WAYPOINT.y} ${EXIT_WAYPOINT.z}.`);

    const E = HOUSE_ENTRANCE, I = HOUSE_INSIDE, W = EXIT_WAYPOINT;
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

    const outside = !isInsideHouse(bot) && !isInsideHouseArea(bot.entity.position);
    if (outside) {
        navConsole(`enclosure: scripted exit reached ${bot.entity.position.floored()}`);
        skills.log(bot, `Exited through the door to ${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.y)} ${Math.floor(bot.entity.position.z)}. Do not retry the original unreachable target.`);
        return { ok: true, reason: 'exited' };
    }
    navConsole('enclosure: scripted exit failed; still inside. reset is last resort only');
    skills.log(bot, 'Scripted house exit failed. Do not keep retrying outside coordinates. A reset is last resort if a player cannot clear the exit.');
    return { ok: false, reason: 'blocked' };
}

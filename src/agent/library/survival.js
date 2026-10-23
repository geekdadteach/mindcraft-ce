// [ai-player] Survival for Bob (item 2, Oct 20 evening): food that actually reaches his stomach, hunting passive
// animals, cooking, a small food stock, and skeleton/ranged-mob handling (6 of 8 deaths on Oct 20 were arrows).
// The model still decides what to do; these are the "how" routines that modes and commands call.
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import * as skills from './skills.js';
import * as world from './world.js';
import * as mc from '../../utils/mcdata.js';

export const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
export const RAW_FOODS = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'];
export const RANGED_MOBS = ['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast'];
export const BERRY_BLOCKS = ['sweet_berry_bush', 'cave_vines', 'cave_vines_plant'];
const FOOD_STOCK_TARGET = 4; // food items to keep in the inventory

const now = () => Date.now();
const fail = (agent, cmd, target, pos, error) => { try { agent?.failures?.record(cmd, target, pos, error); } catch (_) {} };
const blocked = (agent, cmd, target, pos) => { try { return agent?.failures?.isBlocked(cmd, target, pos) || false; } catch (_) { return false; } };

export function edibleFoods(bot, desperate = false) {
    const banned = bot.autoEat?.options?.bannedFood || [];
    const foods = bot.registry.foodsByName;
    const ok = (n) => n in foods && (!banned.includes(n) || (desperate && (n === 'chicken' || n === 'rotten_flesh')));
    return bot.inventory.items().filter(i => ok(i.name)).sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints);
}
export function foodStock(bot) { return edibleFoods(bot, false).reduce((s, i) => s + i.count, 0); }

export async function eatBest(bot) {
    const best = edibleFoods(bot, bot.food <= 6)[0];
    if (!best) return false;
    console.log(`[ai-player] hunger: eating ${best.name} (food=${bot.food})`);
    try { return await skills.consume(bot, best.name); } catch (e) { console.log(`[ai-player] hunger: eat failed: ${e.message}`); return false; }
}

// Cook raw meat when a furnace (placed nearby or carried) and fuel are available; otherwise leave it raw.
export async function cookRaw(bot, max = 4) {
    const inv = world.getInventoryCounts(bot);
    const raw = RAW_FOODS.find(n => inv[n] > 0);
    if (!raw) return false;
    if (!mc.getSmeltingFuel(bot) || !(world.getNearestBlock(bot, 'furnace', 16) || inv['furnace'] > 0)) return false;
    console.log(`[ai-player] food: cooking ${Math.min(max, inv[raw])} ${raw}`);
    try { return await skills.smeltItem(bot, raw, Math.min(max, inv[raw])); }
    catch (e) { console.log(`[ai-player] food: cooking failed: ${e.message}`); return false; }
}

// Eat now if hungry; when not starving try to cook first. Raw meat is fine when starving (food <= 6).
export async function cookOrEat(bot) {
    if (bot.food > 6) await cookRaw(bot);
    if (bot.food >= 20) return true;
    return await eatBest(bot);
}

const ripeBerry = (b) => { const pr = b.getProperties?.() || {}; return b.name === 'sweet_berry_bush' ? Number(pr.age) >= 2 : (pr.berries === true || pr.berries === 'true'); };

// Right-click ripe berry bushes / glow-berry vines and confirm the berries are in the inventory.
// Bob "picked" the same cave vines 20+ times on Oct 20 without ever gaining a berry: now the spot is recorded
// as a failure and skipped instead of retried.
export async function harvestBerries(agent, range = 24) {
    const bot = agent.bot;
    const count = () => { const c = world.getInventoryCounts(bot); return (c.sweet_berries || 0) + (c.glow_berries || 0); };
    const before = count();
    const cands = world.getNearestBlocks(bot, BERRY_BLOCKS, range, 300).filter(ripeBerry)
        .filter(b => !blocked(agent, 'berries', b.name, b.position))
        // never go down into a cave for berries (live watch: glow berries 16 blocks below the house led him underground)
        .filter(b => b.position.y >= Math.floor(bot.entity.position.y) - 3);
    if (!cands.length) return { ok: false, why: 'no ripe berries nearby' };
    const target = cands[0];
    console.log(`[ai-player] food: picking ${target.name} at ${target.position}`);
    await skills.goToPosition(bot, target.position.x, target.position.y, target.position.z, 1);
    for (const b of world.getNearestBlocks(bot, BERRY_BLOCKS, 5, 30).filter(ripeBerry)) {
        if (b.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0)) > 4.4) continue;
        try { await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true); await bot.activateBlock(b); } catch (_) {}
        await new Promise(r => setTimeout(r, 250));
    }
    await new Promise(r => setTimeout(r, 600));
    await skills.pickupNearbyItems(bot);
    const got = count() - before;
    if (got <= 0) {
        fail(agent, 'berries', target.name, target.position, 'picked but no berries in inventory (out of reach?)');
        return { ok: false, why: `could not pick berries at ${target.position}` };
    }
    console.log(`[ai-player] food: got ${got} berries`);
    return { ok: true, got };
}

// Hunt one passive food animal within range: kill (bounded), collect drops.
export async function huntAnimal(agent, range = 32, { types = FOOD_ANIMALS } = {}) {
    const bot = agent.bot;
    const before = foodStock(bot) + RAW_FOODS.reduce((s, n) => s + (world.getInventoryCounts(bot)[n] || 0), 0);
    const animal = world.getNearestEntityWhere(bot, e => types.includes(e.name) && mc.isHuntable(e) &&
        !blocked(agent, 'hunt', e.name, e.position.floored()), range);
    if (!animal) return { ok: false, why: `no ${types.join('/')} within ${range} blocks` };
    console.log(`[ai-player] food: hunting ${animal.name} at ${animal.position.floored()} (${Math.round(animal.position.distanceTo(bot.entity.position))}m)`);
    const where = animal.position.floored();
    // attackEntity only chases while the target is within 24 blocks, so walk closer first (fix found in the live watch)
    if (animal.position.distanceTo(bot.entity.position) > 12 && agent.escape?.gotoChecked) {
        const p = animal.position;
        await agent.escape.gotoChecked(agent, new pf.goals.GoalNear(p.x, p.y, p.z, 4), { ms: 45000, label: `hunt ${animal.name}` });
    }
    const target = bot.entities[animal.id];
    if (target && target.position.distanceTo(bot.entity.position) <= 24) await skills.attackEntity(bot, target, true);
    await skills.pickupNearbyItems(bot);
    const after = foodStock(bot) + RAW_FOODS.reduce((s, n) => s + (world.getInventoryCounts(bot)[n] || 0), 0);
    if (after <= before) {
        fail(agent, 'hunt', animal.name, where, 'animal not killed or drops not collected');
        return { ok: false, why: `hunting ${animal.name} gave no food` };
    }
    return { ok: true, got: after - before, animal: animal.name };
}

export async function harvestCrops(bot) {
    const ripe = (b) => (b.getProperties?.()?.age ?? 0) >= (b.name === 'beetroots' ? 3 : 7);
    const crops = world.getNearestBlocks(bot, ['carrots', 'potatoes', 'beetroots', 'wheat'], 32, 60).filter(ripe).slice(0, 4);
    if (!crops.length) return false;
    console.log(`[ai-player] food: harvesting ${crops.length} ${crops[0].name}`);
    for (const c of crops) { try { await skills.breakBlockAt(bot, c.position.x, c.position.y, c.position.z); } catch (e) {} }
    await skills.pickupNearbyItems(bot);
    if ((world.getInventoryCounts(bot)['wheat'] || 0) >= 3) { try { await skills.craftRecipe(bot, 'bread', 1); } catch (e) {} }
    return true;
}

// Get food: animals first (best food), then berries, crops, wider hunt; underground, go up first (animals live on
// the surface). Returns true when Bob ate or now holds food.
export async function getFood(agent, { escapeUp = null, reason = 'hungry' } = {}) {
    const bot = agent.bot;
    console.log(`[ai-player] food: ${reason}; food=${bot.food} health=${Math.round(bot.health)} stock=${foodStock(bot)}`);
    if (foodStock(bot) > 0 && bot.food <= 14) return await eatBest(bot);
    let r = await huntAnimal(agent, 24);
    if (!r.ok) { const b = await harvestBerries(agent, 24); if (b.ok) r = b; }
    if (!r.ok && await harvestCrops(bot)) r = { ok: true };
    if (!r.ok && escapeUp && (await import('./ai_player_nav.js')).isUnderground(bot)) {
        console.log('[ai-player] food: nothing to eat down here; going up to the surface to hunt');
        await escapeUp(agent, { reason: 'food' });
    }
    if (!r.ok) r = await huntAnimal(agent, 64);
    if (!r.ok) { console.log(`[ai-player] food: none found (${r.why})`); skills.log(bot, `Could not find food nearby (${r.why}). Try another area on the surface.`); return false; }
    await cookOrEat(bot);
    return true;
}

// ---------------- ranged mobs (skeletons) ----------------
const eye = (e) => e.position.offset(0, (e.height ?? 1.8) * 0.85, 0);
// true when nothing solid blocks the straight line between the two points
export function lineOfSight(bot, from, to) {
    const d = to.minus(from); const dist = d.norm(); if (dist < 0.01) return true;
    const dir = d.scaled(1 / dist);
    try {
        const hit = bot.world.raycast(from, dir, dist, (b) => b && b.boundingBox === 'block' && !/leaves|glass/.test(b.name));
        return !hit;
    } catch (_) {
        const steps = Math.ceil(dist * 2);
        for (let i = 1; i < steps; i++) { const b = bot.blockAt(from.plus(dir.scaled(i / 2))); if (b && b.boundingBox === 'block') return false; }
        return true;
    }
}
export function rangedThreats(bot, range = 20) {
    return Object.values(bot.entities).filter(e => e && e !== bot.entity && RANGED_MOBS.includes(e.name) &&
        e.position.distanceTo(bot.entity.position) <= range);
}
export function exposedTo(bot, mobs, at = null) {
    const me = at ? at.offset(0.5, 1.6, 0.5) : bot.entity.position.offset(0, 1.6, 0);
    return mobs.filter(m => lineOfSight(bot, eye(m), me));
}
const hasSword = (bot) => bot.inventory.items().some(i => /_sword$/.test(i.name));

// Find a standable spot within r blocks that none of the mobs can see (behind a wall, around a corner).
export function findCover(bot, mobs, r = 7) {
    const p = bot.entity.position.floored();
    const best = [];
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -2; dy <= 2; dy++) {
        if (dx * dx + dz * dz > r * r || (dx === 0 && dz === 0)) continue;
        const at = p.offset(dx, dy, dz);
        const below = bot.blockAt(at.offset(0, -1, 0)), feet = bot.blockAt(at), head = bot.blockAt(at.offset(0, 1, 0));
        if (!below || !feet || !head || below.boundingBox !== 'block' || feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue;
        if (/lava|water|fire|magma|powder_snow/.test(below.name + feet.name)) continue;
        if (exposedTo(bot, mobs, at).length) continue;
        const near = Math.min(...mobs.map(m => m.position.distanceTo(at)));
        if (near < 5) continue;
        best.push({ at, cost: Math.hypot(dx, dy, dz) - near * 0.3 });
    }
    best.sort((a, b) => a.cost - b.cost);
    return best.slice(0, 4).map(b => b.at);
}

// One ranged-threat response. Fight only with good health and a sword and a short clear walk; otherwise take
// cover out of their line of sight; in daylight underground also head up afterwards (handled by the caller).
export async function handleRanged(agent, mobs) {
    const bot = agent.bot;
    const closest = mobs.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    const d = closest.position.distanceTo(bot.entity.position);
    const clear = d <= 10 && await world.isClearPath(bot, closest);
    if (bot.health >= 14 && hasSword(bot) && clear && mobs.length === 1) {
        console.log(`[ai-player] threat: fighting ${closest.name} at ${Math.round(d)}m (health ${Math.round(bot.health)}, sword)`);
        await skills.attackEntity(bot, closest, true);
        return 'fought';
    }
    const covers = findCover(bot, mobs);
    for (const c of covers) {
        const ok = await gotoQuick(bot, new pf.goals.GoalBlock(c.x, c.y, c.z), 7000);
        if (ok && exposedTo(bot, mobs).length === 0) {
            console.log(`[ai-player] threat: took cover from ${mobs.map(m => m.name).join(',')} at ${bot.entity.position.floored()}`);
            return 'cover';
        }
    }
    // no cover reachable: move away from them (bounded)
    console.log(`[ai-player] threat: no cover from ${closest.name}; backing away`);
    await gotoQuick(bot, new pf.goals.GoalInvert(new pf.goals.GoalFollow(closest, 18)), 6000);
    return 'retreat';
}

export async function gotoQuick(bot, goal, ms) {
    const m = new pf.Movements(bot);
    m.allowParkour = false; m.canDig = false; m.allowSprinting = true;
    bot.pathfinder.setMovements(m);
    let timer;
    const ok = await Promise.race([
        bot.pathfinder.goto(goal).then(() => true, () => false),
        new Promise(r => { timer = setTimeout(() => r(false), ms); }),
    ]);
    clearTimeout(timer);
    if (!ok) { try { bot.pathfinder.stop(); } catch (_) {} }
    return ok;
}

export function creeperClose(bot, r = 6) {
    return world.getNearestEntityWhere(bot, e => e.name === 'creeper', r);
}
export { FOOD_STOCK_TARGET };

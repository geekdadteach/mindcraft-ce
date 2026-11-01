// [ai-player] Survival for Bob (item 2, Oct 20 evening): food that actually reaches his stomach, hunting passive
// animals, cooking, a small food stock, and skeleton/ranged-mob handling (6 of 8 deaths on Oct 20 were arrows).
// The model still decides what to do; these are the "how" routines that modes and commands call.
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import * as skills from './skills.js';
import * as world from './world.js';
import * as mc from '../../utils/mcdata.js';
import { zoneAt } from './no_go_zones.js';
import { protectedAreaAt } from './house_bounds.js';
import { isInClaim } from './bob_claim.js';
import { gotoWithin, walkMovements, isNightTime } from './ai_player_nav.js';
import { isNaturalWoodBlockName } from './bob_wood_types.js';

export const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
export const RAW_FOODS = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'];
export const RANGED_MOBS = ['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast'];

// [ai-player] Fix 1d: true when Bob carries a weapon self_defense can swing (a sword, or an axe that
// is not a pickaxe). Mirrors equipHighestAttack in skills.js.
export function hasMeleeWeapon(bot) {
    try {
        return bot.inventory.items().some(i => i.name.includes('sword') || (i.name.includes('axe') && !i.name.includes('pickaxe')));
    } catch (_) { return false; }
}

// [ai-player] Fix 1c/1d: the mob self_defense should engage, or null. Neutral mobs (enderman, wolf,
// ...) are ignored unless they just hit Bob (mc.isAggressiveHostile); ranged mobs further than 3 blocks
// belong to ranged_threat; and an unarmed Bob at <= 10 health does not melee — self_preservation flees
// instead of feeding a death (report 4.1). Exported so modes.js and tests share one decision.
export function selfDefenseTarget(bot, range = 8, nearest = world.getNearestEntityWhere) {
    const enemy = nearest(bot, entity => mc.isAggressiveHostile(entity) && entity.name !== 'creeper' &&
        !(RANGED_MOBS.includes(entity.name) && entity.position.distanceTo(bot.entity.position) > 3), range);
    if (!enemy) return null;
    if (!hasMeleeWeapon(bot) && bot.health <= 10) return null;
    return enemy;
}
export const BERRY_BLOCKS = ['sweet_berry_bush', 'cave_vines', 'cave_vines_plant'];
const FOOD_STOCK_TARGET = 4; // food items to keep in the inventory

const now = () => Date.now();
const NO_FOOD_RETRY_MS = 45_000;
const FOOD_SEARCH_CELL = 16;
// Per-agent cooldown: a failed local search should not run every hunger tick.
// Moving into a different area immediately permits another search.
const foodSearchCooldown = new WeakMap();
// [ai-player] Fix 2c: consecutive empty local searches per agent.
const emptyLocalSearches = new WeakMap();
export function foodSearchAllowed(agent, position, time = now()) {
    if (!position) return true;
    const cell = [position.x, position.y, position.z].map(v => Math.floor(v / FOOD_SEARCH_CELL)).join(',');
    const previous = foodSearchCooldown.get(agent);
    return !previous || previous.cell !== cell || time >= previous.until;
}
export function noteFoodSearchFailure(agent, position, time = now()) {
    if (!position) return;
    const cell = [position.x, position.y, position.z].map(v => Math.floor(v / FOOD_SEARCH_CELL)).join(',');
    foodSearchCooldown.set(agent, { cell, until: time + NO_FOOD_RETRY_MS });
}

// Only food recovery may relocate a critically weak Bob. No digging, parkour or blind exploration.
const FOOD_RELOCATION_STEPS = [12, 20, 28];
const FOOD_RELOCATION_MAX_ATTEMPTS = 6;
const HAZARD_BLOCK = /lava|magma|fire|cactus|powder_snow|campfire|sweet_berry_bush/;
export function foodRelocationCandidates(position) {
    if (!position) return [];
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    // Interleave directions and distances: a blocked nearby ring must not exhaust every attempt.
    return FOOD_RELOCATION_STEPS.flatMap(d => [
        { x: x - d, y, z }, { x, y, z: z - d },
        { x: x + d, y, z }, { x, y, z: z + d },
    ]).filter(p => !zoneAt(p.x, p.z));
}
// Ground may rise or fall. Only accept a fully loaded, standable 2-block-high space.
export function foodRelocationGround(bot, candidate) {
    if (!bot?.blockAt || !candidate || zoneAt(candidate.x, candidate.z)) return null;
    for (let dy = 2; dy >= -4; dy--) {
        const p = new Vec3(candidate.x, candidate.y + dy, candidate.z);
        const feet = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0));
        const floor = bot.blockAt(p.offset(0, -1, 0));
        if (!feet || !head || !floor) continue;
        if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' ||
            floor.boundingBox !== 'block' || HAZARD_BLOCK.test(
                feet.name + ' ' + head.name + ' ' + floor.name)) continue;
        return p;
    }
    return null;
}
export async function relocateForFood(agent, { navigate = (bot, goal) => gotoWithin(bot, goal, 12000, walkMovements(bot)) } = {}) {
    const bot = agent.bot;
    if (!bot?.entity?.position || bot.interrupt_code || bot.health <= 0) return false;
    const start = bot.entity.position.clone();
    let attempts = 0;
    for (const candidate of foodRelocationCandidates(start)) {
        if (bot.interrupt_code || bot.health <= 0) return false;
        const p = foodRelocationGround(bot, candidate);
        if (!p) continue;
        if (++attempts > FOOD_RELOCATION_MAX_ATTEMPTS) break;
        try {
            const ok = await navigate(bot, new pf.goals.GoalNear(p.x, p.y, p.z, 2));
            if (ok && bot.entity.position.distanceTo(start) >= 8) {
                console.log('[ai-player] food: reached a new search area');
                return true;
            }
        } catch (err) { console.log('[ai-player] food: relocation failed: ' + (err?.message || err)); }
    }
    console.log('[ai-player] food: no safe relocation route found; not repeating blind movement');
    return false;
}

const fail = (agent, cmd, target, pos, error) => { try { agent?.failures?.record(cmd, target, pos, error); } catch (_) {} };
const blocked = (agent, cmd, target, pos) => { try { return agent?.failures?.isBlocked(cmd, target, pos) || false; } catch (_) { return false; } };

// [ai-player] Fix 2a: food Bob eats only when desperate (food <= 6 or health <= 6).
export const DESPERATE_FOODS = new Set(['chicken', 'rotten_flesh', 'spider_eye']);
// [ai-player] Fix 2 review: the junk edibles (spider_eye/rotten_flesh/chicken) are unlocked by hunger only
// (food <= 6), never by low health alone.
export function desperateForJunkFood(bot) {
    return Number.isFinite(bot?.food) && bot.food <= 6;
}
export function isDesperate(bot) {
    return desperateForJunkFood(bot) || (Number.isFinite(bot?.health) && bot.health <= 6);
}

export function edibleFoods(bot, desperate = false) {
    const banned = bot.autoEat?.options?.bannedFood || [];
    const foods = bot.registry.foodsByName;
    const ok = (n) => n in foods && (!banned.includes(n) || (desperate && DESPERATE_FOODS.has(n)));
    return bot.inventory.items().filter(i => ok(i.name)).sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints);
}
export function foodStock(bot) { return edibleFoods(bot, false).reduce((s, i) => s + i.count, 0); }

// [ai-player] Fix 2b: natural health regen needs food >= 18, but auto-eat only starts at 14. Top up
// when hurt and below 18, if Bob has anything edible.
export function shouldEatForRegen(bot) {
    if (!Number.isFinite(bot?.health) || !Number.isFinite(bot?.food)) return false;
    if (bot.health >= 20 || bot.food >= 18) return false;
    return edibleFoods(bot, desperateForJunkFood(bot)).length > 0;
}

export async function eatBest(bot) {
    const best = edibleFoods(bot, desperateForJunkFood(bot))[0];
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
    for (const b of world.getNearestBlocks(bot, BERRY_BLOCKS, 5, 30).filter(ripeBerry).filter(b => !blocked(agent, 'berries', b.name, b.position))) {
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
export function huntableAdultCount(bot, type, range = 64) {
    const pos = bot?.entity?.position;
    if (!pos) return 0;
    return Object.values(bot.entities || {}).filter(e =>
        e?.name === type && e.position?.distanceTo(pos) <= range &&
        mc.isHuntable(e) && e.isBaby !== true
    ).length;
}

// Preserve at least two visible adults of every food species in the local ecosystem.
export function canHuntSpecies(bot, type, range = 64) {
    return huntableAdultCount(bot, type, range) > 2;
}

// Breeding is opportunistic, not an emergency-food action. Never consume the last two
// breeding animals, and never approach entities inside protected NewEarth zones.
const BREEDING_FOOD = Object.freeze({cow:'wheat',sheep:'wheat',pig:'carrot',chicken:'wheat_seeds',rabbit:'carrot'});
export async function breedNearbyAnimals(agent, range = 16) {
    const bot = agent?.bot;
    if (!bot?.entity?.position || bot.food <= 10 || bot.health <= 8 || bot.interrupt_code) return false;
    const inventory = world.getInventoryCounts(bot);
    for (const [species, itemName] of Object.entries(BREEDING_FOOD)) {
        if ((inventory[itemName] || 0) < 3) continue; // reserve one item for planting or later use
        const nearby = Object.values(bot.entities || {}).filter(e => e?.name === species &&
            e.position && e.isBaby !== true &&
            e.position.distanceTo(bot.entity.position) <= range &&
            !zoneAt(e.position.x, e.position.z) && !protectedAreaAt(e.position));
        if (nearby.length < 2) continue;
        const item = bot.inventory.items().find(i => i.name === itemName);
        if (!item) continue;
        try {
            await bot.equip(item, 'hand');
            let fed = 0;
            for (const animal of nearby.slice(0, 2)) {
                if (bot.interrupt_code) return false;
                await skills.goToPosition(bot, animal.position.x, animal.position.y, animal.position.z, 3);
                if (animal.position.distanceTo(bot.entity.position) > 4) break;
                await bot.activateEntity(animal);
                fed++;
            }
            if (fed === 2) {
                console.log('[ai-player] food: fed a pair of ' + species + ' for breeding');
                return true;
            }
        } catch (err) { console.log('[ai-player] food: breeding attempt failed: ' + (err?.message || err)); }
    }
    return false;
}

export async function huntAnimal(agent, range = 32, { types = FOOD_ANIMALS, attack = skills.attackEntity, collect = collectDropsFor } = {}) {
    const bot = agent.bot;
    const before = foodStock(bot) + RAW_FOODS.reduce((s, n) => s + (world.getInventoryCounts(bot)[n] || 0), 0);
    const animal = world.getNearestEntityWhere(bot, e => types.includes(e.name) && mc.isHuntable(e) && canHuntSpecies(bot, e.name) &&
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
    if (target && target.position.distanceTo(bot.entity.position) <= 24) await attack(bot, target, true);
    await collect(bot, { range: 6, ms: 5000 }); // [ai-player] Fix 2d: walk to the drops, then count
    const after = foodStock(bot) + RAW_FOODS.reduce((s, n) => s + (world.getInventoryCounts(bot)[n] || 0), 0);
    if (after <= before) {
        fail(agent, 'hunt', animal.name, where, 'animal not killed or drops not collected');
        return { ok: false, why: `hunting ${animal.name} gave no food` };
    }
    return { ok: true, got: after - before, animal: animal.name };
}

// Farming requires an explicitly reviewed, Bob-owned rectangular plot.
// Proximity to his home alone does not establish permission to modify crops.
export function inBobFarmArea(position, env = process.env) {
    if (!position || env.BOB_FARM_ENABLED !== 'true') return false;
    const raw = [env.BOB_FARM_X1, env.BOB_FARM_X2, env.BOB_FARM_Z1, env.BOB_FARM_Z2];
    if (raw.some(v => v == null || String(v).trim() === '')) return false;
    const bounds = raw.map(Number);
    if (!bounds.every(Number.isSafeInteger)) return false;
    const [x1,x2,z1,z2] = bounds;
    if (x1 > x2 || z1 > z2 || x2 - x1 > 32 || z2 - z1 > 32) return false;
    const x = Math.floor(position.x), z = Math.floor(position.z);
    return isInClaim({x,z}) &&
        x >= x1 && x <= x2 && z >= z1 && z <= z2 &&
        !zoneAt(x,z) && !protectedAreaAt(position);
}

export async function harvestCrops(bot, range = 32) {
    const before = foodStock(bot);
    const ripe = (b) => (b.getProperties?.()?.age ?? 0) >= (b.name === 'beetroots' ? 3 : 7);
    const crops = world.getNearestBlocks(bot, ['carrots', 'potatoes', 'beetroots', 'wheat'], range, 60)
        .filter(ripe).filter(c => inBobFarmArea(c.position)).slice(0, 4);
    if (!crops.length) return false;
    console.log(`[ai-player] food: harvesting ${crops.length} ${crops[0].name}`);
    let harvested = 0;
    for (const c of crops) { try { await skills.breakBlockAt(bot, c.position.x, c.position.y, c.position.z); harvested++; } catch (e) {} }
    await skills.pickupNearbyItems(bot);
    // Replant only when the harvested position is verified to be outside all
    // protected areas. Never till new ground or modify another player's farm.
    for (const crop of crops) {
        if (!inBobFarmArea(crop.position)) continue;
        const seed = {wheat:'wheat_seeds',carrots:'carrot',potatoes:'potato',beetroots:'beetroot_seeds'}[crop.name];
        const item = bot.inventory.items().find(i => i.name === seed);
        const soil = bot.blockAt(crop.position.offset(0, -1, 0));
        const air = bot.blockAt(crop.position);
        if (!item || soil?.name !== 'farmland' || air?.boundingBox !== 'empty') continue;
        try {
            await bot.equip(item, 'hand');
            await bot.placeBlock(soil, {x:0,y:1,z:0});
        } catch (err) { console.log('[ai-player] food: replant failed: ' + (err?.message || err)); }
    }
    if ((world.getInventoryCounts(bot)['wheat'] || 0) >= 3) { try { await skills.craftRecipe(bot, 'bread', 1); } catch (e) {} }
    return harvested > 0 && foodStock(bot) > before;
}

// Get food: crops first (best food), then berries, crops, wider hunt; underground, go up first (animals live on
// the surface). Returns true when Bob ate or now holds food.
// searchRange widens the local hunt/forage (default null keeps the original 24/64 hunt and 32-block crop
// search). maxRange caps BOTH the local and the wider search. relocate:false keeps the search local: no
// 96-160 block far relocation and no relocateForFood - used by the "he has nothing edible" trip, where a
// long hop is not worth it. The urgent food <= 12 path keeps the defaults.
export async function getFood(agent, { escapeUp = null, reason = 'hungry', hunt = huntAnimal, relocateFar = relocateFarForFood, env = process.env, searchRange = null, maxRange = null, relocate = true } = {}) {
    const bot = agent.bot;
    const cap = (n) => (Number.isFinite(maxRange) && maxRange > 0 ? Math.min(n, maxRange) : n);
    const near = cap(Number.isFinite(searchRange) && searchRange > 0 ? searchRange : 24);
    const far = cap(Math.max(near * 2, 64));
    console.log(`[ai-player] food: ${reason}; food=${bot.food} health=${Math.round(bot.health)} stock=${foodStock(bot)}${relocate ? '' : ' (local search only)'}`);
    if (foodStock(bot) > 0 && bot.food <= 14) return await eatBest(bot);
    if (!foodSearchAllowed(agent, bot.entity?.position)) {
        console.log('[ai-player] food: local search cooling down; move to a different safe area before retrying');
        if (relocate) await relocateForFood(agent);
        return false;
    }
    // [ai-player] Fix 2: harvest helpers are best-effort; a world lookup failure must not abort the loop.
    let r = { ok: false };
    try { r = { ok: await harvestCrops(bot, near) }; } catch (_) {}
    if (!r.ok) { try { const b = await harvestBerries(agent, near); if (b.ok) r = b; } catch (_) {} }
    if (!r.ok) r = await hunt(agent, near);
    if (!r.ok && escapeUp && (await import('./ai_player_nav.js')).isUnderground(bot)) {
        console.log('[ai-player] food: nothing to eat down here; going up to the surface to hunt');
        await escapeUp(agent, { reason: 'food' });
    }
    // [ai-player] Fix 2c: after 2 consecutive empty local searches, relocate to a fresh ring (daylight only).
    if (!r.ok) {
        const n = (emptyLocalSearches.get(agent) || 0) + 1;
        emptyLocalSearches.set(agent, n);
        if (n >= 2 && foodRelocateEnabled(env) && !isNightTime(bot) && relocate) {
            console.log(`[ai-player] food: ${n} empty local searches; relocating to a fresh ring`);
            if (await relocateFar(agent)) emptyLocalSearches.set(agent, 0);
        }
    }
    if (!r.ok) r = await hunt(agent, far);
    if (!r.ok) { console.log(`[ai-player] food: none found (${r.why})`); noteFoodSearchFailure(agent, bot.entity?.position); skills.log(bot, `Could not find food nearby (${r.why}). Seeking a safe new search area.`); if (relocate) await relocateForFood(agent); return false; }
    emptyLocalSearches.set(agent, 0);
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

// [ai-player] Fix 3: craft basic wooden tools from held logs when idle in daylight. ON by default;
// BOB_STARTER_TOOLS=0 opts out.
export function starterToolsEnabled(env = process.env) { return env.BOB_STARTER_TOOLS !== '0'; }

// The planks to make: the held log's own wood type, else oak.
// [ai-player] Fix 3 review: bamboo is not a plank source here (bamboo_planks are not a wood type Bob builds
// with), so it never maps to planks.
export function starterWoodType(logName) {
    const name = String(logName || '');
    // [ai-player] Fix 3 round 3: a stripped log is not a plank source here (isNaturalWoodBlockName excludes
    // stripped_*), and bamboo_planks are not a wood type Bob builds with.
    if (!isNaturalWoodBlockName(name) || name === 'bamboo') return null;
    const wood = name.replace(/_log$|_stem$/, '');
    return wood && wood !== name ? wood : null;
}

// [ai-player] Fix 3 review: logs counted per wood type (bamboo excluded).
export function logCountsByWood(bot) {
    const counts = {};
    try {
        for (const i of bot.inventory.items()) {
            const wood = starterWoodType(i.name);
            if (!wood) continue;
            counts[wood] = (counts[wood] || 0) + (i.count || 0);
        }
    } catch (_) {}
    return counts;
}

// The wood type Bob holds the most of, or null.
export function bestStarterWood(bot) {
    let best = null, bestN = 0;
    for (const [wood, n] of Object.entries(logCountsByWood(bot))) {
        if (n > bestN) { best = wood; bestN = n; }
    }
    return best ? { wood: best, count: bestN } : null;
}

// The planks to make: the wood type Bob holds the most of (never bamboo), else oak.
export function starterPlanksName(bot) {
    const best = bestStarterWood(bot);
    return best ? best.wood + '_planks' : 'oak_planks';
}

// [ai-player] Fix 3 review: a starter run needs at least 3 logs of ONE wood type, and makes 3 planks.
export const STARTER_TOOLS_MIN_LOGS = 3;
export const STARTER_TOOLS_PLANKS = 3;

// The count of the most plentiful wood type Bob holds.
export function heldLogCount(bot) {
    return bestStarterWood(bot)?.count || 0;
}



// A crafting table is at hand if one is held or a block is within reach (16 blocks, matching craftRecipe).
export function craftingTableAtHand(bot, range = 16) {
    try { if (bot.inventory.items().some(i => i.name === 'crafting_table')) return true; } catch (_) {}
    try { return !!world.getNearestBlock(bot, 'crafting_table', range); } catch (_) { return false; }
}

// True when Bob holds enough logs but lacks a pickaxe or a sword.
export function needsStarterTools(bot) {
    try {
        const items = bot.inventory.items();
        const hasPick = items.some(i => i.name.endsWith('_pickaxe'));
        const hasSword = items.some(i => i.name.endsWith('_sword'));
        if (hasPick && hasSword) return false;
        return heldLogCount(bot) >= STARTER_TOOLS_MIN_LOGS;
    } catch (_) { return false; }
}

// Craft 3 planks -> crafting_table -> sticks -> wooden_pickaxe -> wooden_sword, skipping what Bob already
// has and the table when one is at hand. Needs >= 3 logs. craft/tableNearby are injectable for tests.
export async function craftStarterTools(bot, { craft = (b, name, count) => skills.craftRecipe(b, name, count), tableNearby = null } = {}) {
    const crafted = [];
    if (heldLogCount(bot) < STARTER_TOOLS_MIN_LOGS) return crafted;
    const items = (() => { try { return bot.inventory.items(); } catch (_) { return []; } })();
    const hasPick = items.some(i => i.name.endsWith('_pickaxe'));
    const hasSword = items.some(i => i.name.endsWith('_sword'));
    const tableAtHand = tableNearby != null ? !!tableNearby : craftingTableAtHand(bot);
    const steps = [[starterPlanksName(bot), STARTER_TOOLS_PLANKS]];
    if (!tableAtHand) steps.push(['crafting_table', 1]);
    steps.push(['stick', 1]);
    if (!hasPick) steps.push(['wooden_pickaxe', 1]);
    if (!hasSword) steps.push(['wooden_sword', 1]);
    for (const [name, count] of steps) {
        if (bot.interrupt_code) break;
        try { if (await craft(bot, name, count)) crafted.push(name); } catch (_) {}
    }
    return crafted;
}


// [ai-player] Fix 2d: walk to dropped items within range for up to ms and pick them up.
export async function collectDropsFor(bot, { range = 6, ms = 5000 } = {}) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !bot.interrupt_code) {
        const items = world.getNearbyEntities(bot, range).filter(e => e?.name === 'item');
        if (!items.length) break;
        const item = items[0];
        try { await skills.goToPosition(bot, item.position.x, item.position.y, item.position.z, 1); } catch (_) {}
        try { await skills.pickupNearbyItems(bot); } catch (_) {}
        await new Promise(r => setTimeout(r, 200));
    }
    return true;
}

// [ai-player] Fix 2c: relocate far for a fresh food search. ON by default; BOB_FOOD_RELOCATE=0 opts out.
export function foodRelocateEnabled(env = process.env) { return env.BOB_FOOD_RELOCATE !== '0'; }

// [ai-player] 2026-11-01: with no food at all and food < 18 or health < 20, go and get some in daylight.
// ON by default; BOB_FOOD_STOCK=0 opts out.
export function foodStockEnabled(env = process.env) { return env?.BOB_FOOD_STOCK !== '0'; }

export const FOOD_RELOCATE_MIN = 96;
export const FOOD_RELOCATE_MAX = 160;

// Candidate landing spots on a ring 96..160 blocks out, outside every no-go zone.
export function farFoodCandidates(position, { min = FOOD_RELOCATE_MIN, max = FOOD_RELOCATE_MAX } = {}) {
    if (!position) return [];
    const x = Math.floor(position.x), z = Math.floor(position.z);
    const out = [];
    for (const d of [min, Math.round((min + max) / 2), max]) {
        for (const [dx, dz] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) {
            const p = { x: x + dx, y: Math.floor(position.y), z: z + dz };
            if (!zoneAt(p.x, p.z)) out.push(p);
        }
    }
    return out;
}

// [ai-player] Fix 2 review: bound the far relocation — at most 3 spots and 180 s total, and stop early if it
// turns night or Bob gets too hurt/hungry to keep walking.
export const FAR_RELOCATE_MAX_SPOTS = 3;
export const FAR_RELOCATE_TOTAL_MS = 180000;

export function shouldStopFarRelocation(bot) {
    if (!bot || bot.interrupt_code) return true;
    if (Number.isFinite(bot.health) && bot.health <= 10) return true;
    if (Number.isFinite(bot.food) && bot.food <= 4) return true;
    return isNightTime(bot);
}

// Aim at the XZ column when the ground height is unknown so the pathfinder picks the surface height.
export function farRelocationGoal(bot, candidate) {
    const ground = foodRelocationGround(bot, candidate);
    if (ground && Number.isFinite(ground.y)) return new pf.goals.GoalNear(ground.x, ground.y, ground.z, 4);
    return new pf.goals.GoalNearXZ(candidate.x, candidate.z, 4);
}

export async function relocateFarForFood(agent, { navigate = (bot, goal) => gotoWithin(bot, goal, 60000, walkMovements(bot)), now = Date.now } = {}) {
    const bot = agent.bot;
    if (!bot?.entity?.position || bot.interrupt_code || bot.health <= 0) return false;
    const start = bot.entity.position.clone();
    const deadline = now() + FAR_RELOCATE_TOTAL_MS;
    let tried = 0;
    for (const candidate of farFoodCandidates(start)) {
        if (tried >= FAR_RELOCATE_MAX_SPOTS || now() >= deadline) break;
        if (shouldStopFarRelocation(bot)) { console.log('[ai-player] food: stopping the far relocation (night, hurt or starving)'); break; }
        tried++;
        try {
            const ok = await navigate(bot, farRelocationGoal(bot, candidate));
            if (ok && bot.entity.position.distanceTo(start) >= 64) { console.log('[ai-player] food: relocated to a fresh search ring'); return true; }
        } catch (err) { console.log('[ai-player] food: far relocation failed: ' + (err?.message || err)); }
    }
    console.log('[ai-player] food: could not reach a fresh search ring');
    return false;
}

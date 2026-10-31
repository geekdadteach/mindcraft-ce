// Guard model-selected optional actions during critical survival states.
// This intentionally does not interrupt an already-running action (the modes handle that).
// Never blocks the actions that get Bob food, sleep, a chest, or away from a fight.

const CONTROL = new Set([
    '!stop', '!stfu', '!stay', '!endGoal', '!inventory', '!stats', '!health', '!goal',
    '!restart', '!clearChat',
]);
const EAT = new Set(['!getFood', '!consume', '!eat']);
const CHEST = new Set(['!viewChest', '!takeFromChest']);
const FLEE = new Set(['!moveAway']);
const SLEEP = new Set(['!goToBed']);

const FOOD_MOBS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const HOSTILES = new Set([
    'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged',
    'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'phantom', 'slime',
    'pillager', 'vindicator', 'evoker', 'ravager', 'silverfish', 'endermite',
    'blaze', 'ghast', 'guardian', 'elder_guardian', 'magma_cube', 'hoglin',
    'zoglin', 'piglin', 'piglin_brute', 'warden', 'breeze',
]);
const FOOD_BLOCKS = new Set([
    'wheat', 'carrots', 'potatoes', 'beetroots', 'carrot', 'potato', 'beetroot',
    'sweet_berry_bush', 'cave_vines', 'cave_vines_plant', 'melon', 'pumpkin',
    'hay_block',
]);
const FOOD_ITEMS = new Set([
    'bread', 'apple', 'golden_apple', 'golden_carrot', 'carrot', 'potato',
    'baked_potato', 'beetroot', 'sweet_berries', 'glow_berries', 'melon_slice',
    'dried_kelp', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'pumpkin_pie',
    'cookie', 'honey_bottle',
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
    'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
    'wheat', 'egg',
]);
const HOME_PLACE = /^(house|home|bed|spawn)$/i;
const BED_NEAR = 24;
const GUARD_BLOCK_RE = /CRITICAL SURVIVAL|Eat now with !consume|is blocked for about .+ more min: you got stuck|You already did that;|You already have \d+ .+, which is plenty|failed \d+ times near .+ recently/i;

function extraOf(extra) {
    if (Array.isArray(extra)) return { args: extra };
    return extra && typeof extra === 'object' ? extra : {};
}

function arg0(args) {
    return String(args?.[0] ?? '').trim().toLowerCase().replace(/^minecraft:/, '');
}

function firstEdibleName(bot) {
    try {
        const items = typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : [];
        const foods = bot?.registry?.foodsByName;
        for (const item of items) {
            const name = String(item?.name || '');
            if (!name) continue;
            if (FOOD_ITEMS.has(name) || name.startsWith('cooked_')) return name;
            if (foods && name in foods) return name;
        }
    } catch { /* inventory must never throw */ }
    return null;
}

function isFoodMob(name) { return FOOD_MOBS.has(String(name || '')); }
function isHostile(name) { return HOSTILES.has(String(name || '')); }
function isFoodBlock(name) { return FOOD_BLOCKS.has(String(name || '')) || FOOD_ITEMS.has(String(name || '')); }

function nearbyHostileName(bot) {
    try {
        const me = bot?.entity;
        if (!me?.position || !bot.entities) return null;
        for (const ent of Object.values(bot.entities)) {
            if (!ent || ent === me) continue;
            const name = String(ent.name || '').toLowerCase();
            if (!isHostile(name)) continue;
            if (ent.position && me.position.distanceTo(ent.position) <= 12) return name;
        }
    } catch { /* loaded-entity scan only */ }
    return null;
}

function towardBed(args, bed) {
    if (!bed || !Number.isFinite(bed.x) || !Number.isFinite(bed.z)) return false;
    const x = Number(args?.[0]), y = Number(args?.[1]), z = Number(args?.[2]);
    if (![x, y, z].every(Number.isFinite)) return false;
    const dy = Number.isFinite(bed.y) ? (y - bed.y) : 0;
    return Math.hypot(x - bed.x, dy, z - bed.z) <= BED_NEAR;
}

function isFleeOrDefend(commandName, args, bot) {
    if (FLEE.has(commandName)) return true;
    if (commandName !== '!attack') return false;
    const target = arg0(args);
    if (isHostile(target)) return true;
    const nearby = nearbyHostileName(bot);
    return !!nearby && (!target || target === nearby);
}

function isSurvivalHelp(commandName, args, extra) {
    if (EAT.has(commandName) || CONTROL.has(commandName) || CHEST.has(commandName) || SLEEP.has(commandName))
        return true;
    if (FLEE.has(commandName)) return true;
    if (commandName === '!searchForEntity' && isFoodMob(arg0(args))) return true;
    if (commandName === '!searchForBlock' && isFoodBlock(arg0(args))) return true;
    if (commandName === '!attack' && (isFoodMob(arg0(args)) || isHostile(arg0(args)))) return true;
    if (commandName === '!collectBlocks' && isFoodBlock(arg0(args))) return true;
    if (commandName === '!goToRememberedPlace' && HOME_PLACE.test(String(args?.[0] || ''))) return true;
    if (commandName === '!goToCoordinates' && towardBed(args, extra.bed)) return true;
    return false;
}

function statusPrefix(bot) {
    return 'CRITICAL SURVIVAL: health=' + Math.round(bot.health) + '/20, food=' + Math.round(bot.food) + '/20. ';
}

export function isGuardBlockResult(text) {
    return GUARD_BLOCK_RE.test(String(text || ''));
}

export function recallBedHint(agent) {
    try {
        for (const name of ['bed', 'home', 'house']) {
            const p = agent?.memory_bank?.recallPlace?.(name);
            if (Array.isArray(p) && p.length >= 3 && [p[0], p[2]].every(Number.isFinite))
                return { x: Number(p[0]), y: Number(p[1]), z: Number(p[2]) };
            if (p && Number.isFinite(p.x) && Number.isFinite(p.z))
                return { x: p.x, y: p.y, z: p.z };
        }
    } catch { /* memory is optional */ }
    return null;
}

export function criticalSurvivalGuard(bot, commandName, isAutonomous = true, extra = {}) {
    if (!isAutonomous || !bot || !Number.isFinite(bot.health) || !Number.isFinite(bot.food)) return null;
    if (bot.health > 4 && bot.food > 3) return null;
    const ctx = extraOf(extra);
    const args = Array.isArray(ctx.args) ? ctx.args : [];
    const cmd = String(commandName || '');

    if (isFleeOrDefend(cmd, args, bot)) return null;
    if (EAT.has(cmd) || CONTROL.has(cmd)) return null;

    const foodName = firstEdibleName(bot);
    if (foodName) {
        return statusPrefix(bot) +
            `You have ${foodName} in your inventory. Eat now with !consume("${foodName}") before doing anything else.`;
    }

    if (isSurvivalHelp(cmd, args, ctx)) return null;

    return statusPrefix(bot) +
        'Optional action blocked. Prioritize !getFood, !searchForEntity for a cow/pig/sheep, a food chest, or safe shelter. Do not mine, build or take long trips until stabilized.';
}

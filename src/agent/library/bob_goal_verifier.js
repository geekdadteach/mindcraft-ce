// Pure, read-only world-state goal verifier for Bob's eval harness.
// Judges whether Bob achieved what he was trying to do from inventory,
// position, health, food, and a cheap already-loaded block/entity sample.
//
// Never uses task.finished / exec success as a verdict. Never guesses `met`.
// Snapshot capture is synchronous, try/caught, time-boxed, allocation-light.
// Does not pathfind, await the world, chat, or call RepeatGuard.check,
// aiPlayerGuard, getBotOutputSummary, parseCommandMessage, or cooldowns.

export const VERIFIER_VERSION = '1';
export const SNAPSHOT_BUDGET_MS = 8;
export const MAX_INV = 40;
export const MAX_NEARBY = 12;

const VERDICTS = new Set(['met', 'not_met', 'progress', 'unevaluated']);

// [ai-player] Fix 4.11: a task text that says it failed must never be reported as met.
export const FAILURE_PHRASES = Object.freeze([
    // [ai-player] Fix 4.11 review: only unambiguous whole-action failures. Broad words like 'could not'
    // or 'failed' also appear in partial successes, which must stay eligible for met.
    'not confirmed',
    'no path',
    'unreachable',
    "don't have",
    'inventory full',
    'could not find',
    'could not get',
    'timed out',
]);



export function textReportsFailure(text) {
    const s = String(text || '').toLowerCase();
    if (!s) return false;
    return FAILURE_PHRASES.some(p => s.includes(p));
}

const LOG_NAMES = [
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
    'crimson_stem', 'warped_stem',
];

const FOOD_ITEMS = new Set([
    'bread', 'apple', 'golden_apple', 'golden_carrot', 'carrot', 'potato',
    'baked_potato', 'beetroot', 'sweet_berries', 'glow_berries', 'melon_slice',
    'dried_kelp', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'pumpkin_pie',
    'cookie', 'honey_bottle', 'chorus_fruit',
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
    'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
    'tropical_fish', 'rotten_flesh', 'spider_eye',
]);

const HUNT_DROPS = new Set([
    'beef', 'leather', 'porkchop', 'chicken', 'feather', 'mutton', 'wool',
    'rabbit', 'rabbit_hide', 'rabbit_foot', 'bone', 'string', 'gunpowder',
    'ender_pearl', 'blaze_rod', 'arrow',
]);

const SMELT_OUT = {
    raw_iron: 'iron_ingot', iron_ore: 'iron_ingot', deepslate_iron_ore: 'iron_ingot',
    raw_gold: 'gold_ingot', gold_ore: 'gold_ingot', deepslate_gold_ore: 'gold_ingot',
    raw_copper: 'copper_ingot', copper_ore: 'copper_ingot', deepslate_copper_ore: 'copper_ingot',
    cobblestone: 'stone', sand: 'glass', red_sand: 'glass',
    cactus: 'green_dye', clay_ball: 'brick', netherrack: 'nether_brick',
    kelp: 'dried_kelp', potato: 'baked_potato',
    porkchop: 'cooked_porkchop', beef: 'cooked_beef', chicken: 'cooked_chicken',
    mutton: 'cooked_mutton', rabbit: 'cooked_rabbit',
    cod: 'cooked_cod', salmon: 'cooked_salmon',
    ancient_debris: 'netherite_scrap',
};

const ITEM_RE = /^[a-z0-9_]{1,40}$/;
const NEARBY_OFFSETS = [
    [0, 0, 0], [0, -1, 0], [0, 1, 0],
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
    [0, 2, 0],
];

function nowMs() {
    return Date.now();
}

export function sanitizeItemName(value) {
    const text = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    return ITEM_RE.test(text) ? text : null;
}

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function toCount(value, fallback = null) {
    const n = toNum(value);
    if (n == null) return fallback;
    const i = Math.trunc(n);
    return i >= 1 ? i : fallback;
}

export function inventoryMap(inventory) {
    const out = Object.create(null);
    if (!inventory) return out;
    if (Array.isArray(inventory)) {
        for (const item of inventory) {
            const name = sanitizeItemName(item?.name);
            if (!name) continue;
            out[name] = (out[name] || 0) + (Number(item.count) || 0);
        }
        return out;
    }
    if (typeof inventory === 'object') {
        for (const [key, value] of Object.entries(inventory)) {
            const name = sanitizeItemName(key);
            if (!name) continue;
            out[name] = (out[name] || 0) + (Number(value) || 0);
        }
    }
    return out;
}

export function itemAliases(name) {
    const n = sanitizeItemName(name);
    const aliases = new Set();
    if (!n) return aliases;
    aliases.add(n);
    if (n === 'any_log' || n === 'log' || n === 'wood' || n === 'logs' || /_log$|_stem$/.test(n)) {
        for (const log of LOG_NAMES) aliases.add(log);
        aliases.add('any_log');
    }
    if (n === 'stone') aliases.add('cobblestone');
    if (n.endsWith('_ore')) {
        const base = n.replace(/^deepslate_/, '').replace(/_ore$/, '');
        aliases.add(base);
        aliases.add(`raw_${base}`);
        if (base === 'lapis') aliases.add('lapis_lazuli');
        if (n === 'redstone_ore' || n === 'deepslate_redstone_ore') aliases.add('redstone');
        if (n === 'coal_ore' || n === 'deepslate_coal_ore') aliases.add('coal');
        if (n === 'diamond_ore' || n === 'deepslate_diamond_ore') aliases.add('diamond');
        if (n === 'emerald_ore' || n === 'deepslate_emerald_ore') aliases.add('emerald');
    }
    if (n === 'coal') aliases.add('coal_ore');
    return aliases;
}

function countNames(inv, names) {
    let n = 0;
    for (const name of names) n += Number(inv[name] || 0);
    return n;
}

function foodItemCount(inv) {
    let n = 0;
    for (const [name, count] of Object.entries(inv)) {
        if (FOOD_ITEMS.has(name) || name.startsWith('cooked_')) n += Number(count) || 0;
    }
    return n;
}

function dropItemCount(inv) {
    let n = 0;
    for (const [name, count] of Object.entries(inv)) {
        if (HUNT_DROPS.has(name) || FOOD_ITEMS.has(name)) n += Number(count) || 0;
    }
    return n;
}

export function distance3(a, b) {
    if (!a || !b) return null;
    const ax = toNum(a.x), ay = toNum(a.y), az = toNum(a.z);
    const bx = toNum(b.x), by = toNum(b.y), bz = toNum(b.z);
    if (ax == null || ay == null || az == null || bx == null || by == null || bz == null)
        return null;
    const dx = ax - bx, dy = ay - by, dz = az - bz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function clipInv(inv, keep = []) {
    const extra = new Set(keep.filter(Boolean));
    const keys = Object.keys(inv);
    const chosen = [];
    for (const k of extra) {
        if (k in inv) chosen.push(k);
    }
    for (const k of keys) {
        if (chosen.length >= 12) break;
        if (!chosen.includes(k)) chosen.push(k);
    }
    const out = Object.create(null);
    for (const k of chosen) out[k] = inv[k];
    return out;
}

export function compactSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return null;
    const inv = inventoryMap(snap.inventory);
    const out = {
        pos: snap.position || null,
        health: snap.health ?? null,
        food: snap.food ?? null,
        dim: snap.dimension || null,
        inv: clipInv(inv),
    };
    if (snap.target_kind) {
        out.target_kind = snap.target_kind;
        out.target_present = snap.target_present === true;
        if (Number.isFinite(snap.target_distance))
            out.target_distance = Math.round(snap.target_distance * 10) / 10;
        if (Number.isFinite(snap.target_nearby))
            out.target_nearby = snap.target_nearby;
    }
    if (Array.isArray(snap.nearby_blocks) && snap.nearby_blocks.length)
        out.blocks = snap.nearby_blocks.slice(0, 8).map((b) => ({
            n: String(b.name || '').slice(0, 40),
            x: b.x, y: b.y, z: b.z,
        }));
    return out;
}

export function evidenceOf(before, after, keep = []) {
    const bInv = inventoryMap(before?.inventory);
    const aInv = inventoryMap(after?.inventory);
    const names = new Set([...keep.filter(Boolean), ...Object.keys(bInv), ...Object.keys(aInv)]);
    const items = Object.create(null);
    for (const name of names) {
        const d = (aInv[name] || 0) - (bInv[name] || 0);
        if (d !== 0) items[name] = d;
        if (Object.keys(items).length >= 12) break;
    }
    return {
        before: compactSnapshot(before),
        after: compactSnapshot(after),
        delta: {
            items,
            health: (toNum(after?.health) ?? 0) - (toNum(before?.health) ?? 0),
            food: (toNum(after?.food) ?? 0) - (toNum(before?.food) ?? 0),
            dist: distance3(before?.position, after?.position),
        },
    };
}

function result(verdict, verifier, reason, before, after, keep) {
    const v = VERDICTS.has(verdict) ? verdict : 'unevaluated';
    return {
        verdict: v,
        verifier,
        verifier_version: VERIFIER_VERSION,
        verdict_source: verifier,
        reason,
        evidence: evidenceOf(before, after, keep),
        task_finished_is_not_goal_outcome: true,
    };
}

function unevaluated(verifier, reason, before, after, keep) {
    return result('unevaluated', verifier, reason, before, after, keep);
}

function budgetOk(started, budget = SNAPSHOT_BUDGET_MS) {
    return (nowMs() - started) < budget;
}

function readInventory(bot, started) {
    const items = [];
    try {
        const list = typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : [];
        for (const item of list) {
            if (!budgetOk(started)) break;
            if (items.length >= MAX_INV) break;
            if (!item?.name) continue;
            items.push({ name: String(item.name).slice(0, 40), count: Number(item.count) || 0 });
        }
    } catch { /* inventory must never throw */ }
    return items;
}

function readNearbyBlocks(bot, started) {
    const out = [];
    try {
        const p = bot?.entity?.position;
        if (!p || typeof bot.blockAt !== 'function') return out;
        for (const [dx, dy, dz] of NEARBY_OFFSETS) {
            if (!budgetOk(started) || out.length >= MAX_NEARBY) break;
            const x = Math.floor(p.x + dx);
            const y = Math.floor(p.y + dy);
            const z = Math.floor(p.z + dz);
            let block = null;
            try { block = bot.blockAt({ x, y, z }); }
            catch {
                try { block = bot.blockAt(p.offset ? p.offset(dx, dy, dz) : { x, y, z }); }
                catch { block = null; }
            }
            const name = block?.name;
            if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') continue;
            out.push({ name: String(name).slice(0, 40), x, y, z });
        }
    } catch { /* nearby sample must never throw */ }
    return out;
}

function readTarget(bot, hint, started) {
    const out = {
        target_kind: null,
        target_present: false,
        target_distance: null,
        target_nearby: null,
    };
    if (!bot || !hint) return out;
    try {
        const me = bot.entity?.position;
        if (hint.player_lookup && bot.players && typeof bot.players === 'object') {
            out.target_kind = 'player';
            const name = String(hint.player_lookup);
            const ent = bot.players[name]?.entity;
            if (ent?.position && me) {
                out.target_present = true;
                out.target_distance = distance3(me, ent.position);
                out.target_nearby = 1;
            } else {
                out.target_present = false;
                out.target_nearby = 0;
            }
            return out;
        }
        if (hint.entity && bot.entities && typeof bot.entities === 'object') {
            out.target_kind = 'entity';
            const want = String(hint.entity).toLowerCase();
            let nearest = Infinity;
            let n = 0;
            for (const ent of Object.values(bot.entities)) {
                if (!budgetOk(started)) break;
                const type = String(ent?.name || ent?.displayName || '').toLowerCase();
                if (!type || type !== want) continue;
                if (ent === bot.entity) continue;
                n += 1;
                if (me && ent.position) {
                    const d = distance3(me, ent.position);
                    if (d != null && d < nearest) nearest = d;
                }
            }
            out.target_nearby = n;
            out.target_present = n > 0;
            out.target_distance = Number.isFinite(nearest) ? nearest : null;
        }
    } catch { /* target probe must never throw */ }
    return out;
}

// hint may include already-parsed command args for a one-shot target probe.
// Player names are used only to compute distance and are not stored.
export function captureWorldSnapshot(agent, hint = {}) {
    const started = nowMs();
    const out = {
        position: null,
        health: null,
        food: null,
        dimension: null,
        inventory: [],
        nearby_blocks: [],
        target_kind: null,
        target_present: false,
        target_distance: null,
        target_nearby: null,
        captured_ms: 0,
        ok: false,
    };
    try {
        const bot = agent?.bot;
        out.ok = !!(bot && (bot.entity || bot.inventory || Number.isFinite(bot.health) || Number.isFinite(bot.food)));
        const p = bot?.entity?.position;
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
            out.position = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
        if (Number.isFinite(bot?.health)) out.health = Math.round(bot.health);
        if (Number.isFinite(bot?.food)) out.food = Math.round(bot.food);
        const dim = bot?.game?.dimension || bot?.dimension || null;
        if (typeof dim === 'string') out.dimension = dim.slice(0, 40);
        out.inventory = readInventory(bot, started);
        if (budgetOk(started)) out.nearby_blocks = readNearbyBlocks(bot, started);
        if (budgetOk(started)) Object.assign(out, readTarget(bot, hint, started));
    } catch { /* snapshot must never throw */ }
    out.captured_ms = Math.max(0, nowMs() - started);
    return out;
}

export function describeCommand(name, args) {
    const command = /^![A-Za-z0-9_]{1,40}$/.test(String(name || '')) ? String(name) : null;
    const out = { command };
    const list = Array.isArray(args) ? args : [];
    if (!command) return out;
    switch (command) {
        case '!collectBlocks':
            out.item = sanitizeItemName(list[0]);
            out.count = toCount(list[1], 1);
            break;
        case '!gatherWood':
            out.item = 'any_log';
            out.count = toCount(list[0], 1);
            break;
        case '!goToCoordinates':
            out.x = toNum(list[0]);
            out.y = toNum(list[1]);
            out.z = toNum(list[2]);
            out.closeness = toNum(list[3]) ?? 2;
            break;
        case '!goToPlayer':
        case '!followPlayer':
            out.target = 'player';
            out.closeness = toNum(list[1]) ?? 2;
            out.player_lookup = typeof list[0] === 'string' ? list[0] : null;
            break;
        case '!moveAway':
            out.distance = toNum(list[0]);
            break;
        case '!craftRecipe':
            out.item = sanitizeItemName(list[0]);
            out.count = toCount(list[1], 1);
            break;
        case '!smeltItem':
            out.item = sanitizeItemName(list[0]);
            out.count = toCount(list[1], 1);
            break;
        case '!placeHere':
            out.block = sanitizeItemName(list[0]);
            break;
        case '!attack':
            out.entity = sanitizeItemName(list[0]);
            break;
        case '!attackPlayer':
            out.target = 'player';
            out.player_lookup = typeof list[0] === 'string' ? list[0] : null;
            break;
        case '!consume':
            out.item = sanitizeItemName(list[0]);
            break;
        case '!getFood':
            break;
        default:
            break;
    }
    return out;
}

export function publicDescriptor(desc) {
    if (!desc || typeof desc !== 'object') return null;
    const out = { ...desc };
    delete out.player_lookup;
    return out;
}

const COLLECT_CMDS = new Set(['!collectBlocks', '!gatherWood']);
const NAV_CMDS = new Set(['!goToCoordinates', '!goToPlayer', '!followPlayer', '!moveAway']);
const FOOD_CMDS = new Set(['!getFood', '!consume']);
const CRAFT_CMDS = new Set(['!craftRecipe', '!smeltItem']);
const PLACE_CMDS = new Set(['!placeHere']);
const ATTACK_CMDS = new Set(['!attack', '!attackPlayer']);

export function mapGoalText(text) {
    const s = String(text || '').toLowerCase();
    if (!s.trim()) return { kind: null, item: null, count: null };
    const cmd = s.match(/!(collectblocks|gatherwood|gotocoordinates|gotoplayer|moveaway|getfood|consume|craftrecipe|smeltitem|placehere|attack)\b/);
    if (cmd) {
        const name = `!${cmd[1] === 'collectblocks' ? 'collectBlocks'
            : cmd[1] === 'gatherwood' ? 'gatherWood'
            : cmd[1] === 'gotocoordinates' ? 'goToCoordinates'
            : cmd[1] === 'gotoplayer' ? 'goToPlayer'
            : cmd[1] === 'moveaway' ? 'moveAway'
            : cmd[1] === 'getfood' ? 'getFood'
            : cmd[1] === 'craftrecipe' ? 'craftRecipe'
            : cmd[1] === 'smeltitem' ? 'smeltItem'
            : cmd[1] === 'placehere' ? 'placeHere'
            : cmd[1]}`;
        return { kind: kindForCommand(name), item: extractItem(s), count: extractCount(s), command: name };
    }
    if (/\b(eat|food|hunger|hungry|hunt|berries|cook)\b/.test(s))
        return { kind: 'food', item: extractItem(s), count: extractCount(s) };
    if (/\b(survive|survival|heal|health|don'?t die|starv)\b/.test(s))
        return { kind: 'survival', item: null, count: null };
    if (/\b(attack|kill|slay)\b/.test(s))
        return { kind: 'attack', item: extractItem(s), count: extractCount(s) };
    if (/\b(craft|smelt)\b/.test(s))
        return { kind: 'craft', item: extractItem(s), count: extractCount(s) };
    if (/\b(place|build|shelter|house)\b/.test(s))
        return { kind: 'place', item: extractItem(s), count: extractCount(s) };
    if (/\b(go to|goto|walk to|travel|move away|follow)\b/.test(s))
        return { kind: 'navigate', item: null, count: extractCount(s) };
    if (/\b(collect|gather|mine|chop|wood|log|ore|cobble)\b/.test(s))
        return { kind: 'collect', item: extractItem(s), count: extractCount(s) };
    return { kind: null, item: extractItem(s), count: extractCount(s) };
}

function extractCount(text) {
    const m = String(text).match(/\b(\d{1,3})\b/);
    return m ? toCount(m[1]) : null;
}

function extractItem(text) {
    const quoted = String(text).match(/["']([a-z0-9_]+)["']/i);
    if (quoted) return sanitizeItemName(quoted[1]);
    const named = String(text).toLowerCase().match(
        /\b([a-z]+_(?:log|ore|ingot|planks|block)|oak_log|cobblestone|cobble|wood|stone|iron|coal|dirt|torch|bread)\b/
    );
    if (!named) return null;
    const raw = named[1] === 'cobble' ? 'cobblestone'
        : named[1] === 'wood' ? 'any_log'
        : named[1] === 'iron' ? 'raw_iron'
        : named[1];
    return sanitizeItemName(raw);
}

export function kindForCommand(command) {
    if (COLLECT_CMDS.has(command)) return 'collect';
    if (NAV_CMDS.has(command)) return 'navigate';
    if (FOOD_CMDS.has(command)) return 'food';
    if (CRAFT_CMDS.has(command)) return 'craft';
    if (PLACE_CMDS.has(command)) return 'place';
    if (ATTACK_CMDS.has(command)) return 'attack';
    return null;
}

function verifyCollect(before, after, desc) {
    const item = desc.item;
    if (!item) return unevaluated('collect', 'No target item; cannot judge gathering.', before, after);
    if (!before || !after)
        return unevaluated('collect', 'Need before and after snapshots.', before, after, [item]);
    const aliases = itemAliases(item);
    const b = countNames(inventoryMap(before?.inventory), aliases);
    const a = countNames(inventoryMap(after?.inventory), aliases);
    if (before?.inventory == null && after?.inventory == null)
        return unevaluated('collect', 'Inventory unavailable.', before, after, [item]);
    const gained = a - b;
    const need = toCount(desc.count, 1);
    if (gained >= need) return result('met', 'collect', `Inventory gained ${gained} ${item} (need ${need}).`, before, after, [...aliases]);
    if (gained > 0) return result('progress', 'collect', `Inventory gained ${gained} ${item}, short of ${need}.`, before, after, [...aliases]);
    return result('not_met', 'collect', `No inventory gain of ${item}.`, before, after, [...aliases]);
}

function verifyNavigate(before, after, desc) {
    if (!before || !after)
        return unevaluated('navigate', 'Need before and after snapshots.', before, after);
    if (desc.command === '!moveAway') {
        const moved = distance3(before?.position, after?.position);
        const need = toNum(desc.distance);
        if (moved == null || !before?.position || !after?.position)
            return unevaluated('navigate', 'Positions unavailable.', before, after);
        if (need == null)
            return moved > 1
                ? result('progress', 'navigate', `Moved ${moved.toFixed(1)} blocks.`, before, after)
                : result('not_met', 'navigate', 'Did not move away.', before, after);
        if (moved + 1e-6 >= need * 0.75)
            return result('met', 'navigate', `Moved ${moved.toFixed(1)} (need ${need}).`, before, after);
        if (moved > 1)
            return result('progress', 'navigate', `Moved ${moved.toFixed(1)}, short of ${need}.`, before, after);
        return result('not_met', 'navigate', 'Did not move away.', before, after);
    }
    const closeness = toNum(desc.closeness) ?? 2;
    if (desc.command === '!goToCoordinates' || (desc.x != null && desc.z != null)) {
        if (desc.x == null || desc.y == null || desc.z == null)
            return unevaluated('navigate', 'Target coordinates missing.', before, after);
        const dist = distance3(after?.position, { x: desc.x, y: desc.y, z: desc.z });
        const prev = distance3(before?.position, { x: desc.x, y: desc.y, z: desc.z });
        if (dist == null)
            return unevaluated('navigate', 'Position unavailable.', before, after);
        if (dist <= closeness + 0.51)
            return result('met', 'navigate', `Distance ${dist.toFixed(1)} within ${closeness}.`, before, after);
        if (prev != null && dist < prev - 1)
            return result('progress', 'navigate', `Closer (${prev.toFixed(1)} → ${dist.toFixed(1)}).`, before, after);
        return result('not_met', 'navigate', `Distance ${dist.toFixed(1)} outside ${closeness}.`, before, after);
    }
    if (desc.target === 'player' || desc.command === '!goToPlayer' || desc.command === '!followPlayer') {
        const dist = toNum(after?.target_distance);
        const prev = toNum(before?.target_distance);
        if (dist == null && after?.target_present !== true)
            return unevaluated('navigate', 'Player target not visible in loaded entities.', before, after);
        if (dist != null && dist <= closeness + 0.51)
            return result('met', 'navigate', `Player distance ${dist.toFixed(1)} within ${closeness}.`, before, after);
        if (prev != null && dist != null && dist < prev - 1)
            return result('progress', 'navigate', `Closer to player (${prev.toFixed(1)} → ${dist.toFixed(1)}).`, before, after);
        if (dist != null)
            return result('not_met', 'navigate', `Player distance ${dist.toFixed(1)} outside ${closeness}.`, before, after);
        return unevaluated('navigate', 'Player distance unknown.', before, after);
    }
    return unevaluated('navigate', 'No navigation target.', before, after);
}

function verifyFood(before, after, desc) {
    if (!before || !after)
        return unevaluated('food', 'Need before and after snapshots.', before, after);
    if (before?.food == null && after?.food == null && !before?.inventory && !after?.inventory)
        return unevaluated('food', 'Food level and inventory unavailable.', before, after);
    const bf = toNum(before?.food);
    const af = toNum(after?.food);
    const foodDelta = (bf != null && af != null) ? af - bf : null;
    const itemsBefore = foodItemCount(inventoryMap(before?.inventory));
    const itemsAfter = foodItemCount(inventoryMap(after?.inventory));
    const itemDelta = itemsAfter - itemsBefore;
    if (desc.command === '!consume' && desc.item) {
        const consumed = countNames(inventoryMap(before?.inventory), [desc.item])
            - countNames(inventoryMap(after?.inventory), [desc.item]);
        if (foodDelta != null && foodDelta > 0)
            return result('met', 'food', `Food rose by ${foodDelta} after consume.`, before, after, [desc.item]);
        if (consumed > 0 && (after?.food == null || foodDelta === 0 || foodDelta == null))
            return result('progress', 'food', `Consumed ${desc.item} but food did not rise.`, before, after, [desc.item]);
        return result('not_met', 'food', 'Did not consume food or gain hunger.', before, after, [desc.item]);
    }
    if (foodDelta != null && foodDelta > 0)
        return result('met', 'food', `Food level rose by ${foodDelta}.`, before, after);
    if (itemDelta > 0)
        return result('met', 'food', `Gained ${itemDelta} food item(s).`, before, after);
    if (foodDelta == null && !before?.inventory && !after?.inventory)
        return unevaluated('food', 'Food level and inventory unavailable.', before, after);
    return result('not_met', 'food', 'Food level did not rise and no food items were gained.', before, after);
}

function verifyCraft(before, after, desc) {
    const input = desc.item;
    if (!input) return unevaluated('craft', 'No recipe/item name.', before, after);
    if (!before || !after)
        return unevaluated('craft', 'Need before and after snapshots.', before, after, [input]);
    const want = desc.command === '!smeltItem' ? (SMELT_OUT[input] || null) : input;
    if (desc.command === '!smeltItem' && !want)
        return unevaluated('craft', `No smelt output mapping for ${input}; not guessing.`, before, after, [input]);
    const b = countNames(inventoryMap(before?.inventory), [want]);
    const a = countNames(inventoryMap(after?.inventory), [want]);
    if (before?.inventory == null && after?.inventory == null)
        return unevaluated('craft', 'Inventory unavailable.', before, after, [want]);
    const gained = a - b;
    const need = toCount(desc.count, 1);
    if (gained >= need) return result('met', 'craft', `Gained ${gained} ${want}.`, before, after, [input, want]);
    if (gained > 0) return result('progress', 'craft', `Gained ${gained} ${want}, short of ${need}.`, before, after, [input, want]);
    return result('not_met', 'craft', `No inventory gain of ${want}.`, before, after, [input, want]);
}

function verifyPlace(before, after, desc) {
    const block = desc.block || desc.item;
    if (!block) return unevaluated('place', 'No expected block type.', before, after);
    if (!after)
        return unevaluated('place', 'Need an after snapshot.', before, after, [block]);
    const spots = Array.isArray(after?.nearby_blocks) ? after.nearby_blocks : [];
    const aliases = new Set([block, block.replace(/_block$/, ''), `${block}_block`]);
    const found = spots.some((b) => aliases.has(String(b?.name || '')));
    if (!spots.length && !after?.nearby_blocks)
        return unevaluated('place', 'No nearby-block sample.', before, after, [block]);
    if (found) return result('met', 'place', `Found ${block} in the nearby sample.`, before, after, [block]);
    return result('not_met', 'place', `${block} not present in the nearby sample.`, before, after, [block]);
}

function verifyAttack(before, after, desc) {
    if (!before || !after)
        return unevaluated('attack', 'Need before and after snapshots.', before, after);
    const dropsB = dropItemCount(inventoryMap(before?.inventory));
    const dropsA = dropItemCount(inventoryMap(after?.inventory));
    const drops = dropsA - dropsB;
    const seenBefore = before?.target_present === true;
    const gone = seenBefore && after?.target_present === false;
    if (gone || drops > 0) {
        if (gone)
            return result('met', 'attack', 'Target no longer in the loaded sample.', before, after);
        return result('met', 'attack', `Gained ${drops} drop/food item(s).`, before, after);
    }
    if (before?.target_kind == null && after?.target_kind == null && desc.entity == null && desc.target !== 'player')
        return unevaluated('attack', 'No target type and no entity sample.', before, after);
    if (!seenBefore && after?.target_present !== true && drops === 0)
        return unevaluated('attack', 'Target never observed in the loaded sample.', before, after);
    return result('not_met', 'attack', 'Target still present (or unknown) and no drops gained.', before, after);
}

function verifySurvival(before, after) {
    if (!before || !after)
        return unevaluated('survival', 'Need before and after snapshots.', before, after);
    if (before?.health == null && after?.health == null && before?.food == null && after?.food == null)
        return unevaluated('survival', 'Health and food unavailable.', before, after);
    const died = (toNum(after?.health) === 0 && (toNum(before?.health) ?? 1) > 0)
        || ((toNum(after?.deaths) ?? 0) > (toNum(before?.deaths) ?? 0));
    if (died) return result('not_met', 'survival', 'Death detected between snapshots.', before, after);
    const h = (toNum(after?.health) ?? 0) - (toNum(before?.health) ?? 0);
    const f = (toNum(after?.food) ?? 0) - (toNum(before?.food) ?? 0);
    if (h > 0 || f > 0)
        return result('met', 'survival', `Health ${h >= 0 ? '+' : ''}${h}, food ${f >= 0 ? '+' : ''}${f}.`, before, after);
    if (h < 0 || f < 0)
        return result('not_met', 'survival', `Health/food declined (h ${h}, f ${f}).`, before, after);
    return result('progress', 'survival', 'Alive; health and food unchanged.', before, after);
}

function runKind(kind, before, after, desc) {
    switch (kind) {
        case 'collect': return verifyCollect(before, after, desc);
        case 'navigate': return verifyNavigate(before, after, desc);
        case 'food': return verifyFood(before, after, desc);
        case 'craft': return verifyCraft(before, after, desc);
        case 'place': return verifyPlace(before, after, desc);
        case 'attack': return verifyAttack(before, after, desc);
        case 'survival': return verifySurvival(before, after);
        default: return unevaluated('unknown', 'No verifier mapped; not guessing met.', before, after);
    }
}

export function verifyGoal(input = {}) {
    try {
        const before = input.before || null;
        const after = input.after || null;
        const desc = { ...(input.descriptor || {}) };
        const mapped = mapGoalText(input.goalText || '');
        if (!desc.command && mapped.command) desc.command = mapped.command;
        if (!desc.item && mapped.item) desc.item = mapped.item;
        if (desc.count == null && mapped.count != null) desc.count = mapped.count;
        if (!desc.block && mapped.kind === 'place' && mapped.item) desc.block = mapped.item;
        if (!desc.entity && mapped.kind === 'attack' && mapped.item) desc.entity = mapped.item;

        const kind = kindForCommand(desc.command) || mapped.kind;
        if (!kind) {
            return unevaluated(
                'unknown',
                'Goal text and command were too vague; not guessing met.',
                before,
                after,
            );
        }
        if (!before && !after)
            return unevaluated(kind, 'No world snapshots.', before, after);
        const outcome = runKind(kind, before, after, desc);
        // [ai-player] Fix 4.11 review: a task text that says it failed can never be met. Only a 'met'
        // verdict is downgraded, so the kind verifier's own label is kept when it already said not_met.
        const resultText = input.resultText ?? input.result ?? input.result_summary ?? '';
        if (outcome?.verdict === 'met' && textReportsFailure(resultText)) {
            return result('not_met', 'result-text', `Task text reports failure: "${String(resultText).slice(0, 120)}"`, before, after);
        }
        return outcome;
    } catch {
        return unevaluated('unknown', 'Verifier threw; left unevaluated.', input.before, input.after);
    }
}

export function snapshotHintFromDescriptor(desc) {
    if (!desc) return {};
    const hint = {};
    if (desc.player_lookup) hint.player_lookup = desc.player_lookup;
    if (desc.entity) hint.entity = desc.entity;
    return hint;
}

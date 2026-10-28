// Optional operator-triggered GriefPrevention helper. Never runs on its own.
// Corners are the 128×128 claim; GP claims are full height and do not confine the owner.
//
// GriefPrevention 16.18.7 /claimslist (GriefPrevention.java:2314-2363):
//   getfriendlyLocationString(lesserCorner) + ContinueBlockMath(area)
//   getfriendlyLocationString = world + ": x" + blockX + ", z" + blockZ
//   ContinueBlockMath default = " (-{0} blocks)"
// So a real line is `world: x-1208, z688 (-16384 blocks)` — lesser corner only.
import pf from 'mineflayer-pathfinder';
import { CLAIM, claimArea, claimBounds } from './bob_claim.js';
import { botGetBlock } from './vec3_util.js';
import { CLAIMS_LIST_CMD, chatGuardArmed, isPlayerChatLine, sendFixedClaimsListCommand } from './chat_guard.js';

export const CLAIM_PLUGIN = Object.freeze({
    name: 'GriefPrevention',
    versionHint: '16.18.7',
    tool: 'golden_shovel',
    listCommand: CLAIMS_LIST_CMD,
    adminFallback: ['/adminclaims', '/transferclaim MineBobNE'],
    notes: 'Fallback only. Operator is creating claim #26 server-side. Do not use NewEarthRules safe zones. WorldGuard is not installed.',
    claimsListFormat: 'world: x{lesserX}, z{lesserZ} (-{area} blocks)',
});

export function claimCorners(claim = CLAIM) {
    const b = claimBounds(claim);
    return Object.freeze([
        Object.freeze({ x: b.x1, z: b.z1 }),
        Object.freeze({ x: b.x2, z: b.z2 }),
    ]);
}

// GP 16.18.7 lesser-corner listing. The minus before area is ContinueBlockMath.
// Overworld only: require the world name "world:". Ignore nether / end (world_nether, world_the_end).
export const OVERWORLD_WORLD = 'world';
export const LIST_WAIT_MS = 5000;
const GP_CLAIM_LINE_RE = /(?:^|\n)(world):\s*x(-?\d+),\s*z(-?\d+)\s*\((-)?(\d+)\s*blocks\)/gi;

export function isOverworldWorld(name) {
    return String(name || '').trim().toLowerCase() === OVERWORLD_WORLD;
}

export function parseGpClaimLine(line) {
    const m = /^\s*(world):\s*x(-?\d+),\s*z(-?\d+)\s*\((-)?(\d+)\s*blocks\)\s*$/i.exec(String(line || '').trim());
    if (!m) return null;
    return { world: m[1].trim(), x: Number(m[2]), z: Number(m[3]), area: Number(m[5]), line: String(line).trim() };
}

// A recognized GP /claimslist reply, even with zero claims. Anything else after the wait is unknown.
export function isGpClaimsListReply(text) {
    const s = String(text || '');
    if (/blocks from play/i.test(s)) return true;
    if (/\bClaims:/i.test(s)) return true;
    if (/blocks left to spend/i.test(s)) return true;
    if (/\bworld:\s*x-?\d+,\s*z-?\d+\s*\(-?\d+\s*blocks\)/i.test(s)) return true;
    return false;
}

export function gpClaimsListLine({ world = 'world', x, z, area }) {
    return `${world}: x${x}, z${z} (-${area} blocks)`;
}

export function gpClaimsListOutput(claims, { accrued = 20000, bonus = 0 } = {}) {
    const list = Array.isArray(claims) ? claims : [];
    const total = accrued + bonus;
    const spent = list.reduce((s, c) => s + Number(c.area || 0), 0);
    return [
        `${accrued} blocks from play + ${bonus} bonus = ${total} total.`,
        'Claims:',
        ...list.map((c) => gpClaimsListLine(c)),
        ` = ${total - spent} blocks left to spend`,
    ].join('\n');
}

export function parseClaimsList(text, { username = 'MineBobNE', claim = CLAIM } = {}) {
    const raw = String(text || '');
    const lines = raw.split(/\r?\n/);
    const claims = [];
    GP_CLAIM_LINE_RE.lastIndex = 0;
    let m;
    while ((m = GP_CLAIM_LINE_RE.exec(raw))) {
        const world = m[1].trim();
        if (!isOverworldWorld(world)) continue;
        claims.push({ world, x: Number(m[2]), z: Number(m[3]), area: Number(m[5]), line: m[0].trim() });
    }
    const b = claimBounds(claim);
    const wantArea = claimArea(claim);
    const matching = claims.find((c) => c.x === b.x1 && c.z === b.z1 && c.area === wantArea) || null;
    const lesserOnly = claims.find((c) => c.x === b.x1 && c.z === b.z1) || null;
    return {
        raw,
        claims,
        matching,
        mentionsUser: new RegExp(username, 'i').test(raw),
        coversClaim: !!matching,
        lesserMatches: !!lesserOnly,
        areaMatches: matching ? matching.area === wantArea : (lesserOnly ? lesserOnly.area === wantArea : false),
        expected: { x: b.x1, z: b.z1, area: wantArea },
        corners: claimCorners(claim),
        lines: lines.filter((l) => /claim|blocks|x-?\d+/i.test(l)).slice(0, 16),
    };
}

export function findSurfaceY(getBlock, x, z, { fromY = 80, toY = 50 } = {}) {
    for (let y = fromY; y >= toY; y--) {
        let feet = null, below = null;
        try { feet = getBlock(x, y, z); } catch (_) { continue; }
        try { below = getBlock(x, y - 1, z); } catch (_) { continue; }
        const fn = String(feet?.name || 'air');
        const belowSolid = below && (below.boundingBox === 'block' || (below.name && below.name !== 'air' && below.name !== 'cave_air'));
        if ((fn === 'air' || fn === 'cave_air') && belowSolid) return y;
    }
    return null;
}

export function holdingGoldenShovel(bot) {
    const name = bot?.heldItem?.name || bot?.heldItem;
    return typeof name === 'string' && name === 'golden_shovel';
}

async function defaultEquip(bot) {
    if (holdingGoldenShovel(bot)) return true;
    const fromItems = typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : [];
    const fromSlots = Array.isArray(bot?.inventory?.slots) ? bot.inventory.slots : [];
    const item = [...fromItems, ...fromSlots].find((s) => s && s.name === 'golden_shovel');
    if (!item || typeof bot?.equip !== 'function') return false;
    await bot.equip(item, 'hand');
    return holdingGoldenShovel(bot);
}

async function defaultGoto(agent, x, y, z) {
    if (agent?.escape?.gotoChecked) {
        return agent.escape.gotoChecked(agent, new pf.goals.GoalNear(x, y, z, 2), {
            ms: 120000, label: 'claim-corner',
        });
    }
    return false;
}

function defaultChat(bot) {
    return (cmd) => {
        if (cmd !== CLAIMS_LIST_CMD) return;
        if (chatGuardArmed(bot)) sendFixedClaimsListCommand(bot);
    };
}

async function collectClaimsList(bot, sendList, wait, waitMs = LIST_WAIT_MS) {
    const lines = [];
    const onMsg = (message, position, jsonMsg, sender) => {
        if (isPlayerChatLine(message, position, jsonMsg, sender)) return;
        lines.push(String(message || ''));
    };
    bot?.on?.('messagestr', onMsg);
    try {
        sendList(CLAIM_PLUGIN.listCommand);
        await wait(waitMs);
    } finally {
        bot?.removeListener?.('messagestr', onMsg);
    }
    const raw = lines.join('\n');
    return { raw, recognized: isGpClaimsListReply(raw) };
}

function resultShape({ ok, refused, aborted, alreadyExists, steps, parsed, corners }) {
    return {
        ok,
        refused,
        aborted,
        alreadyExists,
        plugin: CLAIM_PLUGIN.name,
        steps,
        corners,
        claimsList: parsed,
        fallback: ok ? null : CLAIM_PLUGIN.adminFallback,
        approval: 'Requires Randy approval before use on the live server.',
    };
}

export async function claimProperty(agent, {
    getBlock,
    activateBlock,
    equip,
    chat,
    goto,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    username = agent?.name || 'MineBobNE',
    approved = false,
} = {}) {
    const corners = claimCorners();
    if (approved !== true) {
        return resultShape({
            ok: false, refused: true, steps: [], parsed: parseClaimsList('', { username }), corners,
        });
    }
    const bot = agent?.bot;
    const sendList = typeof chat === 'function' ? chat : defaultChat(bot);
    const listedRaw = await collectClaimsList(bot, sendList, wait);
    const listed = parseClaimsList(listedRaw.raw, { username });
    if (!listedRaw.recognized) {
        return resultShape({
            ok: false, aborted: true,
            steps: ['aborted: /claimslist reply unknown; not treating as no claim'],
            parsed: listed, corners,
        });
    }
    if (listed.coversClaim) {
        return resultShape({
            ok: true, alreadyExists: true,
            steps: ['existing claim covers the 128x128; nothing to do'],
            parsed: listed, corners,
        });
    }

    const steps = ['no covering claim in /claimslist; fallback create'];
    const doEquip = typeof equip === 'function' ? equip : () => defaultEquip(bot);
    await doEquip('golden_shovel');
    if (!holdingGoldenShovel(bot)) {
        steps.push('aborted: golden_shovel is not in hand');
        return resultShape({ ok: false, aborted: true, steps, parsed: listed, corners });
    }
    steps.push('golden_shovel in hand');
    const blockAt = getBlock || botGetBlock(bot);
    const walk = typeof goto === 'function' ? goto : (x, y, z) => defaultGoto(agent, x, y, z);
    const click = typeof activateBlock === 'function' ? activateBlock
        : (blk) => (bot?.activateBlock ? bot.activateBlock(blk) : null);
    for (const c of corners) {
        if (!holdingGoldenShovel(bot)) {
            steps.push('aborted: golden_shovel left the hand');
            break;
        }
        const yGuess = findSurfaceY(blockAt, c.x, c.z) ?? 65;
        const reached = await walk(c.x, yGuess, c.z);
        if (!reached) {
            steps.push(`could not reach ${c.x} ${c.z}`);
            continue;
        }
        const y = findSurfaceY(blockAt, c.x, c.z);
        if (y == null) {
            steps.push(`no surface at ${c.x} ${c.z}`);
            continue;
        }
        const block = blockAt(c.x, y - 1, c.z);
        if (!block || (block.boundingBox && block.boundingBox !== 'block')) {
            steps.push(`no solid block at ${c.x} ${y - 1} ${c.z}`);
            continue;
        }
        if (!holdingGoldenShovel(bot)) {
            steps.push(`aborted before click at ${c.x} ${c.z}: golden_shovel is not in hand`);
            break;
        }
        if (typeof click !== 'function') {
            steps.push(`no activateBlock for ${c.x} ${y - 1} ${c.z}`);
            continue;
        }
        await click(block);
        steps.push(`clicked ${c.x} ${y - 1} ${c.z}`);
        await wait(400);
    }
    const afterRaw = await collectClaimsList(bot, sendList, wait);
    const parsed = parseClaimsList(afterRaw.raw, { username });
    if (!afterRaw.recognized) {
        steps.push('aborted: /claimslist reply unknown after create; not treating as success');
        return resultShape({ ok: false, aborted: true, steps, parsed, corners });
    }
    return resultShape({ ok: parsed.coversClaim, steps, parsed, corners });
}

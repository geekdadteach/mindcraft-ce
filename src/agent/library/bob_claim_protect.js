// Optional operator-triggered GriefPrevention helper. Never runs on its own.
// Corners are the 128×128 claim; GP claims are full height and do not confine the owner.
import pf from 'mineflayer-pathfinder';
import { CLAIM, claimBounds } from './bob_claim.js';
import { botGetBlock } from './vec3_util.js';

export const CLAIM_PLUGIN = Object.freeze({
    name: 'GriefPrevention',
    versionHint: '16.18.7',
    tool: 'golden_shovel',
    listCommand: '/claimslist',
    adminFallback: ['/adminclaims', '/transferclaim MineBobNE'],
    notes: 'Do not use NewEarthRules safe zones (they disable hostile mobs). WorldGuard is not installed.',
});

export function claimCorners(claim = CLAIM) {
    const b = claimBounds(claim);
    return Object.freeze([
        Object.freeze({ x: b.x1, z: b.z1 }),
        Object.freeze({ x: b.x2, z: b.z2 }),
    ]);
}

function pairOnLine(line, x, z) {
    return new RegExp(`(?:^|[^\\d-])${x}(?:\\s*,\\s*-?\\d+)?\\s*[, ]\\s*${z}(?:[^\\d]|$)`).test(String(line));
}

export function parseClaimsList(text, { username = 'MineBobNE' } = {}) {
    const raw = String(text || '');
    const lines = raw.split(/\r?\n/);
    const mentions = lines.filter((l) => new RegExp(username, 'i').test(l) || /claim/i.test(l));
    const b = claimBounds();
    const hasSW = lines.some((l) => pairOnLine(l, b.x1, b.z1));
    const hasNE = lines.some((l) => pairOnLine(l, b.x2, b.z2));
    return {
        raw,
        mentionsUser: new RegExp(username, 'i').test(raw),
        coversClaim: hasSW && hasNE,
        corners: claimCorners(),
        lines: mentions.slice(0, 12),
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

async function defaultGoto(agent, x, y, z) {
    if (agent?.escape?.gotoChecked) {
        return agent.escape.gotoChecked(agent, new pf.goals.GoalNear(x, y, z, 2), {
            ms: 120000, label: 'claim-corner',
        });
    }
    return false;
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
    if (approved !== true) {
        return {
            ok: false,
            refused: true,
            plugin: CLAIM_PLUGIN.name,
            steps: [],
            corners: claimCorners(),
            fallback: CLAIM_PLUGIN.adminFallback,
            approval: 'Requires Randy approval before use on the live server (approved:true).',
        };
    }
    const bot = agent?.bot;
    const corners = claimCorners();
    const blockAt = getBlock || botGetBlock(bot);
    const steps = [];
    if (typeof equip === 'function') {
        await equip('golden_shovel');
        steps.push('equipped golden_shovel');
    }
    const walk = typeof goto === 'function' ? goto : (x, y, z) => defaultGoto(agent, x, y, z);
    for (const c of corners) {
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
        if (typeof activateBlock === 'function') await activateBlock(block);
        else if (bot?.activateBlock) await bot.activateBlock(block);
        else {
            steps.push(`no activateBlock for ${c.x} ${y - 1} ${c.z}`);
            continue;
        }
        steps.push(`clicked ${c.x} ${y - 1} ${c.z}`);
        await wait(400);
    }
    let listText = '';
    if (typeof chat === 'function') {
        const lines = [];
        const onMsg = (m) => { lines.push(String(m || '')); };
        bot?.on?.('messagestr', onMsg);
        chat(CLAIM_PLUGIN.listCommand);
        await wait(800);
        bot?.removeListener?.('messagestr', onMsg);
        listText = lines.join('\n');
    }
    const parsed = parseClaimsList(listText, { username });
    return {
        ok: parsed.coversClaim,
        plugin: CLAIM_PLUGIN.name,
        steps,
        corners,
        claimsList: parsed,
        fallback: parsed.coversClaim ? null : CLAIM_PLUGIN.adminFallback,
        approval: 'Requires Randy approval before use on the live server.',
    };
}

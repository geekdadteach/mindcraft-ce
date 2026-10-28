// Optional operator-triggered GriefPrevention helper. Never runs on its own.
// Corners are the 128×128 claim; GP claims are full height and do not confine the owner.
import { CLAIM, claimBounds } from './bob_claim.js';

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

export function parseClaimsList(text, { username = 'MineBobNE' } = {}) {
    const raw = String(text || '');
    const lines = raw.split(/\r?\n/);
    const mentions = lines.filter((l) => new RegExp(username, 'i').test(l) || /claim/i.test(l));
    const b = claimBounds();
    const hasSW = raw.includes(String(b.x1)) && raw.includes(String(b.z1));
    const hasNE = raw.includes(String(b.x2)) && raw.includes(String(b.z2));
    const covers = hasSW && hasNE;
    return {
        raw,
        mentionsUser: new RegExp(username, 'i').test(raw),
        coversClaim: covers,
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
        const bn = String(below?.name || '');
        if ((fn === 'air' || fn === 'cave_air' || /pressure_plate|grass|snow/.test(fn)) && below && below.boundingBox === 'block')
            return y - (fn === 'air' || fn === 'cave_air' ? 0 : 0);
        if ((fn === 'air' || fn === 'cave_air') && bn && bn !== 'air' && bn !== 'cave_air') return y;
    }
    return 65;
}

export async function claimProperty(agent, {
    getBlock,
    activateBlock,
    equip,
    chat,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    username = agent?.name || 'MineBobNE',
} = {}) {
    const bot = agent?.bot;
    const corners = claimCorners();
    const blockAt = getBlock || ((x, y, z) => bot?.blockAt?.({ x, y, z }));
    const steps = [];
    if (typeof equip === 'function') {
        await equip('golden_shovel');
        steps.push('equipped golden_shovel');
    }
    for (const c of corners) {
        const y = findSurfaceY(blockAt, c.x, c.z);
        const block = blockAt(c.x, y - 1, c.z) || { x: c.x, y: y - 1, z: c.z, name: 'grass_block' };
        if (typeof activateBlock === 'function') await activateBlock(block);
        else if (bot?.activateBlock) await bot.activateBlock(block);
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

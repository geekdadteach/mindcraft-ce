// [bob-eval] State-based objective checks. They read only the fake world/bot state, never task results.
export function runCheck(check, { bot, world }) {
    const p = bot.entity.position;
    switch (check.kind) {
        case 'inventory': {
            const actual = bot.inventory.count(check.item);
            return { ...check, desc: `inventory ${check.item} >= ${check.min}`, actual, passed: actual >= check.min };
        }
        case 'distance': {
            const t = check.target;
            const actual = Math.round(Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) * 100) / 100;
            return { ...check, desc: `distance to ${t.x},${t.y},${t.z} <= ${check.max}`, actual, passed: actual <= check.max };
        }
        case 'block': {
            const actual = world.getBlockName(check.pos.x, check.pos.y, check.pos.z);
            return { ...check, desc: `block at ${check.pos.x},${check.pos.y},${check.pos.z} is ${check.name}`, actual, passed: actual === check.name };
        }
        case 'shelter': {
            const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
            const cells = [];
            for (const dy of [0, 1]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) cells.push([x + dx, y + dy, z + dz, 'side']);
            cells.push([x, y + 2, z, 'roof']);
            const open = cells.filter(([a, b, c]) => !world.isSolid(a, b, c)).map(([a, b, c, k]) => `${k}@${a},${b},${c}`);
            return { ...check, desc: 'solid blocks on 4 sides (feet+head) and over the head', actual: open.length ? `open: ${open.join(' ')}` : 'enclosed', passed: open.length === 0 };
        }
        default:
            return { ...check, desc: `unknown check ${check.kind}`, actual: null, passed: false };
    }
}

export function verifyObjective(checks, ctx) {
    const results = checks.map(c => runCheck(c, ctx));
    return { passed: results.length > 0 && results.every(r => r.passed), results };
}

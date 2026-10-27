// [ai-player] Unreachable-target memory and nav fail-fast helpers.
// Block positions and coordinate cells that returned NoPath are skipped for a TTL
// so collectBlock / goToNearestBlock / goToCoordinates stop hammering the same spot.

export const UNREACHABLE_TTL_MS = 15 * 60_000;
export const COORD_CELL_SIZE = 4;
export const SIGNATURE_CELL_SIZE = 16;

const memories = new WeakMap();

export function navTimestamp(now = Date.now()) {
    return new Date(now).toISOString();
}

export function navConsole(message, now = Date.now()) {
    console.log(`[ai-player] ${navTimestamp(now)} nav: ${message}`);
}

export function blockKey(pos) {
    if (!pos) return null;
    const x = Math.floor(Number(pos.x));
    const y = Math.floor(Number(pos.y));
    const z = Math.floor(Number(pos.z));
    if (![x, y, z].every(Number.isFinite)) return null;
    return `${x},${y},${z}`;
}

export function coordCellKey(x, y, z, size = COORD_CELL_SIZE) {
    const c = (n) => Math.round(Number(n) / size);
    if (![x, y, z].every((n) => Number.isFinite(Number(n)))) return null;
    return `${c(x)},${c(y)},${c(z)}`;
}

export function coordCellLabel(x, y, z, size = SIGNATURE_CELL_SIZE) {
    const key = coordCellKey(x, y, z, size);
    return key ? `cell:${key}` : '';
}

export function goalPosition(goal) {
    if (!goal || typeof goal !== 'object') return null;
    if (goal.entity?.position) {
        const p = goal.entity.position;
        return { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
    }
    const x = goal.x ?? goal.pos?.x;
    const y = goal.y ?? goal.pos?.y;
    const z = goal.z ?? goal.pos?.z;
    if (![x, y, z].every((n) => Number.isFinite(Number(n)))) return null;
    return { x: Number(x), y: Number(y), z: Number(z) };
}

export function isNoPathError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || error || '');
    return name === 'NoPath'
        || error?.unreachable === true
        || /no[\s_-]*path|unreachable/i.test(message);
}

export function createUnreachableError(detail) {
    return Object.assign(new Error(`unreachable: ${detail}`), {
        name: 'NoPath',
        unreachable: true
    });
}

export function probeSummary(probe) {
    if (!probe) return 'none';
    const visited = Number.isFinite(probe.visitedNodes) ? probe.visitedNodes : '-';
    return `status=${probe.status || 'unknown'} visitedNodes=${visited}`;
}

export function formatProbeTelemetry(nonDestructive, destructive) {
    return `nonDestructive=${probeSummary(nonDestructive)}; destructive=${probeSummary(destructive)}`;
}

// Both probes already proved there is no path: do not goto or retry.
export function shouldFailFast(nonDestructive, destructive) {
    return nonDestructive?.status === 'noPath'
        && destructive?.status === 'noPath';
}

export function decidePathStrategy(nonDestructive, destructive) {
    if (nonDestructive?.status === 'success') {
        return { action: 'goto', movements: 'nonDestructive', retry: true };
    }
    if (destructive?.status === 'success') {
        return { action: 'goto', movements: 'destructive', retry: true };
    }
    if (shouldFailFast(nonDestructive, destructive)) {
        return { action: 'fail', reason: 'unreachable' };
    }
    return { action: 'goto', movements: 'destructive', retry: false };
}

export class UnreachableMemory {
    constructor({
        now = Date.now,
        ttlMs = UNREACHABLE_TTL_MS
    } = {}) {
        this.now = now;
        this.ttlMs = ttlMs;
        this.blocks = new Map();
        this.cells = new Map();
    }

    _alive(map, key) {
        if (!key) return false;
        const until = map.get(key);
        if (until == null) return false;
        const now = this.now();
        if (now >= until || now < until - this.ttlMs) {
            map.delete(key);
            return false;
        }
        return true;
    }

    _expire(map) {
        const now = this.now();
        for (const [key, until] of map) {
            if (now >= until || now < until - this.ttlMs)
                map.delete(key);
        }
        while (map.size > 256)
            map.delete(map.keys().next().value);
    }

    rememberBlock(pos) {
        const key = blockKey(pos);
        if (!key) return null;
        this.blocks.set(key, this.now() + this.ttlMs);
        this._expire(this.blocks);
        return key;
    }

    rememberCell(x, y, z) {
        const key = coordCellKey(x, y, z);
        if (!key) return null;
        this.cells.set(key, this.now() + this.ttlMs);
        this._expire(this.cells);
        return key;
    }

    rememberGoal(goal) {
        const pos = goalPosition(goal) || goal;
        if (!pos) return null;
        return {
            block: this.rememberBlock(pos),
            cell: this.rememberCell(pos.x, pos.y, pos.z)
        };
    }

    isUnreachableBlock(pos) {
        return this._alive(this.blocks, blockKey(pos));
    }

    isUnreachableCell(x, y, z) {
        return this._alive(this.cells, coordCellKey(x, y, z));
    }

    isUnreachableGoal(x, y, z) {
        return this.isUnreachableBlock({ x, y, z })
            || this.isUnreachableCell(x, y, z);
    }

    // nav-on-live-20261026: a reset / stuck-home teleport moves Bob, so old NoPath verdicts are stale.
    clear() {
        const n = this.blocks.size + this.cells.size;
        this.blocks.clear();
        this.cells.clear();
        return n;
    }

    forgetExpired() {
        this._expire(this.blocks);
        this._expire(this.cells);
    }
}

export function navMemory(bot, opts) {
    if (!bot) throw new TypeError('bot is required');
    let memory = memories.get(bot);
    if (!memory) {
        memory = new UnreachableMemory(opts);
        memories.set(bot, memory);
    }
    return memory;
}

export function chooseCollectTarget(blocks, memory) {
    return (blocks || []).find((block) =>
        block?.position && !memory.isUnreachableBlock(block.position)
    ) || null;
}

// collectBlock uses this so a NoPath on the nearest block moves on to the next.
export async function tryCollectCandidates(blocks, attempt, memory) {
    const skipped = [];
    for (const block of blocks || []) {
        if (!block?.position || memory.isUnreachableBlock(block.position)) {
            if (block) skipped.push(block);
            continue;
        }
        try {
            await attempt(block);
            return { ok: true, block, skipped };
        } catch (error) {
            if (isNoPathError(error)) {
                memory.rememberBlock(block.position);
                skipped.push(block);
                continue;
            }
            return { ok: false, block, error, skipped };
        }
    }
    return { ok: false, skipped, exhausted: true };
}

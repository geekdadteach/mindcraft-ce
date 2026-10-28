import test from 'node:test';
import assert from 'node:assert/strict';
import { scanEscapeCells, escapeUp } from '../src/agent/library/escape.js';
import { LEGACY_HILLTOP } from '../src/agent/library/bob_home.js';

function pocketBot({ x = -840, y = 96, z = 560 } = {}) {
    const v = (px, py, pz) => ({
        x: px, y: py, z: pz,
        offset(dx, dy, dz) { return v(this.x + dx, this.y + dy, this.z + dz); },
        plus(d) { return v(this.x + d.x, this.y + d.y, this.z + d.z); },
        floored() { return v(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); },
        clone() { return v(this.x, this.y, this.z); },
        distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); },
        toString() { return `(${this.x}, ${this.y}, ${this.z})`; },
    });
    // 3x3 stone pocket with one open cell to the west that has more air.
    const pos = v(x + 0.5, y, z + 0.5);
    return {
        entity: { position: pos, onGround: true },
        interrupt_code: false,
        health: 20,
        registry: { blocksArray: [] },
        pathfinder: { setMovements() {}, goto: async () => {}, stop() {}, isMining() { return false; }, isBuilding() { return false; } },
        blockAt(q) {
            const bx = Math.floor(q.x), by = Math.floor(q.y), bz = Math.floor(q.z);
            const inPocket = bx >= x - 1 && bx <= x + 1 && bz >= z - 1 && bz <= z + 1 && by >= y && by <= y + 2;
            const openWest = bx === x - 3 && bz === z && by >= y && by <= y + 6;
            if (openWest) return { name: 'air', boundingBox: 'empty', skyLight: 8, position: q };
            if (bx === x - 3 && bz === z && by === y - 1) return { name: 'stone', boundingBox: 'block', skyLight: 0, position: q };
            if (inPocket && by === y - 1) return { name: 'stone', boundingBox: 'block', skyLight: 0, position: q };
            if (inPocket && (by === y || by === y + 1) && bx === Math.floor(pos.x) && bz === Math.floor(pos.z))
                return { name: 'air', boundingBox: 'empty', skyLight: 0, position: q };
            if (inPocket) return { name: 'stone', boundingBox: 'block', skyLight: 0, position: q };
            return { name: 'stone', boundingBox: 'block', skyLight: 0, position: q };
        },
    };
}

test('scanEscapeCells prefers a nearby air column over the closed pocket', () => {
    const bot = pocketBot();
    const cells = scanEscapeCells(bot, { radius: 4 });
    assert.ok(cells.length >= 1);
    assert.ok(cells[0].sky >= 8 || cells[0].air >= 2);
    assert.ok(cells[0].x <= Math.floor(bot.entity.position.x) - 2);
});

test('escapeUp relocates instead of walking to the retired hilltop', async () => {
    const bot = pocketBot();
    const goals = [];
    const agent = {
        bot,
        failures: { isBlocked() { return false; }, record() {} },
        escape: {},
    };
    bot.pathfinder.goto = async (goal) => { goals.push(goal); throw new Error('nopath'); };
    const r = await escapeUp(agent, { reason: 'stuck', maxMs: 50 });
    assert.equal(r.ok, false);
    const house = LEGACY_HILLTOP.entrance;
    assert.ok(goals.every((g) => {
        const horiz = Math.hypot((g.x ?? 0) - house.x, (g.z ?? 0) - house.z);
        return !(horiz < 8 && Math.abs((g.y ?? 0) - house.y) < 10);
    }), 'escape must relocate nearby, not walk to the retired hilltop');
});

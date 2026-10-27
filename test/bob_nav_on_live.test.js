// nav-on-live-20261026: PR #14 navigation handling merged with the live .20 patches
// (stuck-home teleport fallback with nodistance, reset-recovery).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResetRecovery } from '../src/agent/library/reset_recovery.js';
import { navMemory, UnreachableMemory } from '../src/agent/library/bob_nav_memory.js';
import { DOOR, decide, DEFAULTS, loadConfig } from '../src/agent/library/stuck_home.js';
import { isInsideHouseArea, isWalkingLane, protectedAreaAt } from '../src/agent/library/house_bounds.js';

test('reset / stuck-home teleport clears the unreachable nav blacklist', async () => {
    const bot = { entity: { position: { x: -819.5, y: 124, z: 565.5 } } };
    const mem = navMemory(bot);
    mem.rememberGoal({ x: -870, y: 60, z: 540 });
    mem.rememberBlock({ x: -900, y: 64, z: 500 });
    assert.equal(mem.isUnreachableGoal(-870, 60, 540), true);
    const turns = [];
    const agent = {
        bot,
        actions: { cancelResume() {}, async stop() {} },
        history: { async add(r, c) { turns.push([r, c]); }, async save() {} }
    };
    const rr = new ResetRecovery(agent, { inboxDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nol-')) });
    await rr.recordReset({ reason: 'stuck-home', pos: { x: -870, y: 60, z: 540 }, action: 'action:collectBlocks', note: 'n' });
    assert.equal(mem.isUnreachableGoal(-870, 60, 540), false);
    assert.equal(mem.isUnreachableBlock({ x: -900, y: 64, z: 500 }), false);
    assert.equal(turns.length, 1);
});

test('recordReset without a bot still works (no nav memory)', async () => {
    const agent = { actions: { cancelResume() {}, async stop() {} }, history: { async add() {}, async save() {} } };
    const rr = new ResetRecovery(agent, { inboxDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nol-')) });
    await rr.recordReset({ reason: 'manual', pos: null, action: null });
});

test('UnreachableMemory.clear returns how many entries were dropped', () => {
    const m = new UnreachableMemory();
    m.rememberGoal({ x: 1, y: 2, z: 3 });
    assert.equal(m.clear(), 2);
    assert.equal(m.clear(), 0);
});

test('stuck-home landing spot (door plate) is on the porch, not "inside the house" for enclosure', () => {
    assert.equal(isInsideHouseArea(DOOR), false);
    assert.equal(isWalkingLane(DOOR), true);
    // the plate Bob lands on and its support are never diggable
    assert.ok(protectedAreaAt({ x: -820, y: 124, z: 565 }, 'oak_pressure_plate'));
    assert.ok(protectedAreaAt({ x: -820, y: 123, z: 565 }, 'grass_block'));
});

test('stuck-home nodistance config still loads as unlimited radius', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nol-'));
    const f = path.join(dir, 'stuck-home.config.json');
    fs.writeFileSync(f, JSON.stringify({ radius: null }));
    const cfg = loadConfig({}, f);
    assert.ok(!cfg.radius);
    assert.equal(typeof decide, 'function');
    assert.ok(DEFAULTS.failLimit > 0);
});

// pr20-reconciled-20261027: regression tests for the no-house-fallback navigation changes (items A-D).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { surfaceFallbackGoal, surfaceFailNote, surfaceForWood } from '../src/agent/library/ai_player_nav.js';
import { TELEPORT_NOTE, MANUAL_NOTE } from '../src/agent/library/reset_recovery.js';
import { STUCK_HOME_NOTE } from '../src/agent/library/stuck_home.js';
import { afterEscapeTarget, HOMESTEAD, NO_GO_ZONES, NO_GO_RADIUS, zoneForGoal } from '../src/agent/library/no_go_zones.js';

const src = (f) => fs.readFileSync(new URL(`../src/agent/${f}`, import.meta.url), 'utf8');

// A minimal underground bot: stone above the head, no sky light.
function caveBot() {
    const pos = { x: -900.5, y: 40, z: 600.5 };
    const v = (x, y, z) => ({ x, y, z, offset(dx, dy, dz) { return v(this.x + dx, this.y + dy, this.z + dz); }, floored() { return v(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }, toString() { return `(${this.x}, ${this.y}, ${this.z})`; } });
    const p = v(pos.x, pos.y, pos.z);
    return {
        entity: { position: p },
        blockAt: (q) => ({ name: q.y >= 42 && q.y < 70 ? 'stone' : 'air', skyLight: 0, position: q }),
        chat() {}, interrupt_code: false,
    };
}

test('A: surface-for-wood never targets the house when the climb fails', async () => {
    const goals = [], failures = [];
    const bot = caveBot();
    const agent = {
        bot,
        escape: {
            up: async () => ({ ok: false, why: 'stalled' }),
            gotoChecked: async (_a, goal, opts) => { goals.push({ goal, label: opts?.label }); return false; },
        },
        failures: { record: (...a) => failures.push(a) },
    };
    const ok = await surfaceForWood(agent, 'oak_log');
    assert.equal(ok, false, 'objective abandoned');
    assert.equal(goals.length, 1, 'exactly one bounded fallback attempt');
    assert.ok(!/home|house|entrance/i.test(goals[0].label), `fallback label ${goals[0].label}`);
    const g = goals[0].goal;
    assert.ok(Math.hypot(g.x - -819.5, g.z - 565.5) > 50, 'fallback goal is not the house entrance');
    assert.equal(failures.length, 1, 'navigation failure recorded');
    // second call inside the cooldown: no new route attempt (does not retry the same unreachable route)
    const again = await surfaceForWood(agent, 'oak_log');
    assert.equal(again, true);
    assert.equal(goals.length, 1);
});

test('A: helpers and source contain no house fallback', () => {
    assert.equal(surfaceFallbackGoal(null), null);
    const g = surfaceFallbackGoal({ x: 1, y: 80, z: 2 });
    assert.deepEqual([g.x, g.y, g.z], [1, 80, 2]);
    const note = surfaceFailNote({ x: 1, y: 2, z: 3 }, 'oak_log');
    assert.match(note, /Navigation failed/);
    assert.match(note, /abandoned/);
    assert.match(note, /Do not retry the same route/);
    assert.match(note, /different objective/);
    const nav = src('library/ai_player_nav.js');
    const body = nav.slice(nav.indexOf('export async function surfaceForWood'), nav.indexOf('// ---- Fix 2'));
    assert.ok(!/HOUSE_ENTRANCE|homeDistance|house entrance/.test(body), 'surfaceForWood must not route to the house');
});

test('B: recovery notes have no distance limit and keep Bob independent', () => {
    for (const n of [TELEPORT_NOTE, MANUAL_NOTE, STUCK_HOME_NOTE]) {
        assert.ok(!/60 blocks|within ~/.test(n), n);
        assert.match(n, /avoid the route/);
        assert.match(n, /reachable destination/);
        assert.match(n, /continue your own activity wherever it is safe and permitted/);
    }
});

test('C: zone escape never falls back to a house, including the retired hilltop', () => {
    const z = NO_GO_ZONES.find(n => /racetrack/.test(n.name));
    assert.equal(afterEscapeTarget(z.x + NO_GO_RADIUS + 20, z.z), null, 'safely out: no home walk');
    assert.equal(afterEscapeTarget(-700, 520), null, 'clear of every zone');
    assert.equal(afterEscapeTarget(z.x + 10, z.z), null, 'still inside: no homestead fallback');
    assert.equal(afterEscapeTarget(z.x + NO_GO_RADIUS + 2, z.z), null, 'inside the margin: no homestead fallback');
    assert.equal(HOMESTEAD, null);
    assert.ok(zoneForGoal({ x: z.x, y: 70, z: z.z }, { x: -823, z: 568 }));
    const ng = src('library/no_go_zones.js');
    assert.ok(!/walked straight home/.test(ng));
    assert.match(ng, /afterEscapeTarget\(q\.x, q\.z\)/);
});

test('D: navigation priority keeps danger first and automatic home paths opt-in', () => {
    const m = src('modes.js');
    assert.match(m, /navigation priority/);
    for (const name of ['self_preservation', 'self_defense', 'cowardice', 'hunger', 'unstuck', 'night'])
        assert.match(m, new RegExp(`name: '${name}'`));
    assert.match(m, /UNSTUCK_WALK_HOME && !where/);
    assert.match(m, /home_at_night: nightHomeEnabled\(\)/);
    assert.match(m, /do not retry the same route/);
    assert.match(m, /failures\?\.record\(cmd \|\| 'action', 'stuck'/);
    const sh = src('library/stuck_home.js');
    assert.match(sh, /auto: false/);
});

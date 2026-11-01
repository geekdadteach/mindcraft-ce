// [ai-player] Fix 5 - full pathfinder probe, probe-aware unstuck, protected-area cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { probePathStatus, fullProbeEnabled, isPathProbing } from '../src/agent/library/skills.js';
import { decidePathStrategy } from '../src/agent/library/bob_nav_memory.js';
import { protectedAreaAt } from '../src/agent/library/house_bounds.js';

test('the full probe keeps going while the search is partial, so a later success is seen', async () => {
    const seq = ['partial', 'partial', 'success'];
    let i = 0, t = 0;
    const path = await probePathStatus(() => ({ status: seq[Math.min(i++, seq.length - 1)] }), { totalMs: 1500, now: () => (t += 100) });
    assert.equal(path.status, 'success', 'the probe ran to a finished search');
    assert.deepEqual(decidePathStrategy({ status: path.status }, null), { action: 'goto', movements: 'nonDestructive', retry: true });
});

test('BOB_NAV_FULL_PROBE=0 restores the single-shot probe', async () => {
    assert.equal(fullProbeEnabled({}), true);
    assert.equal(fullProbeEnabled({ BOB_NAV_FULL_PROBE: '0' }), false);
    let calls = 0;
    const path = await probePathStatus(() => { calls++; return { status: 'partial' }; }, { totalMs: 5000, now: () => 0, full: false });
    assert.equal(path.status, 'partial');
    assert.equal(calls, 1, 'one shot only when the full probe is off');
});

test('the probe stops when the budget runs out', async () => {
    let calls = 0;
    const path = await probePathStatus(() => { calls++; return { status: 'partial' }; }, { totalMs: 300, now: () => (calls * 100) });
    assert.equal(path.status, 'partial');
    assert.ok(calls > 1, 'it kept asking');
    assert.ok(calls <= 5, 'but not forever');
});

test('isPathProbing is false when no probe is running', () => {
    assert.equal(isPathProbing(), false);
});

test('the unstuck mode and the protected-area cache are wired', () => {
    const modes = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    assert.match(modes, /skills\.isPathProbing\(\)/, 'unstuck checks the probe');
    const pa = fs.readFileSync(new URL('../src/agent/library/protected_area.js', import.meta.url), 'utf8');
    assert.match(pa, /clearProtectedCache/, 'the cache can be cleared');
    assert.match(pa, /PROTECTED_CACHE/, 'the hook caches protectedAreaAt');
    const skills = fs.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    assert.match(skills, /clearProtectedCache\(\)/, 'each probe clears the cache');
});

test('safeToBreak hook overhead (synthetic micro-benchmark)', { skip: !process.env.BOB_NAV_BENCH }, () => {
    const NODES = Number(process.env.BOB_NAV_BENCH_NODES || 200000);
    const cache = new Map();
    const pos = (i) => ({ x: (i % 1000) - 500, y: 64, z: ((i / 1000) | 0) - 500 });
    const t = (label, fn) => {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < NODES; i++) fn(i);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        console.log(`[bench] ${label}: ${NODES} nodes / ${ms.toFixed(1)} ms = ${Math.round(NODES / (ms / 1000))} nodes/sec`);
        return ms;
    };
    const plain = t('no hook', () => {});
    const uncached = t('protectedAreaAt (uncached)', (i) => !!protectedAreaAt(pos(i)));
    const cached = t('protectedAreaAt (cached)', (i) => {
        const p = pos(i), key = p.x + ',' + p.y + ',' + p.z;
        let hit = cache.get(key);
        if (hit === undefined) { hit = !!protectedAreaAt(p); cache.set(key, hit); }
        return hit;
    });
    console.log(`[bench] uncached ${(uncached / plain).toFixed(1)}x plain; cached ${(cached / plain).toFixed(1)}x plain`);
    assert.ok(plain > 0);
});


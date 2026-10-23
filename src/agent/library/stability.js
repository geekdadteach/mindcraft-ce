// [ai-player] Stability helpers (Oct 20, after the 19:43 heap OOM and the 92-98 s event-loop hangs).
// 1) Physics guard: prismarine-physics' getSurroundingBBs() walks every block inside the box swept by one
//    tick of movement and pushes an AABB per block shape into an array. A non-finite or huge velocity
//    (bad knockback / explosion / velocity packet) makes that a near-endless synchronous loop that also
//    grows an array without bound: the event loop hangs (watchdog kill) and the heap fills (OOM abort).
//    Every hang and the OOM on Oct 20 followed combat or damage. The guard clamps velocity to what vanilla
//    can produce and refuses non-finite positions before each physics tick, and logs when it fires.
// 2) Telemetry for the minute status line: heap, rss, event-loop delay, listener and timer counts.
// 3) Heap guard: above 85% of the V8 heap limit, log diagnostics and exit(1) so the reconnect loop starts
//    a clean process (history saved) instead of an OOM abort.
import v8 from 'v8';
import { monitorEventLoopDelay } from 'perf_hooks';

const MAX_V = 6;      // blocks/tick; vanilla terminal fall speed is ~3.9, creeper knockback is < 3
export const guardStats = { velocityClamped: 0, badPos: 0, lastLog: 0 };

function fixVel(vel) {
    let changed = false;
    for (const k of ['x', 'y', 'z']) {
        const v = vel[k];
        if (!Number.isFinite(v)) { vel[k] = 0; changed = true; }
        else if (Math.abs(v) > MAX_V) { vel[k] = Math.sign(v) * MAX_V; changed = true; }
    }
    return changed;
}
const finitePos = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

export function installPhysicsGuard(bot) {
    const tryInstall = () => {
        const phys = bot.physics;
        if (!phys || phys._aiGuard) return !!phys;
        const orig = phys.simulatePlayer.bind(phys);
        let lastGood = null;
        phys.simulatePlayer = (state, world) => {
            const before = state.vel ? { x: state.vel.x, y: state.vel.y, z: state.vel.z } : null;
            if (state.vel && fixVel(state.vel)) {
                guardStats.velocityClamped++;
                try { fixVel(bot.entity.velocity); } catch (_) {}
                if (Date.now() - guardStats.lastLog > 5000) {
                    guardStats.lastLog = Date.now();
                    console.warn(`[ai-player] physics-guard: clamped velocity ${JSON.stringify(before)} (count=${guardStats.velocityClamped})`);
                }
            }
            if (!finitePos(state.pos)) {
                guardStats.badPos++;
                console.warn(`[ai-player] physics-guard: non-finite position ${state.pos}; skipping physics tick (count=${guardStats.badPos})`);
                if (lastGood && bot.entity?.position) { try { bot.entity.position.set(lastGood.x, lastGood.y, lastGood.z); } catch (_) {} }
                return { apply: () => {} };
            }
            const out = orig(state, world);
            if (finitePos(out?.pos)) lastGood = out.pos.clone ? out.pos.clone() : { ...out.pos };
            return out;
        };
        phys._aiGuard = true;
        console.log('[ai-player] physics-guard installed');
        return true;
    };
    // source logging: which packet carried the extreme motion (velocity packets are in 1/8000 block/tick)
    try {
        bot._client.on('entity_velocity', (p) => {
            if (!bot.entity || p.entityId !== bot.entity.id) return;
            const v = [p.velocityX, p.velocityY, p.velocityZ].map(n => Number(n) / 8000);
            if (v.some(n => !Number.isFinite(n) || Math.abs(n) > MAX_V)) console.warn(`[ai-player] physics-guard: extreme self entity_velocity packet ${JSON.stringify(p)}`);
        });
        bot._client.on('explosion', (p) => {
            const k = p.playerKnockback || { x: p.playerMotionX, y: p.playerMotionY, z: p.playerMotionZ };
            if ([k.x, k.y, k.z].some(n => n != null && (!Number.isFinite(n) || Math.abs(n) > MAX_V))) console.warn(`[ai-player] physics-guard: extreme explosion knockback ${JSON.stringify(k)}`);
        });
    } catch (_) {}
    if (!tryInstall()) {
        bot.once('login', tryInstall);
        bot.once('spawn', tryInstall);
    }
}

const eld = monitorEventLoopDelay({ resolution: 20 });
eld.enable();

export function listenerTop(emitter, n = 3) {
    try {
        const counts = emitter.eventNames().map(e => [String(e), emitter.listenerCount(e)]);
        const total = counts.reduce((s, [, c]) => s + c, 0);
        counts.sort((a, b) => b[1] - a[1]);
        return { total, top: counts.slice(0, n).map(([e, c]) => `${e}:${c}`).join(',') };
    } catch (_) { return { total: -1, top: '' }; }
}

export function memStatus(agent) {
    const m = process.memoryUsage();
    const MB = (b) => Math.round(b / 1048576);
    const l = listenerTop(agent.bot);
    let timers = -1;
    try { timers = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length; } catch (_) {}
    const s = `heap=${MB(m.heapUsed)}/${MB(v8.getHeapStatistics().heap_size_limit)}MB rss=${MB(m.rss)}MB eld_p99=${Math.round(eld.percentile(99) / 1e6)}ms ` +
        `eld_max=${Math.round(eld.max / 1e6)}ms listeners=${l.total}(${l.top}) timers=${timers} abandoned=${agent.actions?.abandoned || 0} vclamp=${guardStats.velocityClamped}`;
    eld.reset();
    return s;
}

let heapWarned = false;
export function heapGuard(agent) {
    const used = process.memoryUsage().heapUsed, limit = v8.getHeapStatistics().heap_size_limit;
    if (used < limit * 0.85) { heapWarned = false; return; }
    console.error(`[ai-player] heap-guard: heap ${Math.round(used / 1048576)} MB is over 85% of ${Math.round(limit / 1048576)} MB; ${memStatus(agent)}; exiting so the reconnect loop starts a clean process`);
    if (heapWarned) return;
    heapWarned = true;
    try { agent.history.save(); } catch (_) {}
    setTimeout(() => process.exit(1), 500);
}

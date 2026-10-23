// [ai-player] No-go zones enforced in code (not just the prompt).
// Any pathfinder target (goto / setGoal: goToCoordinates, goToPlayer, followPlayer, collectBlock, generated code, ...)
// whose x/z lies within NO_GO_RADIUS of a zone centre is refused and logged. Moving away (GoalInvert) is allowed.
// If Bob is inside a zone (join, respawn, or drifted in), he is walked straight home to the homestead.
import pf from 'mineflayer-pathfinder';
import { log, goToPosition, goToGoal } from './skills.js';

export const NO_GO_RADIUS = 64;
export const NO_GO_ZONES = [
    { name: 'the market', x: -572, y: 69, z: 480 },
    { name: 'world spawn and its builds', x: -543, y: 75, z: 448 },
    { name: 'the racetrack', x: -264, y: 66, z: 513 },
];
export const HOMESTEAD = { x: -823, y: 124, z: 568 };

const ESCAPE_RETRY_MS = 45000;
const TICK_MS = 3000;
const LEG_BLOCKS = 24;        // escape walks west in short legs so path search stays fast and unstuck does not fire
const MAX_LEGS = 14;
const EXIT_MARGIN = 8;        // keep walking until this far outside every zone

export function zoneAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    let best = null;
    for (const zone of NO_GO_ZONES) {
        const dist = Math.hypot(x - zone.x, z - zone.z);
        if (dist < NO_GO_RADIUS && (!best || dist < best.dist)) best = { zone, dist };
    }
    return best;
}

// x/z points a goal leads to. [] = no fixed target (e.g. GoalY) or moving away (GoalInvert): allowed.
export function goalTargets(goal, depth = 0) {
    if (!goal || depth > 4) return [];
    const kind = goal.constructor?.name || '';
    if (kind === 'GoalInvert') return [];
    if (Array.isArray(goal.goals)) return goal.goals.flatMap(g => goalTargets(g, depth + 1));
    if (goal.entity?.position) return [{ x: goal.entity.position.x, z: goal.entity.position.z }];
    if (goal.pos && Number.isFinite(goal.pos.x) && Number.isFinite(goal.pos.z)) return [{ x: goal.pos.x, z: goal.pos.z }];
    if (goal.goal) return goalTargets(goal.goal, depth + 1);
    if (Number.isFinite(goal.x) && Number.isFinite(goal.z)) return [{ x: goal.x, z: goal.z }];
    return [];
}

const LOCAL_MOVE_BLOCKS = 16;  // when already inside a zone: short local moves (fight back, dodge, unstuck) are allowed

// botPos given: if Bob is already inside a zone, a target is still allowed when it is a short local move or it
// leads further out of that zone than he is now. Only moves that go deeper / to another zone are refused.
export function zoneForGoal(goal, botPos = null) {
    const here = botPos ? zoneAt(botPos.x, botPos.z) : null;
    for (const t of goalTargets(goal)) {
        const hit = zoneAt(t.x, t.z);
        if (!hit) continue;
        if (here && botPos) {
            const local = Math.hypot(t.x - botPos.x, t.z - botPos.z) <= LOCAL_MOVE_BLOCKS;
            const outward = hit.zone === here.zone && hit.dist >= here.dist;
            if (local || outward) continue;
        }
        return { ...hit, target: t };
    }
    return null;
}

// Escape heading: away from every nearby zone centre, blended with "toward the homestead" (west for spawn/market).
export function escapeHeading(x, z) {
    let vx = 0, vz = 0;
    for (const zone of NO_GO_ZONES) {
        const dx = x - zone.x, dz = z - zone.z;
        const d = Math.hypot(dx, dz);
        if (d < NO_GO_RADIUS + 16) { const w = d < 1 ? 1 : 1 / d; vx += (d < 1 ? -1 : dx) * w; vz += dz * w; }
    }
    const hx = HOMESTEAD.x - x, hz = HOMESTEAD.z - z, hd = Math.hypot(hx, hz) || 1;
    vx += 0.5 * hx / hd; vz += 0.5 * hz / hd;
    const n = Math.hypot(vx, vz) || 1;
    return [vx / n, vz / n];
}

export function installNoGoZoneGuard(agent) {
    const bot = agent.bot;
    if (!bot?.pathfinder || bot._aiPlayerNoGoGuard) return;
    bot._aiPlayerNoGoGuard = true;

    for (const zone of NO_GO_ZONES) {
        const d = Math.hypot(HOMESTEAD.x - zone.x, HOMESTEAD.z - zone.z);
        console.log(`[ai-player] zone-guard: ${zone.name} (${zone.x} ${zone.y} ${zone.z}) radius ${NO_GO_RADIUS}; homestead is ${Math.round(d)} blocks away`);
    }

    const pfx = bot.pathfinder;
    const origGoto = pfx.goto;
    const origSetGoal = pfx.setGoal;
    let activeGoal = null;
    let escapeGoal = null;    // the escape's own leg goal is allowed even inside a zone
    let escaping = false;
    let lastEscapeAt = 0;
    let lastRefusalLog = { key: '', at: 0 };

    const refuse = (hit, via) => {
        const tx = Math.round(hit.target.x), tz = Math.round(hit.target.z);
        const msg = `No-go zone: refused to move to (${tx}, ${tz}); it is ${Math.round(hit.dist)} blocks from ${hit.zone.name} (${hit.zone.x} ${hit.zone.y} ${hit.zone.z}). Stay at least ${NO_GO_RADIUS} blocks away; pick a place near the homestead (${HOMESTEAD.x} ${HOMESTEAD.y} ${HOMESTEAD.z}) instead.`;
        const key = `${via}:${tx}:${tz}`;
        const now = Date.now();
        if (key !== lastRefusalLog.key || now - lastRefusalLog.at > 10000) {
            const p = bot.entity?.position;
            console.log(`[ai-player] zone-refusal via=${via} target=(${tx}, ${tz}) zone="${hit.zone.name}" dist=${Math.round(hit.dist)} bot_at=${p ? `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})` : '?'}`);
            lastRefusalLog = { key, at: now };
        }
        try { log(bot, msg); } catch (_) {}
        return msg;
    };

    pfx.goto = (goal, ...rest) => {
        const hit = goal === escapeGoal ? null : zoneForGoal(goal, bot.entity?.position);
        if (hit) {
            const err = new Error(refuse(hit, 'goto'));
            err.name = 'NoGoZone';
            return Promise.reject(err);
        }
        return origGoto(goal, ...rest);
    };

    pfx.setGoal = (goal, dynamic = false) => {
        if (goal && goal !== escapeGoal) {
            const hit = zoneForGoal(goal, bot.entity?.position);
            if (hit) {
                refuse(hit, 'setGoal');
                return; // ignore the new goal; leave whatever path is running untouched
            }
        }
        activeGoal = goal || null;
        return origSetGoal(goal, dynamic);
    };

    bot.on('goal_reached', () => { activeGoal = null; });
    bot.on('path_stop', () => { activeGoal = null; });

    const startEscape = (hit, reason) => {
        escaping = true;
        lastEscapeAt = Date.now();
        const p = bot.entity.position;
        console.log(`[ai-player] zone-escape (${reason}): at (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}), ${Math.round(hit.dist)} blocks from ${hit.zone.name}; walking out and home toward ${HOMESTEAD.x} ${HOMESTEAD.y} ${HOMESTEAD.z}`);
        try {
            agent.history?.add('system', `You are inside the no-go zone around ${hit.zone.name}. You are being walked straight home to the homestead at ${HOMESTEAD.x} ${HOMESTEAD.y} ${HOMESTEAD.z}; do not go back there.`);
        } catch (_) {}
        Promise.resolve()
            .then(() => agent.actions.runAction('action:zoneEscape', async () => {
                // 1. Walk out of the zone in short legs, heading away from the zone centres and toward the homestead
                //    (west/north-west from spawn, so he does not cut through the market). If a leg is blocked, rotate.
                const rotations = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
                for (let leg = 0, alt = 0; leg < MAX_LEGS && !bot.interrupt_code; leg++) {
                    const p0 = bot.entity.position.clone();
                    const z0 = zoneAt(p0.x, p0.z);
                    const near = NO_GO_ZONES.some(zn => Math.hypot(p0.x - zn.x, p0.z - zn.z) < NO_GO_RADIUS + EXIT_MARGIN);
                    if (!z0 && !near) break;
                    const [hx, hz] = escapeHeading(p0.x, p0.z);
                    const a = rotations[alt % rotations.length];
                    const dx = LEG_BLOCKS * (hx * Math.cos(a) - hz * Math.sin(a));
                    const dz = LEG_BLOCKS * (hx * Math.sin(a) + hz * Math.cos(a));
                    escapeGoal = new pf.goals.GoalNearXZ(Math.round(p0.x + dx), Math.round(p0.z + dz), 3);
                    try { await goToGoal(bot, escapeGoal); } catch (err) { console.log(`[ai-player] zone-escape leg ${leg + 1}: ${err?.message || err}`); }
                    escapeGoal = null;
                    const moved = bot.entity.position.distanceTo(p0);
                    const q = bot.entity.position;
                    console.log(`[ai-player] zone-escape leg ${leg + 1}: moved ${Math.round(moved)} blocks to (${Math.round(q.x)}, ${Math.round(q.y)}, ${Math.round(q.z)})`);
                    if (moved < 4) alt++; else alt = 0; // blocked: try the next direction
                }
                escapeGoal = null;
                // 2. Out of the zone: continue home.
                const q = bot.entity.position;
                if (!bot.interrupt_code && !zoneAt(q.x, q.z)) {
                    await goToPosition(bot, HOMESTEAD.x, HOMESTEAD.y, HOMESTEAD.z, 3);
                }
            }, { timeout: 10 }))
            .catch(err => console.warn('[ai-player] zone-escape error:', err?.message || err))
            .finally(() => {
                escaping = false;
                const q = bot.entity?.position;
                const still = q ? zoneAt(q.x, q.z) : null;
                console.log(`[ai-player] zone-escape ended at ${q ? `(${Math.round(q.x)}, ${Math.round(q.y)}, ${Math.round(q.z)})` : '?'}; ${still ? `still ${Math.round(still.dist)} blocks from ${still.zone.name}` : 'outside all zones'}`);
            });
    };

    let reason = 'join';
    let lastLabel = '', lastLabelAt = 0;
    bot.on('spawn', () => { reason = 'respawn'; lastEscapeAt = 0; });

    const tick = () => {
        try {
            if (!bot.entity) return;
            // A dynamic goal (following a player/entity) that has moved into a zone: stop it.
            if (activeGoal && activeGoal !== escapeGoal) {
                const hit = zoneForGoal(activeGoal, bot.entity.position);
                if (hit) {
                    refuse(hit, 'active-goal');
                    activeGoal = null;
                    origSetGoal(null);
                }
            }
            const p = bot.entity.position;
            const inside = zoneAt(p.x, p.z);
            // Give Bob's own command (e.g. !goToCoordinates home) up to 90 s before taking over; moves deeper
            // into a zone are refused anyway. Modes (fighting, unstuck) do not count.
            const label = agent.actions?.executing ? String(agent.actions.currentActionLabel || '') : '';
            if (label !== lastLabel) { lastLabel = label; lastLabelAt = Date.now(); }
            const ownCommandRunning = label.startsWith('action:') && label !== 'action:zoneEscape' && Date.now() - lastLabelAt < 90000;
            if (inside && !escaping && !ownCommandRunning && Date.now() - lastEscapeAt > ESCAPE_RETRY_MS) {
                startEscape(inside, reason);
                reason = 'inside-zone';
            }
        } catch (err) {
            console.warn('[ai-player] zone-guard tick error:', err?.message || err);
        }
    };
    const timer = setInterval(tick, TICK_MS);
    bot.once('end', () => clearInterval(timer));
    setTimeout(tick, 1000);
}

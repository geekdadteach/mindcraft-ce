import { HOME } from './bob_home.js';
// [ai-player] Item 3 (Oct 20 evening): reliable cave escape and failed-route detection.
// Oct 20: 67 stuck triggers in 2h16m, clustered in the caves under/west of the house; 8 of 9 escalations "did not reach
// the house entrance or surface" because one long pathfinder goto to a far surface/house goal timed out in the cave.
// Upstream mindcraft's goToSurface() is a single goToPosition with the note "a custom mining and towering up
// implementation could be added if needed"; nothing better upstream. This escape climbs one staircase step at a
// time with mineflayer-pathfinder (its own safeToBreak: no digging next to liquids or under sand/gravel) and checks
// progress after every step; with no way forward it pillars (pathfinder 1x1 tower) and gives up after two stalls.
// gotoChecked() wraps any goto with a progress monitor and blacklists a start->goal route that made no progress.
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import * as nav from './ai_player_nav.js';
import { superseded } from './skills.js';

const HOUSE_C = HOME.escapeCenter;       // house centre (do not stair up under it)
const DIRS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
const LIQUID = /^(lava|water|flowing_lava|flowing_water)$/;
const FALLING = /sand$|gravel|concrete_powder|anvil|pointed_dripstone/;
const ROUTE_TTL = 10 * 60e3;

const routeFails = new Map(); // key -> [timestamps]
const cell = (p, s = 4) => `${Math.floor(p.x / s)},${Math.floor(p.y / s)},${Math.floor(p.z / s)}`;
function goalPos(goal) { return (goal && goal.x != null) ? new Vec3(goal.x, goal.y ?? 0, goal.z) : null; }
export function routeKey(from, goal) { const g = goalPos(goal); return g ? `${cell(from)}->${cell(g, 2)}` : null; }
export function routeBlocked(from, goal) {
    const k = routeKey(from, goal); if (!k) return false;
    const t = (routeFails.get(k) || []).filter(x => Date.now() - x < ROUTE_TTL);
    routeFails.set(k, t);
    return t.length >= 2;
}
function noteRouteFail(agent, from, goal, why) {
    const k = routeKey(from, goal); if (!k) return;
    const t = (routeFails.get(k) || []).filter(x => Date.now() - x < ROUTE_TTL); t.push(Date.now()); routeFails.set(k, t);
    const g = goalPos(goal);
    try { agent?.failures?.record('goto', `${Math.round(g.x)} ${Math.round(g.y)} ${Math.round(g.z)}`, from, why); } catch (_) {}
    if (t.length === 2) console.log(`[ai-player] route: ${k} failed twice (${why}); avoiding it for ${ROUTE_TTL / 60e3} min`);
}

// goto with a progress monitor: stops when neither closer to the goal nor moved >= 2 blocks for noProgressMs.
export async function gotoChecked(agent, goal, { ms = 30000, movements = null, noProgressMs = 12000, label = 'goto', record = true, bypass = false } = {}) {
    const bot = agent.bot;
    const from = bot.entity.position.clone();
    if (record && !bypass && routeBlocked(from, goal)) { console.log(`[ai-player] ${label}: route ${routeKey(from, goal)} is blacklisted; not trying it again yet`); return false; }
    const g = goalPos(goal);
    bot.pathfinder.setMovements(movements || nav.escapeMovements(bot));
    let best = g ? bot.entity.position.distanceTo(g) : 0, lastPos = bot.entity.position.clone(), lastProgress = Date.now();
    let why = 'timeout', timer, mon;
    const gen = bot._actionGen;
    const ok = await Promise.race([
        bot.pathfinder.goto(goal).then(() => true, (e) => { why = e.message; return false; }),
        new Promise(r => { timer = setTimeout(() => r(false), ms); }),
        new Promise(r => {
            mon = setInterval(() => {
                const p = bot.entity.position;
                const d = g ? p.distanceTo(g) : 0;
                if ((g && d < best - 1) || p.distanceTo(lastPos) >= 2 || bot.pathfinder.isMining?.() || bot.pathfinder.isBuilding?.()) {
                    best = Math.min(best, d); lastPos = p.clone(); lastProgress = Date.now();
                }
                if (Date.now() - lastProgress > noProgressMs) { why = `no progress for ${noProgressMs / 1000}s`; r(false); }
                if (bot.interrupt_code || superseded(bot, gen)) { why = 'interrupted'; r(false); }
            }, 1000);
        }),
    ]);
    clearTimeout(timer); clearInterval(mon);
    if (!ok) {
        try { bot.pathfinder.stop(); } catch (_) {}
        if (why !== 'interrupted' && record) noteRouteFail(agent, from, goal, why);
    }
    return ok;
}

function liquidNear(bot, p) {
    for (const d of [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const b = bot.blockAt(p.offset(d[0], d[1], d[2])); if (b && LIQUID.test(b.name)) return true;
    }
    return false;
}
function stepSafe(bot, p, dir) {
    const t = p.plus(dir).offset(0, 1, 0);
    for (const q of [t, t.offset(0, 1, 0), p.offset(0, 2, 0)]) {
        const b = bot.blockAt(q); if (!b) return false;
        if (b.boundingBox === 'block' && nav.KEEP_BLOCKS.test(b.name)) return false;
        if (liquidNear(bot, q)) return false;
    }
    const above = bot.blockAt(t.offset(0, 2, 0)); if (above && FALLING.test(above.name)) return false;
    const lava = bot.blockAt(t.offset(0, -1, 0)); if (lava && /lava|magma/.test(lava.name)) return false;
    return true;
}
function dirOrder(bot) {
    const p = bot.entity.position;
    const dh = Math.hypot(p.x - HOUSE_C.x, p.z - HOUSE_C.z);
    const score = (d) => {
        const n = p.plus(d);
        const away = Math.hypot(n.x - HOUSE_C.x, n.z - HOUSE_C.z) - dh; // > 0: away from the house
        if (dh < 12) return -away;            // under/near the house: climb away from it
        if (dh < 64) return away;             // near home: climb toward it
        return 0;
    };
    return [...DIRS].sort((a, b) => score(a) - score(b));
}

// Climb to open sky. Returns { ok, why, from, to, steps }.
export async function escapeUp(agent, { reason = 'escape', maxMs = 60000 } = {}) {
    const bot = agent.bot;
    const from = bot.entity.position.floored();
    const res = (ok, why) => {
        const to = bot.entity.position.floored();
        console.log(`[ai-player] escape-up (${reason}): ${ok ? 'reached open sky' : 'failed: ' + why} from ${from} to ${to} in ${steps} steps, ${Math.round((Date.now() - t0) / 1000)}s`);
        if (!ok) try { agent.failures?.record('escapeUp', reason, from, why); } catch (_) {}
        return { ok, why, from, to, steps };
    };
    const t0 = Date.now(); let steps = 0;
    if (!nav.isUnderground(bot)) return { ok: true, why: 'already outside', from, to: from, steps };
    try { if (agent.failures?.isBlocked('escapeUp', reason, from)) return res(false, 'escape from this spot failed twice recently'); } catch (_) {}
    console.log(`[ai-player] escape-up (${reason}): underground at ${from} (${nav.skyCheck(bot).cover}); climbing a staircase`);
    const gen = bot._actionGen;
    let pref = null, stalls = 0;
    const m = nav.escapeMovements(bot);
    m.allowParkour = false; m.maxDropDown = 1; // no drops while climbing out
    while (Date.now() - t0 < maxMs) {
        if (bot.interrupt_code || superseded(bot, gen)) return res(false, 'interrupted');
        if (!nav.isUnderground(bot)) return res(true, 'ok');
        const p = bot.entity.position.floored();
        const dirs = dirOrder(bot); if (pref) dirs.unshift(pref);
        let moved = false;
        for (const d of [...new Set(dirs)]) {
            if (!stepSafe(bot, p, d)) continue;
            const t = p.plus(d).offset(0, 1, 0);
            const ok = await gotoChecked(agent, new pf.goals.GoalBlock(t.x, t.y, t.z), { ms: 7000, movements: m, noProgressMs: 5000, label: 'escape step', record: false });
            if (ok && bot.entity.position.y >= p.y + 0.9) { moved = true; pref = d; steps++; break; }
            if (bot.entity.position.y >= p.y + 0.9) { moved = true; steps++; break; } // climbed anyway
        }
        if (!moved) { // pillar straight up (pathfinder places a scaffolding block under itself)
            const ok = await gotoChecked(agent, new pf.goals.GoalBlock(p.x, p.y + 1, p.z), { ms: 6000, movements: m, noProgressMs: 5000, label: 'escape pillar', record: false });
            if (ok || bot.entity.position.y >= p.y + 0.9) { moved = true; steps++; }
        }
        if (moved) stalls = 0; else if (++stalls >= 2) return res(false, 'no safe step up or pillar (liquid, built blocks or no blocks to place)');
    }
    return res(false, `still underground after ${maxMs / 1000}s`);
}

// Note for the model (goes into history / behaviour log): what failed, so it chooses something else.
export function failureNote(text) { return `[failed] ${text}`; }

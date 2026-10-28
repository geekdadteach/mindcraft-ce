// [ai-player] Item 4 (Oct 20 evening): a known safe walking route home. Night mode never got Bob home on foot
// (26 "could not get inside the house"): one long goto from wherever he was, often from the caves under the house.
// Now: (1) underground -> climb out first (escape.js), (2) walk recorded waypoints from open ground to the outside
// plate one at a time with progress checks, (3) go through the door onto the inside plate.
// Routes: a seed route (open ground north of the door, from Bob's own logged positions) plus breadcrumb routes that
// are recorded whenever Bob actually walks on the surface to the door (bots/<name>/home_routes.json).
// No world changes: walking movements first; built blocks are never dug (escapeMovements protects them).
import fs from 'fs';
import { HOME, LEGACY_HOME_ENTRANCE, sameHomeEntrance } from './bob_home.js';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import * as nav from './ai_player_nav.js';
import { superseded } from './skills.js';

export const ENTRANCE = new Vec3(HOME.entrance.x, HOME.entrance.y, HOME.entrance.z);  // outside pressure plate -820 124 565 (north of the door)
export const INSIDE = new Vec3(HOME.inside.x, HOME.inside.y, HOME.inside.z);    // inside plate -820 124 567 (door oak -820 124 566, facing south)
// seed: open ground north of the door, from logged positions (-820 123 559/560, -818 123 565); y is checked at run time
const SEED = HOME.seedRoute;
const MAX_ROUTES = 8, CRUMB_SPACING = 4, CRUMB_WINDOW_MS = 120e3;

export class HomeRoutes {
    constructor(agent) {
        this.agent = agent;
        this.file = `./bots/${agent.name}/home_routes.json`;
        this.data = { version: 2, home: HOME.entrance, routes: [] };
        try { if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { console.warn(`[ai-player] home-route: load failed (${e.message})`); }
        // Existing version-1 routes are retained only for the unchanged home.
        // On relocation, discard stale waypoints but keep the original file untouched until save().
        const previous = this.data.home || LEGACY_HOME_ENTRANCE;
        this.needsArchive = false;
        if (!sameHomeEntrance(previous)) {
            console.warn('[ai-player] home-route: home changed; invalidating routes for previous entrance');
            this.needsArchive = true;
            this.data.routes = [];
        }
        this.data.version = 2;
        this.data.home = HOME.entrance;
        if (!this.data.routes.find(r => r.id === 'seed-north')) this.data.routes.push({ id: 'seed-north', pts: SEED, ok: 0, fail: 0, recorded: 0 });
        this.crumbs = [];
        this.walkHome = (agent, opts) => this.walk(opts);
    }
    save() {
        try {
            if (this.needsArchive && fs.existsSync(this.file)) {
                fs.copyFileSync(this.file, this.file + '.pre-relocation.json');
                this.needsArchive = false;
            }
            fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
            fs.renameSync(this.file + '.tmp', this.file);
        }
        catch (e) { console.warn(`[ai-player] home-route: save failed (${e.message})`); }
    }
    // called every 2 s: breadcrumbs while walking on the surface near home; saved as a route when he reaches the door
    tick() {
        const bot = this.agent.bot; const p = bot?.entity?.position; if (!p) return;
        const now = Date.now();
        this.crumbs = this.crumbs.filter(c => now - c.t < CRUMB_WINDOW_MS);
        if (this.walking) return; // routes come from his own walks, not from replaying a route
        if (p.distanceTo(ENTRANCE) <= 1.5 && this.crumbs.length >= 3) {
            const pts = this.crumbs.map(c => c.p).concat([[ENTRANCE.x, ENTRANCE.y, ENTRANCE.z]]);
            const far = Math.hypot(pts[0][0] - ENTRANCE.x, pts[0][2] - ENTRANCE.z);
            if (far >= 10) this.addRoute(pts);
            this.crumbs = [];
            return;
        }
        if (Math.hypot(p.x - ENTRANCE.x, p.z - ENTRANCE.z) > 64 || nav.isInsideHouse(bot)) { this.crumbs = []; return; }
        if (!bot.entity.onGround || nav.isUnderground(bot)) { if (nav.isUnderground(bot)) this.crumbs = []; return; }
        const last = this.crumbs[this.crumbs.length - 1];
        if (!last || Math.hypot(p.x - last.p[0], p.y - last.p[1], p.z - last.p[2]) >= CRUMB_SPACING)
            this.crumbs.push({ t: now, p: [Math.floor(p.x) + 0.5, Math.floor(p.y + 0.01), Math.floor(p.z) + 0.5] });
    }
    addRoute(pts) {
        pts = pts.slice(-14);
        const R = this.data.routes;
        const same = R.find(r => r.pts.length && Math.hypot(r.pts[0][0] - pts[0][0], r.pts[0][2] - pts[0][2]) < 4);
        if (same && same.id !== 'seed-north') { same.pts = pts; same.recorded = Date.now(); }
        else R.push({ id: `walk-${Date.now()}`, pts, ok: 1, fail: 0, recorded: Date.now() });
        if (R.length > MAX_ROUTES) { R.sort((a, b) => (b.id === 'seed-north') - (a.id === 'seed-north') || (b.ok - b.fail) - (a.ok - a.fail) || b.recorded - a.recorded); R.length = MAX_ROUTES; }
        console.log(`[ai-player] home-route: recorded a ${pts.length}-point surface route from ${pts[0].map(Math.floor).join(' ')} to the door`);
        this.save();
    }
    // standable check around a waypoint; returns the adjusted Vec3 (y +-1) or null
    fit(bot, pt) {
        for (const dy of [0, 1, -1]) {
            const v = new Vec3(pt[0], pt[1] + dy, pt[2]);
            const below = bot.blockAt(v.offset(0, -1, 0)), feet = bot.blockAt(v), head = bot.blockAt(v.offset(0, 1, 0));
            if (!below || !feet || !head) return new Vec3(pt[0], pt[1], pt[2]); // chunk not loaded: trust the record
            if (below.boundingBox === 'block' && feet.boundingBox === 'empty' && head.boundingBox === 'empty' && !/lava|water/.test(feet.name)) return v;
            if (/pressure_plate/.test(feet.name) && head.boundingBox === 'empty') return v;
        }
        return null;
    }
    pickRoute(bot) {
        const p = bot.entity.position;
        let best = null;
        for (const r of this.data.routes) {
            if (r.fail - r.ok >= 3 && Date.now() - (r.last_fail || 0) < 30 * 60e3) continue; // keeps failing: rest it
            let bi = 0, bd = Infinity;
            r.pts.forEach((q, i) => { const d = Math.hypot(q[0] - p.x, q[2] - p.z) + Math.abs(q[1] - p.y) * 2; if (d < bd) { bd = d; bi = i; } });
            const score = bd - (r.ok - r.fail) * 2;
            if (!best || score < best.score) best = { r, start: bi, score, d: bd };
        }
        return best;
    }
    // Walk home. inside=true also goes through the door onto the inside plate.
    async walk({ inside = true, maxMs = 120000 } = {}) {
        const agent = this.agent, bot = agent.bot, t0 = Date.now(), gen = bot._actionGen;
        if (nav.isInsideHouse(bot)) return true;
        this.walking = true;
        try {
            if (nav.isUnderground(bot) && agent.escape?.up) {
                const up = await agent.escape.up(agent, { reason: 'home', maxMs: 60000 });
                if (!up.ok) console.log(`[ai-player] home-route: could not climb out first (${up.why}); trying the route from here`);
            }
            const tried = new Set();
            while (Date.now() - t0 < maxMs && !bot.interrupt_code && !superseded(bot, gen)) {
                if (bot.entity.position.distanceTo(ENTRANCE) <= 1.6) break;
                const pick = this.pickRoute(bot);
                if (!pick || tried.has(pick.r.id)) {
                    // no (other) route: one direct checked walk to the entrance
                    const ok = await agent.escape.gotoChecked(agent, new pf.goals.GoalNear(ENTRANCE.x, ENTRANCE.y, ENTRANCE.z, 1), { ms: 45000, movements: nav.walkMovements(bot), label: 'home direct', bypass: true });
                    if (!ok) { console.log('[ai-player] home-route: direct walk failed too'); return false; }
                    break;
                }
                tried.add(pick.r.id);
                const r = pick.r;
                console.log(`[ai-player] home-route: walking route ${r.id} from waypoint ${pick.start + 1}/${r.pts.length} (${Math.round(pick.d)}m away)`);
                let misses = 0, done = true;
                for (let i = pick.start; i < r.pts.length; i++) {
                    if (bot.interrupt_code || superseded(bot, gen) || Date.now() - t0 > maxMs) { done = false; break; }
                    const v = this.fit(bot, r.pts[i]);
                    if (!v) { console.log(`[ai-player] home-route: waypoint ${r.pts[i].join(' ')} is not standable now; skipping`); continue; }
                    const last = i === r.pts.length - 1;
                    let ok = await agent.escape.gotoChecked(agent, last ? new pf.goals.GoalBlock(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) : new pf.goals.GoalNear(v.x, v.y, v.z, 1.2), { ms: 30000, movements: nav.walkMovements(bot), noProgressMs: 10000, label: `home wp${i + 1}` });
                    if (!ok && !bot.interrupt_code) ok = await agent.escape.gotoChecked(agent, new pf.goals.GoalNear(v.x, v.y, v.z, 1.5), { ms: 25000, movements: nav.escapeMovements(bot), noProgressMs: 10000, label: `home wp${i + 1} (dig)`, bypass: true });
                    if (!ok) { if (++misses >= 2) { done = false; break; } } else misses = 0;
                }
                if (done && bot.entity.position.distanceTo(ENTRANCE) <= 2) { r.ok++; this.save(); break; }
                r.fail++; r.last_fail = Date.now(); this.save();
                try { agent.failures?.record('walkHome', r.id, bot.entity.position.floored(), 'route waypoints unreachable'); } catch (_) {}
            }
            if (bot.entity.position.distanceTo(ENTRANCE) > 2.5) return false;
            if (!inside) return true;
            await agent.escape.gotoChecked(agent, new pf.goals.GoalBlock(Math.floor(INSIDE.x), INSIDE.y, Math.floor(INSIDE.z)), { ms: 20000, movements: nav.walkMovements(bot), noProgressMs: 8000, label: 'door', record: false });
            return nav.isInsideHouse(bot);
        } finally { this.walking = false; }
    }
}

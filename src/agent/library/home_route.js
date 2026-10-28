// Known safe walking route to a verified home. With no verified house this
// recorder is inert: it does not seed the retired hilltop or walk there.
import fs from 'fs';
import { getActiveHome, isVerifiedHome, LEGACY_HOME_ENTRANCE, sameHomeEntrance } from './bob_home.js';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import * as nav from './ai_player_nav.js';
import { superseded } from './skills.js';

const MAX_ROUTES = 8, CRUMB_SPACING = 4, CRUMB_WINDOW_MS = 120e3;

function pointOf(home, which) {
    const p = isVerifiedHome(home) ? home[which] : null;
    return p ? new Vec3(p.x, p.y, p.z) : null;
}

export function entranceOf(home = getActiveHome()) { return pointOf(home, 'entrance'); }
export function insideOf(home = getActiveHome()) { return pointOf(home, 'inside'); }
export const ENTRANCE = { get x() { return entranceOf()?.x; }, get y() { return entranceOf()?.y; }, get z() { return entranceOf()?.z; }, distanceTo(o) { const v = entranceOf(); return v ? v.distanceTo(o) : Infinity; } };
export const INSIDE = { get x() { return insideOf()?.x; }, get y() { return insideOf()?.y; }, get z() { return insideOf()?.z; }, distanceTo(o) { const v = insideOf(); return v ? v.distanceTo(o) : Infinity; } };

export class HomeRoutes {
    constructor(agent) {
        this.agent = agent;
        this.file = `./bots/${agent.name}/home_routes.json`;
        this.data = { version: 2, home: null, routes: [] };
        try { if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { console.warn(`[ai-player] home-route: load failed (${e.message})`); }
        this.needsArchive = false;
        const active = getActiveHome();
        const previous = this.data.home || (this.data.version === 1 ? LEGACY_HOME_ENTRANCE : null);
        if (!isVerifiedHome(active)) {
            if (previous && (sameHomeEntrance(previous, LEGACY_HOME_ENTRANCE) || this.data.routes?.length)) {
                console.warn('[ai-player] home-route: no verified home; not using saved hilltop routes');
                this.needsArchive = this.data.routes?.length > 0;
            }
            this.data = { version: 2, home: null, routes: [] };
        } else {
            if (previous && !sameHomeEntrance(previous, active.entrance)) {
                console.warn('[ai-player] home-route: home changed; invalidating routes for previous entrance');
                this.needsArchive = true;
                this.data.routes = [];
            }
            this.data.version = 2;
            this.data.home = active.entrance;
            const seed = active.seedRoute;
            if (seed && !this.data.routes.find(r => r.id === 'seed')) this.data.routes.push({ id: 'seed', pts: seed, ok: 0, fail: 0, recorded: 0 });
        }
        this.crumbs = [];
        this.walkHome = (agent, opts) => this.walk(opts);
    }
    home() { return getActiveHome(); }
    entrance() { return entranceOf(this.home()); }
    inside() { return insideOf(this.home()); }
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
    tick() {
        const bot = this.agent.bot; const p = bot?.entity?.position; if (!p) return;
        const E = this.entrance();
        if (!E) { this.crumbs = []; return; }
        const now = Date.now();
        this.crumbs = this.crumbs.filter(c => now - c.t < CRUMB_WINDOW_MS);
        if (this.walking) return;
        if (p.distanceTo(E) <= 1.5 && this.crumbs.length >= 3) {
            const pts = this.crumbs.map(c => c.p).concat([[E.x, E.y, E.z]]);
            const far = Math.hypot(pts[0][0] - E.x, pts[0][2] - E.z);
            if (far >= 10) this.addRoute(pts);
            this.crumbs = [];
            return;
        }
        if (Math.hypot(p.x - E.x, p.z - E.z) > 64 || nav.isInsideHouse(bot)) { this.crumbs = []; return; }
        if (!bot.entity.onGround || nav.isUnderground(bot)) { if (nav.isUnderground(bot)) this.crumbs = []; return; }
        const last = this.crumbs[this.crumbs.length - 1];
        if (!last || Math.hypot(p.x - last.p[0], p.y - last.p[1], p.z - last.p[2]) >= CRUMB_SPACING)
            this.crumbs.push({ t: now, p: [Math.floor(p.x) + 0.5, Math.floor(p.y + 0.01), Math.floor(p.z) + 0.5] });
    }
    addRoute(pts) {
        pts = pts.slice(-14);
        const R = this.data.routes;
        const same = R.find(r => r.pts.length && Math.hypot(r.pts[0][0] - pts[0][0], r.pts[0][2] - pts[0][2]) < 4);
        if (same && same.id !== 'seed') { same.pts = pts; same.recorded = Date.now(); }
        else R.push({ id: `walk-${Date.now()}`, pts, ok: 1, fail: 0, recorded: Date.now() });
        if (R.length > MAX_ROUTES) { R.sort((a, b) => (b.id === 'seed') - (a.id === 'seed') || (b.ok - b.fail) - (a.ok - a.fail) || b.recorded - a.recorded); R.length = MAX_ROUTES; }
        console.log(`[ai-player] home-route: recorded a ${pts.length}-point surface route from ${pts[0].map(Math.floor).join(' ')} to the door`);
        this.save();
    }
    fit(bot, pt) {
        for (const dy of [0, 1, -1]) {
            const v = new Vec3(pt[0], pt[1] + dy, pt[2]);
            const below = bot.blockAt(v.offset(0, -1, 0)), feet = bot.blockAt(v), head = bot.blockAt(v.offset(0, 1, 0));
            if (!below || !feet || !head) return new Vec3(pt[0], pt[1], pt[2]);
            if (below.boundingBox === 'block' && feet.boundingBox === 'empty' && head.boundingBox === 'empty' && !/lava|water/.test(feet.name)) return v;
            if (/pressure_plate/.test(feet.name) && head.boundingBox === 'empty') return v;
        }
        return null;
    }
    pickRoute(bot) {
        const p = bot.entity.position;
        let best = null;
        for (const r of this.data.routes) {
            if (r.fail - r.ok >= 3 && Date.now() - (r.last_fail || 0) < 30 * 60e3) continue;
            let bi = 0, bd = Infinity;
            r.pts.forEach((q, i) => { const d = Math.hypot(q[0] - p.x, q[2] - p.z) + Math.abs(q[1] - p.y) * 2; if (d < bd) { bd = d; bi = i; } });
            const score = bd - (r.ok - r.fail) * 2;
            if (!best || score < best.score) best = { r, start: bi, score, d: bd };
        }
        return best;
    }
    async walk({ inside = true, maxMs = 120000 } = {}) {
        const agent = this.agent, bot = agent.bot, t0 = Date.now(), gen = bot._actionGen;
        const E = this.entrance(), I = this.inside();
        if (!E) {
            console.log('[ai-player] home-route: no verified home; not walking to a house');
            return false;
        }
        if (nav.isInsideHouse(bot)) return true;
        this.walking = true;
        try {
            if (nav.isUnderground(bot) && agent.escape?.up) {
                const up = await agent.escape.up(agent, { reason: 'home', maxMs: 60000 });
                if (!up.ok) console.log(`[ai-player] home-route: could not climb out first (${up.why}); trying the route from here`);
            }
            const tried = new Set();
            while (Date.now() - t0 < maxMs && !bot.interrupt_code && !superseded(bot, gen)) {
                if (bot.entity.position.distanceTo(E) <= 1.6) break;
                const pick = this.pickRoute(bot);
                if (!pick || tried.has(pick.r.id)) {
                    const ok = await agent.escape.gotoChecked(agent, new pf.goals.GoalNear(E.x, E.y, E.z, 1), { ms: 45000, movements: nav.walkMovements(bot), label: 'home direct', bypass: true });
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
                if (done && bot.entity.position.distanceTo(E) <= 2) { r.ok++; this.save(); break; }
                r.fail++; r.last_fail = Date.now(); this.save();
                try { agent.failures?.record('walkHome', r.id, bot.entity.position.floored(), 'route waypoints unreachable'); } catch (_) {}
            }
            if (bot.entity.position.distanceTo(E) > 2.5) return false;
            if (!inside) return true;
            if (I) await agent.escape.gotoChecked(agent, new pf.goals.GoalBlock(Math.floor(I.x), I.y, Math.floor(I.z)), { ms: 20000, movements: nav.walkMovements(bot), noProgressMs: 8000, label: 'door', record: false });
            return nav.isInsideHouse(bot);
        } finally { this.walking = false; }
    }
}

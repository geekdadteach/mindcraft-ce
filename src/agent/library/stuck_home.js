import { getActiveHome, isLegacyHilltopPos, isVerifiedHome } from './bob_home.js';
// [ai-player] stuck-home-20261026 (approved by Randy, Oct 26 2026 1:56 PM ET: "Go with /home house set at his
// door, block cheat mode, and restart Bob").
// Code-only self-rescue: when Bob is near a verified home but cannot walk to it, send the fixed Essentials
// command '/home house'. The LLM never controls this: no command, no argument, no text from the model reaches it.
// Without a verified home this path is inert: the retired hilltop is not a destination.
// Fires only when ALL hold:
//   - within cfg.radius blocks of the door (default 64; run/stuck-home.config.json "radius": null or 0 = unlimited,
//     nodistance-20261026), and not already at it;
//   - 3 consecutive failed walk-home attempts (night/home-route walker, unstuck walkHome, goToRememberedPlace
//     house/home), OR 120 s without getting 2 blocks closer while a home goal is active;
//   - >= 10 min since the last attempt (persisted in bots/<name>/stuck_home.json across restarts);
//   - not in a combat mode and no damage in the last 15 s.
// Manual triggers (inbox kind 'tphome', bob-m4-ctl tphome, Discord /bob recover teleport:true) replace the
// failure condition but keep the other checks; 'force' only lowers the 10-min backoff to 35 s (Essentials
// teleport-cooldown is 30 s).
// pr20-reconciled-20261027: automatic triggers (fail count / no progress) are OFF by default so the
// independent-exploration goal is not hijacked by a teleport home. Opt back in with
// run/stuck-home.config.json "auto": true or BOB_STUCK_HOME_AUTO=1. Manual requests (inbox tphome,
// bob-m4-ctl tphome, Discord recover teleport:true) are unchanged and keep every other check.
// Sequence: stop the action, freeze modes/movement, send, stand still for the Essentials warmup (3 s on .63,
// cancelled on movement; default hold 3.5 s), then verify by position: within 2 blocks of the door = success
// -> memory note + reset:<action> lesson (via ResetRecovery.recordReset) + log. Otherwise log and back off.
import fs from 'fs';
import path from 'path';
import { HOME_CMD, sendFixedHomeCommand, chatGuardArmed } from './chat_guard.js';
export { HOME_CMD };

export function doorOf(home = getActiveHome()) {
    return isVerifiedHome(home) ? home.entrance : null;
}
export const DOOR = { get x() { return doorOf()?.x; }, get y() { return doorOf()?.y; }, get z() { return doorOf()?.z; } };
// pr20-reconciled-20261027: no distance limit in the note.
export const STUCK_HOME_NOTE = 'You were stuck, so /home house brought you to your front door. Start fresh: check your inventory, avoid the route and spot where you got stuck, then pick a reachable destination and continue your own activity wherever it is safe and permitted.';
export const DEFAULTS = Object.freeze({
    radius: 64, failLimit: 3, failMemoryMs: 30 * 60_000, noProgressMs: 120_000, progressBlocks: 2,
    goalWindowMs: 180_000, backoffMs: 600_000, forceMinMs: 35_000, damageQuietMs: 15_000,
    warmupMs: 3500, verifyMs: 6000, successDist: 2, atDoorDist: 3, tickMs: 5000,
    auto: false, // pr20-reconciled-20261027: automatic teleport off; manual request() still works
});
const COMBAT = /^mode:(self_preservation|self_defense|cowardice|ranged_threat|hunting)$/;
const FAIL_CHAT = /permission|not have access|unknown (or incomplete )?command|not found|does ?n[o']t exist|no home|cancel|before next teleport|cooldown|error/i;

export function distTo(p, t = doorOf()) {
    if (!p || !t || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    if (![t.x, t.y, t.z].every(Number.isFinite)) return null;
    return Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
}

// Pure decision. s: { dist, fails, goalActive, stalledMs, lastAttemptMs, lastDamageMs, combat, busy, manual, force }
export function decide(s, now, cfg = DEFAULTS) {
    if (s.busy) return { go: false, why: 'already teleporting' };
    if (s.noHome) return { go: false, why: 'no verified home' };
    if (s.dist == null) return { go: false, why: 'no position' };
    if (s.dist <= cfg.atDoorDist) return { go: false, why: 'already at the door' };
    if (cfg.radius && s.dist > cfg.radius) return { go: false, why: `${Math.round(s.dist)} blocks from the door (> ${cfg.radius})` }; // radius null/0 = unlimited
    if (s.combat) return { go: false, why: 'in combat' };
    if (now - (s.lastDamageMs ?? -Infinity) < cfg.damageQuietMs) return { go: false, why: 'took damage recently' };
    const since = now - (s.lastAttemptMs || 0);
    const minGap = s.force ? cfg.forceMinMs : cfg.backoffMs;
    if (since < minGap) return { go: false, why: `backoff: last attempt ${Math.round(since / 1000)} s ago (< ${Math.round(minGap / 1000)} s)` };
    if (s.manual) return { go: true, why: s.force ? 'manual request (force)' : 'manual request' };
    if (s.fails >= cfg.failLimit) return { go: true, why: `${s.fails} consecutive failed walk-home attempts` };
    if (s.goalActive && s.stalledMs >= cfg.noProgressMs) return { go: true, why: `no progress toward the house for ${Math.round(s.stalledMs / 1000)} s` };
    return { go: false, why: 'not stuck' };
}

export function loadConfig(env = process.env, file = path.resolve('run/stuck-home.config.json')) {
    const cfg = { ...DEFAULTS };
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Number.isFinite(j.warmup_ms)) cfg.warmupMs = j.warmup_ms;
        // nodistance-20261026: "radius": null or 0 = no distance limit; a positive number = limit in blocks.
        if (j && Object.prototype.hasOwnProperty.call(j, 'radius')) {
            if (j.radius == null || j.radius === 0) cfg.radius = null;
            else if (Number.isFinite(j.radius) && j.radius > 0) cfg.radius = j.radius;
        }
        if (j && typeof j.auto === 'boolean') cfg.auto = j.auto; // pr20-reconciled-20261027
    } catch (_) {}
    if (env.BOB_STUCK_HOME_AUTO === '1') cfg.auto = true;
    else if (env.BOB_STUCK_HOME_AUTO === '0') cfg.auto = false;
    const w = Number(env.BOB_STUCK_HOME_WARMUP_MS);
    if (env.BOB_STUCK_HOME_WARMUP_MS != null && Number.isFinite(w)) cfg.warmupMs = w;
    cfg.warmupMs = Math.max(0, Math.min(cfg.warmupMs, 15000));
    return cfg;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class StuckHome {
    constructor(agent, { file, cfg = DEFAULTS, now = Date.now, send = null, wait = sleep } = {}) {
        this.agent = agent; this.cfg = cfg; this.now = now; this.wait = wait;
        this.file = file || path.resolve(`bots/${agent.name || 'MineBobNE'}/stuck_home.json`);
        this.send = send || (() => sendFixedHomeCommand(agent.bot));
        this.state = { last_attempt_ms: 0, last_result: '', attempts: 0, successes: 0 };
        try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (_) {}
        this.fails = 0; this.lastFailMs = 0;
        this.goalUntil = 0; this.best = null; this.bestAt = 0;
        this.lastDamageMs = -Infinity; this._hp = null;
        this.busy = false; this.holding = false; this._logged = {};
    }
    log(m) { console.log(`[ai-player] stuck-home: ${m}`); }
    _logOnce(key, m, ms = 60000) { const t = this.now(); if (t - (this._logged[key] || 0) >= ms) { this._logged[key] = t; this.log(m); } }
    save() {
        try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(this.state) + '\n'); fs.renameSync(tmp, this.file); }
        catch (e) { this.log(`could not save ${this.file} (${e.message})`); }
    }
    _pos() { const p = this.agent.bot?.entity?.position; return p ? { x: p.x, y: p.y, z: p.z } : null; }
    _home() { return this.agent.homeState?.snapshot?.() || getActiveHome(); }
    _door() { return doorOf(this._home()); }
    _combat() { return COMBAT.test(this.agent.actions?.currentActionLabel || ''); }
    goalActive() { return !!this.agent.home?.walking || this.now() < this.goalUntil; }

    // a home goal started (walker/goToRememberedPlace). Keeps the goal "active" for goalWindowMs after the attempt.
    markHomeGoal() {
        if (this.holding) return;
        const t = this.now();
        if (!this.goalActive() || !this.best) { this.best = distTo(this._pos()); this.bestAt = t; }
        this.goalUntil = t + this.cfg.goalWindowMs;
    }
    _goalDone() { this.goalUntil = 0; this.best = null; this.fails = 0; }

    reportHomeAttempt(ok, source) {
        if (this.holding) return null; // our own stop() interrupted it
        const t = this.now();
        if (ok) { if (this.fails) this.log(`walk home ok via ${source}; failure count reset`); this._goalDone(); return null; }
        if (t - this.lastFailMs > this.cfg.failMemoryMs) this.fails = 0;
        this.fails++; this.lastFailMs = t; this.goalUntil = t + this.cfg.goalWindowMs;
        this.log(`walk home failed via ${source} (${this.fails}/${this.cfg.failLimit} in a row)`);
        return this.maybeTrigger();
    }

    _status(extra = {}) {
        const t = this.now(), door = this._door(), d = distTo(this._pos(), door);
        return { dist: d, noHome: !door, fails: this.fails, goalActive: this.goalActive(), stalledMs: this.best == null ? 0 : t - this.bestAt,
            lastAttemptMs: this.state.last_attempt_ms, lastDamageMs: this.lastDamageMs, combat: this._combat(), busy: this.busy, ...extra };
    }

    tick() {
        try {
            const t = this.now(), d = distTo(this._pos(), this._door());
            const hp = this.agent.bot?.health;
            if (Number.isFinite(hp)) { if (this._hp != null && hp < this._hp) this.lastDamageMs = t; this._hp = hp; }
            if (d != null && d <= this.cfg.atDoorDist) { if (this.fails || this.best != null) this._goalDone(); return null; }
            if (!this.goalActive()) { this.best = null; return null; }
            if (this.best == null || d == null) { this.best = d; this.bestAt = t; return null; }
            if (d < this.best - this.cfg.progressBlocks) { this.best = d; this.bestAt = t; return null; }
            if (t - this.bestAt >= this.cfg.noProgressMs) return this.maybeTrigger();
        } catch (_) {}
        return null;
    }

    maybeTrigger() {
        const st = this._status();
        if (!this.cfg.auto) { // pr20-reconciled-20261027: automatic teleport disabled; only request() teleports
            if (st.fails >= this.cfg.failLimit || (st.goalActive && st.stalledMs >= this.cfg.noProgressMs)) this._logOnce('auto-off', 'stuck near home; automatic teleport is off (manual tphome still available)', 600_000);
            return null;
        }
        const dec = decide(st, this.now(), this.cfg);
        if (!dec.go) {
            if (st.fails >= this.cfg.failLimit || (st.goalActive && st.stalledMs >= this.cfg.noProgressMs)) this._logOnce(dec.why.split(':')[0], `stuck near home but not teleporting: ${dec.why}`);
            return null;
        }
        return this.teleport(dec.why);
    }

    // manual trigger (inbox tphome). Returns a result string.
    async request({ force = false, by = 'operator' } = {}) {
        const dec = decide(this._status({ manual: true, force }), this.now(), this.cfg);
        if (!dec.go) { this.log(`manual request by ${by} refused: ${dec.why}`); return `not sent: ${dec.why}`; }
        return this.teleport(`${dec.why} by ${by}`);
    }

    _still() {
        const bot = this.agent.bot;
        try { bot.pathfinder?.stop?.(); bot.pathfinder?.setGoal?.(null); } catch (_) {}
        try { bot.clearControlStates?.(); } catch (_) {}
    }

    async teleport(why) {
        if (this.busy) return 'not sent: already teleporting';
        this.busy = true; this.holding = true;
        const agent = this.agent, bot = agent.bot, cfg = this.cfg;
        const from = this._pos(), action = agent.actions?.currentActionLabel || '';
        const fmt = (p) => p ? [p.x, p.y, p.z].map(v => v.toFixed(1)).join(' ') : '?';
        let result, lines = [];
        const onMsg = (m) => { const s = String(m || ''); if (!s.startsWith('<')) lines.push(s.slice(0, 200)); };
        try {
            const door = this._door();
            if (!door) { this.log('TELEPORT refused: no verified home'); return 'not sent: no verified home'; }
            this.state.last_attempt_ms = this.now(); this.state.attempts = (this.state.attempts || 0) + 1; this.state.last_reason = why; this.save();
            this.log(`TELEPORT: ${why}; at ${fmt(from)} (${Math.round(distTo(from, door) || 0)} blocks from the door), action ${action || '-'}; stopping and sending "${HOME_CMD}"`);
            try { agent.resetRecovery?.detector?.setLastTrigger(this.now()); } catch (_) {} // the 20-block detector must not record it twice
            try { agent.actions?.cancelResume?.(); } catch (_) {}
            try { await Promise.race([agent.actions?.stop?.(), this.wait(12000)]); } catch (_) {}
            this._still();
            bot?.on?.('messagestr', onMsg);
            const sentAt = this.now();
            this.send();
            let d = distTo(this._pos(), door);
            while (this.now() - sentAt < cfg.warmupMs + cfg.verifyMs) {
                await this.wait(100);
                if (agent.actions?.executing) { try { agent.actions.stop(); } catch (_) {} }
                this._still();
                d = distTo(this._pos(), door);
                if (d != null && d <= cfg.successDist) break;
                if (this.now() - sentAt >= cfg.warmupMs && lines.some(l => FAIL_CHAT.test(l))) break;
            }
            if (isLegacyHilltopPos(this._pos(), 16)) {
                this.state.last_result = 'fail: landed at retired hilltop';
                this.log('TELEPORT failed: landed at the retired hilltop; treating as failure');
                result = 'failed: landed at retired hilltop';
            } else if (d != null && d <= cfg.successDist) {
                this.state.last_result = 'ok'; this.state.successes = (this.state.successes || 0) + 1; this._goalDone();
                this.log(`TELEPORT ok: now at ${fmt(this._pos())} (${d.toFixed(1)} from the door)`);
                this.holding = false;
                if (agent.resetRecovery?.recordReset) await agent.resetRecovery.recordReset({ reason: 'stuck-home', pos: from, action, note: STUCK_HOME_NOTE });
                else {
                    await agent.history?.add?.('system', STUCK_HOME_NOTE); await agent.history?.save?.();
                    const a = (action.replace(/^(action|mode):/, '').replace(/[^A-Za-z0-9_]/g, '') || 'unknown').slice(0, 40);
                    agent.longMemory?._addLesson?.(`reset:${a}`, `Got stuck and needed a reset near ${from ? [from.x, from.y, from.z].map(Math.round).join(' ') : 'unknown'} while doing ${a}; if an action keeps failing there, move elsewhere or switch task sooner.`, 'fail');
                }
                result = `teleported home (${d.toFixed(1)} blocks from the door)`;
            } else {
                const msg = lines.find(l => FAIL_CHAT.test(l));
                this.state.last_result = `fail: ${msg || 'position did not change'}`;
                this.log(`TELEPORT failed: ${msg ? 'server said "' + msg + '"' : 'position did not change'}; still at ${fmt(this._pos())}; next automatic try in >= ${Math.round(cfg.backoffMs / 60000)} min`);
                result = `failed: ${msg || 'position did not change'}`;
            }
            this.save();
            return result;
        } finally {
            try { bot?.removeListener?.('messagestr', onMsg); } catch (_) {}
            this.holding = false; this.busy = false;
        }
    }

    install() {
        const bot = this.agent.bot;
        try { bot.on('health', () => { const hp = bot.health; if (this._hp != null && hp < this._hp) this.lastDamageMs = this.now(); this._hp = hp; }); } catch (_) {}
        this._t = setInterval(() => { const p = this.tick(); if (p?.catch) p.catch(e => this.log(`tick failed (${e.message})`)); }, this.cfg.tickMs);
        const last = this.state.last_attempt_ms ? new Date(this.state.last_attempt_ms).toISOString() : 'never';
        const cheat = (() => { try { return bot.modes?.isOn('cheat') ? 'ON' : 'off'; } catch (_) { return '?'; } })();
        const door = this._door();
        this.log(`armed: automatic ${this.cfg.auto ? 'ON' : 'off (manual only)'}, cmd "${HOME_CMD}", door ${door ? `${door.x} ${door.y} ${door.z}` : 'none (no verified home)'}, radius ${this.cfg.radius ? this.cfg.radius : 'unlimited'}, ${this.cfg.failLimit} fails or ${this.cfg.noProgressMs / 1000} s no progress, backoff ${this.cfg.backoffMs / 1000} s (force ${this.cfg.forceMinMs / 1000} s), hold ${this.cfg.warmupMs} ms, last attempt ${last} (${this.state.last_result || '-'}); chat-guard ${chatGuardArmed(bot) ? 'armed' : 'NOT armed'}; cheat mode ${cheat}`);
    }
}

export function installStuckHome(agent, opts = {}) {
    if (agent.stuckHome) return agent.stuckHome;
    agent.stuckHome = new StuckHome(agent, { cfg: loadConfig(), ...opts });
    agent.stuckHome.install();
    return agent.stuckHome;
}

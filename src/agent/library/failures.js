// [ai-player] Item 5 (Oct 20 evening): learning from failure. Records which actions fail, where and why
// (command, target, location, error, count) in bots/<name>/failures.json next to lessons/places/skills, decays them,
// shows the model the few most relevant recent ones (~200 tokens), and blocks the same failing command at the same
// spot after it failed twice recently, with a short reason so the model picks something else.
// Pattern follows Reflexion / Voyager-style failure feedback that the existing long_memory.js already uses for lessons.
import fs from 'fs';
import { coordCellLabel } from './bob_nav_memory.js';
import { isGuardBlockResult } from './bob_survival_gate.js';

const HALF_LIFE_MS = 2 * 3600e3;      // a failure's weight halves every 2 h
const MAX_AGE_MS = 48 * 3600e3;
const BLOCK_WINDOW_MS = 15 * 60e3;    // 2+ failures of the same thing here within 15 min -> blocked
const BLOCK_RADIUS = 12;
const MAX_ENTRIES = 200;
const FAIL_RE = /(failed|could not|couldn't|cannot|can't|unable to|no path|path not found|unreachable|not found|no \w+ (nearby|found)|collected 0|took to long|timed out|invalid|don't have|you do not have|not enough|is blocked|stuck|did not reach|no more \w+ nearby)/i;
const OK_RE = /(successfully|collected [1-9]|you have reached|picked [1-9]|got food|reached)/i;

const cellOf = (p, s = 8) => p ? `${Math.floor(p.x / s)},${Math.floor(p.y / s)},${Math.floor(p.z / s)}` : '-';
const norm = (v) => String(v ?? '').toLowerCase().replace(/^minecraft:/, '').slice(0, 40);

function coarsenFailureTarget(cmd, target) {
    const text = String(target ?? '');
    const nums = text.match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 3)
        return coordCellLabel(Number(nums[0]), Number(nums[1]), Number(nums[2]));
    if (/gotocoordinates/.test(String(cmd || '')) && nums?.length === 1)
        return text;
    return norm(target);
}

export class Failures {
    constructor(agent) {
        this.agent = agent;
        this.file = `./bots/${agent.name}/failures.json`;
        this.data = { version: 1, failures: [] };
        try { if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
        catch (e) { console.warn(`[ai-player] failures: load failed (${e.message}); starting empty`); }
        this._timer = null;
        this.decay();
    }
    save() {
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data)); fs.renameSync(this.file + '.tmp', this.file); }
            catch (e) { console.warn(`[ai-player] failures: save failed (${e.message})`); }
        }, 2000);
    }
    weight(f, now = Date.now()) { return f.count * Math.pow(0.5, (now - f.last) / HALF_LIFE_MS); }
    decay() {
        const now = Date.now(), F = this.data.failures;
        this.data.failures = F.filter(f => now - f.last < MAX_AGE_MS && this.weight(f, now) >= 0.15);
        if (this.data.failures.length > MAX_ENTRIES) {
            this.data.failures.sort((a, b) => this.weight(b, now) - this.weight(a, now));
            this.data.failures.length = MAX_ENTRIES;
        }
    }
    record(cmd, target, pos, error) {
        try {
            const now = Date.now();
            const km = String(cmd || '').match(/^(![\w]+)\(\s*["']?([\w:]+)/); // a command key like !collectBlocks("coal_ore", 1)
            if (km && target === 'stuck') { cmd = km[1]; target = km[2]; error = `stuck: ${error}`; }
            const shown = String(cmd || '').split('(')[0].slice(0, 30);
            cmd = norm(cmd).split('(')[0];
            target = coarsenFailureTarget(cmd, target);
            const p = pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null;
            const key = `${cmd}|${target}|${cellOf(p)}`;
            let f = this.data.failures.find(x => x.key === key);
            if (f) { f.count++; f.last = now; f.shown = shown; f.error = String(error).slice(0, 120); f.recent = [...(f.recent || []).filter(t => now - t < BLOCK_WINDOW_MS), now]; if (p) Object.assign(f, p); }
            else { f = { key, cmd, shown, target, ...(p || {}), error: String(error).slice(0, 120), count: 1, first: now, last: now, recent: [now] }; this.data.failures.push(f); }
            console.log(`[ai-player] failure recorded: ${cmd} ${target} at ${p ? `${p.x} ${p.y} ${p.z}` : '-'}: ${f.error} (x${f.count})`);
            this.decay(); this.save();
            try {
                this.agent.self_prompter?.noteFailure?.(
                    cmd, target, error
                );
            } catch (_) { /* goal guard never affects gameplay */ }
            return f;
        } catch (e) { console.warn(`[ai-player] failures.record: ${e.message}`); return null; }
    }
    // a success clears the recent-failure window of that command+target nearby
    success(cmd, target, pos) {
        cmd = norm(cmd).split('(')[0]; target = coarsenFailureTarget(cmd, target);
        for (const f of this.data.failures) if (f.cmd === cmd && f.target === target && (!pos || f.x == null || Math.hypot(f.x - pos.x, f.z - pos.z) < BLOCK_RADIUS)) f.recent = [];
        this.save();
        try {
            this.agent.self_prompter?.noteSuccess?.(
                cmd, target
            );
        } catch (_) { /* goal guard never affects gameplay */ }
    }
    blocking(cmd, target, pos) {
        const now = Date.now();
        cmd = norm(cmd).split('(')[0]; target = coarsenFailureTarget(cmd, target);
        return this.data.failures.find(f => f.cmd === cmd && f.target === target &&
            (f.recent || []).filter(t => now - t < BLOCK_WINDOW_MS).length >= 2 &&
            (!pos || f.x == null || Math.hypot(f.x - pos.x, f.y - pos.y, f.z - pos.z) < BLOCK_RADIUS)) || null;
    }
    isBlocked(cmd, target, pos) { return !!this.blocking(cmd, target, pos); }

    // from command results (both model commands and their action output)
    observeCommand(message, result) {
        try {
            const m = String(message || '').match(/(![a-zA-Z]+)\(?\s*["']?([\w:]+)?/);
            if (!m) return;
            const cmd = m[1];
            let target = m[2] || '';
            const coords = String(message || '').match(/!goToCoordinates\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/i);
            if (coords)
                target = coordCellLabel(Number(coords[1]), Number(coords[2]), Number(coords[3]));
            const text = String(result ?? '');
            const pos = this.agent.bot?.entity?.position;
            if (!text || /interrupted|^undefined$/i.test(text)) return;
            // Guard refusals are instructions, not action failures. Do not
            // feed them into the failure blacklist or the goal circuit.
            if (isGuardBlockResult(text)) return;
            if (OK_RE.test(text) && !/collected 0/i.test(text)) { this.success(cmd, target, pos); return; }
            const fm = text.match(FAIL_RE);
            if (fm) {
                const line = text.split('\n').find(l => FAIL_RE.test(l)) || fm[0];
                this.record(cmd, target, pos, line.replace(/^Action output:\s*/i, '').trim());
            }
        } catch (e) { console.warn(`[ai-player] failures.observeCommand: ${e.message}`); }
    }
    // short prompt block: top relevant recent failures (nearby first), about 200 tokens max
    promptBlock() {
        try {
            this.decay();
            const now = Date.now(), me = this.agent.bot?.entity?.position;
            const rel = (f) => this.weight(f, now) * (me && f.x != null ? (Math.hypot(f.x - me.x, f.z - me.z) < 48 ? 2 : 0.5) : 1);
            const top = this.data.failures.slice().sort((a, b) => rel(b) - rel(a)).slice(0, 5).filter(f => rel(f) > 0.3);
            if (!top.length) return '';
            const ago = (t) => { const m = Math.round((now - t) / 60e3); return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
            let out = 'Recent failures (do not repeat them at the same place; choose something else):\n' +
                top.map(f => `- ${f.shown || f.cmd}${f.target ? ' ' + f.target : ''}${f.x != null ? ` at ${f.x} ${f.y} ${f.z}` : ''}: ${f.error.slice(0, 70)} (x${f.count}, ${ago(f.last)})`).join('\n');
            return out.slice(0, 800);
        } catch (e) { return ''; }
    }
}

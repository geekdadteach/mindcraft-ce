// Operator-run migration: backup, then retire obsolete hilltop home data.
// Does not run on bot start. Unrelated knowledge is kept.
import fs from 'fs';
import path from 'path';
import { LEGACY_HILLTOP, isLegacyHilltopPos } from './bob_home.js';

const HOME_PLACE_TYPES = new Set(['house', 'bed', 'house_entrance', 'home', 'door']);
// Require a hilltop-like x with nearby z (or a full x y z triple). Do not match 564-573 or
// 819-827 as standalone numbers elsewhere in lessons.
const HILLTOP_XYZ_RE = /\b-8(?:2[0-7]|19)\b.{0,24}\b12[34]\b.{0,24}\b(?:56[4-9]|57[0-3])\b/;
const HILLTOP_XZ_RE = /\b-8(?:2[0-7]|19)\b.{0,16}\b(?:56[4-9]|57[0-3])\b/;
const OLD_HOME_GOAL_RE = /(?:go(?:ing)?|walk|return|sleep|live).{0,40}(?:house|home|bed).{0,40}(?:-82[0-7]|-820|-823)|(?:-82[0-7].{0,20}12[34].{0,20}56[6-9])/;
const RESET_SPOT_RE = /-821 121 571|-822 123 561/;
const NIGHT_HOUSE_RE = /At night stay inside the house/i;
const HOMESTEAD_WORK_RE = /pick work near the homestead/i;

export function defaultTargets(botDir) {
    return {
        home_routes: path.join(botDir, 'home_routes.json'),
        places: path.join(botDir, 'places.json'),
        lessons: path.join(botDir, 'lessons.json'),
        memory: path.join(botDir, 'memory.json'),
        verified_home: path.join(botDir, 'verified_home.json'),
        homestead: path.join(botDir, 'homestead.json'),
    };
}

function readJson(file) {
    try {
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf8');
            return { data: JSON.parse(raw), raw };
        }
    } catch (e) {
        return { data: { _error: e.message }, raw: null };
    }
    return { data: null, raw: null };
}

function looksPretty(raw) {
    return typeof raw === 'string' && /\n\s+"/.test(raw);
}

function encodeJson(obj, pretty) {
    return pretty ? JSON.stringify(obj, null, 2) + '\n' : JSON.stringify(obj);
}

function isOldHomePlace(p) {
    if (!p) return false;
    const nearHilltop = isLegacyHilltopPos(p, 20);
    const type = String(p.type || p.name || '').toLowerCase();
    if (HOME_PLACE_TYPES.has(type) && (p.kind === 'fixed' || nearHilltop)) return true;
    if (nearHilltop && HOME_PLACE_TYPES.has(type)) return true;
    if (p.kind === 'fixed' && HOME_PLACE_TYPES.has(type)) return true;
    return false;
}

export function lessonMigration(l) {
    const key = String(l?.key || '');
    const text = String(l?.text || '');
    if (key === 'seed:home' || key === 'seed:house') return { op: 'retire', reason: key };
    if (NIGHT_HOUSE_RE.test(text)) {
        return {
            op: 'rewrite',
            reason: 'death lesson pointed at the old house',
            text: text.replace(/At night stay inside the house[^.]*\./gi,
                'At night sleep in your own verified bed if you have one, or make temporary cover. The retired hilltop is not your home.'),
        };
    }
    if (HOMESTEAD_WORK_RE.test(text)) {
        return {
            op: 'rewrite',
            reason: 'zone lesson pointed at the old homestead',
            text: text.replace(/pick work near the homestead[^.]*\./gi,
                'pick a reachable task outside protected zones. The claim is property, not a movement boundary.'),
        };
    }
    if (RESET_SPOT_RE.test(text) || (HILLTOP_XYZ_RE.test(text) && /reset:/.test(key))) {
        return {
            op: 'rewrite',
            reason: 'reset lesson pointed at the retired hilltop',
            text: text.replace(HILLTOP_XYZ_RE, 'a retired location').replace(RESET_SPOT_RE, 'a retired location')
                + (RESET_SPOT_RE.test(text) ? ' The retired hilltop is not your home.' : ''),
        };
    }
    if (/house_entrance|^home:|^house:/.test(key) && (HILLTOP_XYZ_RE.test(text) || HILLTOP_XZ_RE.test(text)))
        return { op: 'retire', reason: key };
    if (isLegacyHilltopPos({ x: l?.x, z: l?.z }, 20) && /house|bed|home/.test(key))
        return { op: 'retire', reason: key };
    return { op: 'keep' };
}

export function botLooksStopped({ botStopped = false, env = process.env } = {}) {
    if (botStopped === true || env.BOB_MIGRATE_BOT_STOPPED === '1') return { stopped: true, why: 'operator acknowledged bot is stopped' };
    return { stopped: false, why: 'pass --bot-stopped (or BOB_MIGRATE_BOT_STOPPED=1) after confirming MindServer/Bob is not running; he overwrites places.json and lessons.json from memory' };
}

export function planHomeMigration(botDir, { now = Date.now, botStopped = false, env = process.env } = {}) {
    const timestamp = typeof now === 'function' ? now() : (Number.isFinite(now) ? now : Date.now());
    const targets = defaultTargets(botDir);
    const actions = [];
    const keep = [];
    const warnings = [];
    const running = botLooksStopped({ botStopped, env });
    if (!running.stopped) warnings.push(running.why);

    const routes = readJson(targets.home_routes);
    if (routes.data && !routes.data._error) {
        const home = routes.data.home || LEGACY_HILLTOP.entrance;
        const old = isLegacyHilltopPos(home, 4) || routes.data.version === 1
            || (routes.data.routes || []).some((r) => (r.pts || []).some((pt) => isLegacyHilltopPos({ x: pt[0], z: pt[2] }, 20)));
        if (old) {
            actions.push({
                file: 'home_routes.json',
                op: 'retire',
                reason: 'routes lead to the retired hilltop',
                backup: true,
                pretty: looksPretty(routes.raw),
                write: { version: 2, home: null, retired: 'hilltop', routes: [] },
            });
        } else keep.push('home_routes.json (not hilltop; left unchanged)');
    }

    const places = readJson(targets.places);
    if (places.data && !places.data._error) {
        const list = places.data.places || [];
        const retired = list.filter(isOldHomePlace);
        const kept = list.filter((p) => !isOldHomePlace(p));
        if (retired.length) {
            actions.push({
                file: 'places.json',
                op: 'filter',
                reason: `retire ${retired.length} old-home place(s); keep ${kept.length}`,
                backup: true,
                pretty: looksPretty(places.raw),
                write: { ...places.data, places: kept },
                retired: retired.map((p) => ({ type: p.type, kind: p.kind, x: p.x, y: p.y, z: p.z })),
            });
        } else keep.push(`places.json (${list.length} unrelated places kept)`);
    }

    const lessons = readJson(targets.lessons);
    if (lessons.data && !lessons.data._error) {
        const list = lessons.data.lessons || [];
        const next = [];
        const retired = [];
        const rewritten = [];
        for (const l of list) {
            const act = lessonMigration(l);
            if (act.op === 'retire') retired.push(l.key);
            else if (act.op === 'rewrite') {
                next.push({ ...l, text: act.text });
                rewritten.push(l.key);
            } else next.push(l);
        }
        if (retired.length || rewritten.length) {
            actions.push({
                file: 'lessons.json',
                op: 'filter',
                reason: `retire ${retired.length} and rewrite ${rewritten.length} old-home lesson(s); keep ${next.length}`,
                backup: true,
                pretty: looksPretty(lessons.raw),
                write: { ...lessons.data, lessons: next },
                retired,
                rewritten,
            });
        } else keep.push(`lessons.json (${list.length} lessons kept)`);
    }

    const memory = readJson(targets.memory);
    if (memory.data && !memory.data._error) {
        const next = { ...memory.data };
        let changed = false;
        const notes = [];
        const prompt = String(memory.data.self_prompt || '');
        if (prompt && (OLD_HOME_GOAL_RE.test(prompt) || ((HILLTOP_XYZ_RE.test(prompt) || HILLTOP_XZ_RE.test(prompt)) && /house|home|bed/.test(prompt)))) {
            next.self_prompt = 'Survey your 128 by 128 claim, choose a safe supported site, and build your own home. Explore outside the claim where it is safe and permitted. The old hilltop is not your home.';
            notes.push('self_prompt mentioned the retired house; replaced with claim-first wording');
            changed = true;
        }
        const mem = String(memory.data.memory || '');
        if (mem && /your house (is|at)|live(?:s)? at .{0,20}-82[0-7]/i.test(mem)) {
            next.memory = mem.replace(/[^.]*(-82[0-7][^.]*12[34][^.]*56[4-9]|your house is at[^.]*-82[0-7])[^.]*\./gi, '').trim();
            notes.push('summarized memory no longer describes the retired house as current home');
            changed = true;
        }
        if (changed) {
            actions.push({
                file: 'memory.json',
                op: 'edit',
                reason: notes.join('; '),
                backup: true,
                pretty: looksPretty(memory.raw),
                write: next,
            });
        } else keep.push('memory.json (no old-home goal/summary to retire)');
    }

    const verified = readJson(targets.verified_home);
    if (verified.data && verified.data.verified && isLegacyHilltopPos(verified.data.door || verified.data.position, 12)) {
        actions.push({
            file: 'verified_home.json',
            op: 'clear',
            reason: 'saved verified home is the retired hilltop',
            backup: true,
            pretty: looksPretty(verified.raw),
            write: { version: 1, verified: false },
        });
    }

    return {
        botDir,
        timestamp,
        actions,
        keep,
        warnings,
        botStopped: running.stopped,
        dryRunDefault: true,
    };
}

export function applyHomeMigration(plan, { apply = false, fsApi = fs, botStopped = plan.botStopped } = {}) {
    const backupDir = path.join(plan.botDir, 'migrations', `home-${plan.timestamp}`);
    const report = { backupDir, applied: false, copies: [], writes: [], warnings: plan.warnings || [] };
    if (!apply) {
        report.applied = false;
        report.message = 'dry-run; no files written. Re-run with --apply --bot-stopped to backup and retire.';
        return report;
    }
    const running = botLooksStopped({ botStopped });
    if (!running.stopped) {
        report.message = `refused: ${running.why}`;
        return report;
    }
    fsApi.mkdirSync(backupDir, { recursive: true });
    for (const action of plan.actions) {
        const src = path.join(plan.botDir, action.file);
        if (action.backup && fsApi.existsSync(src)) {
            const dest = path.join(backupDir, action.file);
            fsApi.copyFileSync(src, dest);
            report.copies.push({ from: src, to: dest });
        }
        const dest = path.join(plan.botDir, action.file);
        fsApi.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = dest + '.tmp';
        fsApi.writeFileSync(tmp, encodeJson(action.write, action.pretty === true));
        fsApi.renameSync(tmp, dest);
        report.writes.push(action.file);
    }
    report.applied = true;
    report.message = `backed up ${report.copies.length} file(s) to ${backupDir}; retired ${report.writes.length} file(s)`;
    return report;
}

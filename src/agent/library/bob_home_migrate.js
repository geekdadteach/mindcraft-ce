// Operator-run migration: backup, then retire obsolete hilltop home data.
// Does not run on bot start. Unrelated knowledge is kept.
import fs from 'fs';
import path from 'path';
import { LEGACY_HILLTOP, isLegacyHilltopPos } from './bob_home.js';

const HOME_PLACE_TYPES = new Set(['house', 'bed', 'house_entrance', 'home', 'door']);
const OLD_COORD_RE = /\b-8(?:2[0-7]|19)\b|\b56[4-9]\b|\b57[0-3]\b/;
const OLD_HOME_GOAL_RE = /(?:go(?:ing)?|walk|return|sleep|live).{0,40}(?:house|home|bed).{0,40}(?:-82[0-7]|-820|-823)|(?:-82[0-7].{0,20}12[34].{0,20}56[6-9])/;

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
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return { _error: e.message };
    }
    return null;
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

function isOldHomeLesson(l) {
    const key = String(l?.key || '');
    const text = String(l?.text || '');
    if (key === 'seed:home' || key === 'seed:house') return true;
    if (/house_entrance|^home:|^house:/.test(key) && OLD_COORD_RE.test(text)) return true;
    if (isLegacyHilltopPos({ x: l?.x, z: l?.z }, 20) && /house|bed|home/.test(key)) return true;
    return false;
}

export function planHomeMigration(botDir, { now = Date.now } = {}) {
    const timestamp = typeof now === 'function' ? now() : (Number.isFinite(now) ? now : Date.now());
    const targets = defaultTargets(botDir);
    const actions = [];
    const keep = [];

    const routes = readJson(targets.home_routes);
    if (routes && !routes._error) {
        const home = routes.home || LEGACY_HILLTOP.entrance;
        const old = isLegacyHilltopPos(home, 4) || routes.version === 1
            || (routes.routes || []).some((r) => (r.pts || []).some((pt) => isLegacyHilltopPos({ x: pt[0], z: pt[2] }, 20)));
        if (old) {
            actions.push({
                file: 'home_routes.json',
                op: 'retire',
                reason: 'routes lead to the retired hilltop',
                backup: true,
                write: { version: 2, home: null, retired: 'hilltop', routes: [] },
            });
        } else keep.push('home_routes.json (not hilltop; left unchanged)');
    }

    const places = readJson(targets.places);
    if (places && !places._error) {
        const list = places.places || [];
        const retired = list.filter(isOldHomePlace);
        const kept = list.filter((p) => !isOldHomePlace(p));
        if (retired.length) {
            actions.push({
                file: 'places.json',
                op: 'filter',
                reason: `retire ${retired.length} old-home place(s); keep ${kept.length}`,
                backup: true,
                write: { ...places, places: kept },
                retired: retired.map((p) => ({ type: p.type, kind: p.kind, x: p.x, y: p.y, z: p.z })),
            });
        } else keep.push(`places.json (${list.length} unrelated places kept)`);
    }

    const lessons = readJson(targets.lessons);
    if (lessons && !lessons._error) {
        const list = lessons.lessons || [];
        const retired = list.filter(isOldHomeLesson);
        const kept = list.filter((l) => !isOldHomeLesson(l));
        if (retired.length) {
            actions.push({
                file: 'lessons.json',
                op: 'filter',
                reason: `retire ${retired.length} old-home lesson(s); keep ${kept.length}`,
                backup: true,
                write: { ...lessons, lessons: kept },
                retired: retired.map((l) => l.key),
            });
        } else keep.push(`lessons.json (${list.length} lessons kept)`);
    }

    const memory = readJson(targets.memory);
    if (memory && !memory._error) {
        const next = { ...memory };
        let changed = false;
        const notes = [];
        const prompt = String(memory.self_prompt || '');
        if (prompt && (OLD_HOME_GOAL_RE.test(prompt) || (OLD_COORD_RE.test(prompt) && /house|home|bed/.test(prompt)))) {
            next.self_prompt = 'Survey your 128 by 128 claim, choose a safe supported site, and build your own home. Explore outside the claim where it is safe and permitted. The old hilltop is not your home.';
            notes.push('self_prompt mentioned the retired house; replaced with claim-first wording');
            changed = true;
        }
        const mem = String(memory.memory || '');
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
                write: next,
            });
        } else keep.push('memory.json (no old-home goal/summary to retire)');
    }

    const verified = readJson(targets.verified_home);
    if (verified && verified.verified && isLegacyHilltopPos(verified.door || verified.position, 12)) {
        actions.push({
            file: 'verified_home.json',
            op: 'clear',
            reason: 'saved verified home is the retired hilltop',
            backup: true,
            write: { version: 1, verified: false },
        });
    }

    return {
        botDir,
        timestamp,
        actions,
        keep,
        dryRunDefault: true,
    };
}

export function applyHomeMigration(plan, { apply = false, fsApi = fs } = {}) {
    const backupDir = path.join(plan.botDir, 'migrations', `home-${plan.timestamp}`);
    const report = { backupDir, applied: false, copies: [], writes: [] };
    if (!apply) {
        report.applied = false;
        report.message = 'dry-run; no files written. Re-run with --apply to backup and retire.';
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
        fsApi.writeFileSync(tmp, JSON.stringify(action.write, null, 2) + '\n');
        fsApi.renameSync(tmp, dest);
        report.writes.push(action.file);
    }
    report.applied = true;
    report.message = `backed up ${report.copies.length} file(s) to ${backupDir}; retired ${report.writes.length} file(s)`;
    return report;
}

// Persistent homestead progression. Stages advance only when world state (or
// inventory) actually matches. This is a tracker plus on-demand work helpers,
// not a second goal controller: Andy still chooses when to build.
import fs from 'fs';
import path from 'path';
import { CLAIM, CLAIM_SURVEY, claimBounds, isInClaim, isKnownUnsafeFoundation } from './bob_claim.js';
import { discoverHomeFeatures, isLegacyHilltopPos, isVerifiedHome, verifyHomeInWorld } from './bob_home.js';

export const STAGES = Object.freeze([
    'survey', 'select_site', 'gather', 'foundation', 'shelter', 'bed', 'verified_home', 'improvements',
]);

export const STAGE_INDEX = Object.freeze(Object.fromEntries(STAGES.map((s, i) => [s, i])));

const LOG_RE = /_log$/;
const PLANK_RE = /_planks$/;
const DOOR_RE = /_door$/;
const BED_RE = /_bed$/;
const CHEST_RE = /^(chest|barrel)$/;
const FLOOR_RE = /planks|_log$|cobblestone|stone_bricks|deepslate|bricks/;
const WALL_RE = FLOOR_RE;

export function emptyProgress() {
    return {
        version: 1,
        stage: 'survey',
        site: null,
        observations: [],
        materials: {},
        history: [],
        verifiedHome: false,
        updatedAt: null,
    };
}

export function stageIndex(stage) {
    const i = STAGE_INDEX[stage];
    return Number.isInteger(i) ? i : 0;
}

export function homesteadFileFor(name) {
    return path.resolve(`bots/${name || 'MineBobNE'}/homestead.json`);
}

export function loadProgress(file) {
    try {
        if (file && fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (data && typeof data === 'object') return { ...emptyProgress(), ...data, version: 1 };
        }
    } catch (e) {
        console.warn(`[ai-player] homestead: load failed (${e.message})`);
    }
    return emptyProgress();
}

export function saveProgress(file, progress) {
    if (!file) return false;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(progress, null, 2) + '\n');
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        console.warn(`[ai-player] homestead: save failed (${e.message})`);
        return false;
    }
}

// Advisory only: higher is better. Never returns a forced coordinate.
export function scoreSite(pos, { survey = CLAIM_SURVEY, claim = CLAIM } = {}) {
    if (!pos || ![pos.x, pos.z].every(Number.isFinite)) return -Infinity;
    if (!isInClaim(pos, claim)) return -Infinity;
    if (isKnownUnsafeFoundation(pos)) return -Infinity;
    if (isLegacyHilltopPos(pos, 24)) return -Infinity;
    let score = 10;
    const area = survey.suggestedBuildArea;
    if (pos.x >= area.x1 && pos.x <= area.x2 && pos.z >= area.z1 && pos.z <= area.z2) score += 8;
    const dy = Number.isFinite(pos.y) ? Math.abs(pos.y - survey.approximateSurfaceY) : 8;
    score -= Math.min(12, dy);
    for (const cave of survey.caveOpenings) {
        const d = Math.hypot(pos.x - cave.x, pos.z - cave.z);
        if (d < 16) score -= (16 - d);
    }
    const outpost = survey.pillagerOutpost;
    const od = Math.hypot(pos.x - outpost.x, pos.z - outpost.z);
    if (od < 80) score -= (80 - od) / 4;
    // Prefer not standing on the claim center itself.
    if (Math.hypot(pos.x - claim.center.x, pos.z - claim.center.z) < 2) score -= 6;
    return score;
}

export function siteFacts(survey = CLAIM_SURVEY) {
    const b = claimBounds();
    return [
        `Plains around Y ${survey.approximateSurfaceY}.`,
        `Suggested building terrain X ${survey.suggestedBuildArea.x1}..${survey.suggestedBuildArea.x2} Z ${survey.suggestedBuildArea.z1}..${survey.suggestedBuildArea.z2} (verify support; this is not a house location).`,
        `Cavity hazard X ${survey.undergroundVoid.x1}..${survey.undergroundVoid.x2} Z ${survey.undergroundVoid.z1}..${survey.undergroundVoid.z2}.`,
        `Cave openings near (${survey.caveOpenings.map((p) => `${p.x},${p.z}`).join(') and (')}).`,
        `Pillager outpost near (${survey.pillagerOutpost.x},${survey.pillagerOutpost.z}); avoid until equipped.`,
        `Animals often to the northeast; fields and a pond toward the south.`,
        `The claim X ${b.x1}..${b.x2} Z ${b.z1}..${b.z2} is property, not a movement boundary.`,
    ];
}

export function countInventory(inventory = {}) {
    const n = (re) => Object.entries(inventory).reduce((s, [k, v]) => s + (re.test(k) ? Number(v) || 0 : 0), 0);
    return {
        logs: n(LOG_RE),
        planks: n(PLANK_RE),
        doors: n(DOOR_RE),
        beds: n(BED_RE),
        chests: n(CHEST_RE),
        wool: n(/wool$/),
        cobble: Number(inventory.cobblestone || 0),
        crafting_table: Number(inventory.crafting_table || 0),
    };
}

export function gatherReady(inventory = {}) {
    const c = countInventory(inventory);
    const wood = c.planks + c.logs * 4;
    return wood >= 32 && (c.doors >= 1 || wood >= 40) && (c.beds >= 1 || (c.wool >= 3 && wood >= 36)) && (c.chests >= 1 || wood >= 40);
}

function cellsAround(site, size = 5) {
    const x0 = Math.floor(site.x) - Math.floor(size / 2);
    const z0 = Math.floor(site.z) - Math.floor(size / 2);
    const y = Math.floor(site.y);
    const cells = [];
    for (let dx = 0; dx < size; dx++) for (let dz = 0; dz < size; dz++) cells.push({ x: x0 + dx, y, z: z0 + dz });
    return cells;
}

export function foundationPresent(getBlock, site, { size = 5 } = {}) {
    if (!site || typeof getBlock !== 'function') return false;
    const floorY = Math.floor(site.y) - 1;
    let hits = 0, need = size * size;
    for (const c of cellsAround({ ...site, y: floorY }, size)) {
        let b = null;
        try { b = getBlock(c.x, floorY, c.z); } catch (_) {}
        if (FLOOR_RE.test(String(b?.name || ''))) hits++;
    }
    return hits >= Math.ceil(need * 0.6);
}

export function shelterPresent(getBlock, site, { size = 5 } = {}) {
    if (!site || typeof getBlock !== 'function') return false;
    const y = Math.floor(site.y);
    const cells = cellsAround(site, size);
    const xs = cells.map((c) => c.x), zs = cells.map((c) => c.z);
    const x1 = Math.min(...xs), x2 = Math.max(...xs), z1 = Math.min(...zs), z2 = Math.max(...zs);
    let walls = 0, wallNeed = 0, roof = 0, roofNeed = 0;
    for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
        const edge = x === x1 || x === x2 || z === z1 || z === z2;
        if (edge) {
            wallNeed += 2;
            for (const dy of [0, 1]) {
                let b = null;
                try { b = getBlock(x, y + dy, z); } catch (_) {}
                const n = String(b?.name || '');
                if (WALL_RE.test(n) || DOOR_RE.test(n)) walls++;
            }
        }
        roofNeed++;
        let r = null;
        try { r = getBlock(x, y + 2, z); } catch (_) {}
        if (FLOOR_RE.test(String(r?.name || '')) || /stairs|slab/.test(String(r?.name || ''))) roof++;
    }
    return walls >= Math.ceil(wallNeed * 0.5) && roof >= Math.ceil(roofNeed * 0.5);
}

export function bedPresent(getBlock, site, { radius = 6 } = {}) {
    if (!site || typeof getBlock !== 'function') return false;
    const o = { x: Math.floor(site.x), y: Math.floor(site.y), z: Math.floor(site.z) };
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -radius; dz <= radius; dz++) {
        let b = null;
        try { b = getBlock(o.x + dx, o.y + dy, o.z + dz); } catch (_) { continue; }
        if (BED_RE.test(String(b?.name || ''))) return { x: o.x + dx, y: o.y + dy, z: o.z + dz, name: b.name };
    }
    return false;
}

export function evaluateWorld(ctx) {
    const { getBlock, inventory = {}, position = null, progress = emptyProgress(), home = null } = ctx;
    const site = progress.site;
    const visitedClaim = !!(progress.visitedClaim || (position && isInClaim(position)) || (progress.observations || []).length);
    const siteOk = !!(site && isInClaim(site) && !isKnownUnsafeFoundation(site) && scoreSite(site) > 0);
    const gathered = gatherReady(inventory);
    const foundation = siteOk && foundationPresent(getBlock, site);
    const shelter = foundation && shelterPresent(getBlock, site);
    const bed = !!(shelter && bedPresent(getBlock, site));
    let verified = isVerifiedHome(home);
    if (!verified && getBlock && (site || position)) {
        const features = discoverHomeFeatures(getBlock, site || position, { radius: 12 });
        if (features && verifyHomeInWorld(getBlock, features).ok) verified = true;
    }
    return { visitedClaim, siteOk, gathered, foundation, shelter, bed, verified };
}

export function nextStageFromWorld(evidence, progress = emptyProgress()) {
    if (evidence.verified) return 'verified_home';
    if (evidence.bed) return 'bed';
    if (evidence.shelter) return 'shelter';
    if (evidence.foundation) return 'foundation';
    if (evidence.gathered && evidence.siteOk) return 'gather';
    if (evidence.siteOk) return 'select_site';
    if (evidence.visitedClaim) return 'select_site';
    return progress.stage || 'survey';
}

// Advance at most to the highest stage the world actually supports. Never skip evidence.
export function applyObservation(progress, evidence, extra = {}) {
    const cur = emptyProgress();
    Object.assign(cur, progress);
    const reached = nextStageFromWorld(evidence, cur);
    const reachedI = stageIndex(reached);
    const curI = stageIndex(cur.stage);
    // World evidence can skip forward (Bob built more than the tracker knew).
    // It never moves backward past a recorded verified home.
    let stage = cur.stage;
    if (reachedI > curI) stage = reached;
    if (evidence.verified) stage = cur.stage === 'improvements' ? 'improvements' : 'verified_home';
    if (extra.site && !cur.site) cur.site = extra.site;
    if (extra.observation) cur.observations = [...(cur.observations || []), extra.observation].slice(-24);
    if (evidence.visitedClaim) cur.visitedClaim = true;
    if (evidence.verified) cur.verifiedHome = true;
    if (stage !== cur.stage) cur.history = [...(cur.history || []), { from: cur.stage, to: stage, at: extra.now || Date.now() }].slice(-20);
    cur.stage = stage === 'verified_home' && extra.improvements ? 'improvements' : stage;
    cur.updatedAt = extra.now || Date.now();
    cur.materials = extra.materials || cur.materials;
    return cur;
}

export function recordSiteChoice(progress, pos) {
    if (!pos || scoreSite(pos) <= 0) return { ok: false, why: 'site is not a safe supported location on the claim', progress };
    const next = { ...progress, site: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, visitedClaim: true };
    if (stageIndex(next.stage) < STAGE_INDEX.select_site) next.stage = 'select_site';
    next.updatedAt = Date.now();
    return { ok: true, why: 'ok', progress: next };
}

export function statusText(progress, home = null) {
    const facts = siteFacts();
    const lines = [];
    if (isVerifiedHome(home)) {
        const e = home.entrance;
        lines.push(`Verified home entrance is ${e.x.toFixed(1)} ${e.y} ${e.z.toFixed(1)} (discovered in the world, not assigned).`);
        if (home.bed) lines.push(`Verified bed at ${home.bed.x} ${home.bed.y} ${home.bed.z}.`);
        if (home.storage) lines.push(`Verified storage at ${home.storage.x} ${home.storage.y} ${home.storage.z}.`);
    } else {
        lines.push('No house has been built and verified yet. No door, bed, or spawn has been discovered.');
        lines.push(`Current homestead stage: ${progress?.stage || 'survey'}.`);
        if (progress?.site) lines.push(`A site you chose is recorded at ${progress.site.x} ${progress.site.y} ${progress.site.z}; it is not a finished home.`);
    }
    lines.push(...facts);
    return lines.join(' ');
}

export function explorationAllowed(pos) {
    // The claim is property, never a fence. Any finite overworld position is allowed.
    return !!(pos && Number.isFinite(pos.x) && Number.isFinite(pos.z));
}

export class HomesteadTracker {
    constructor(agent, { file, now = Date.now } = {}) {
        this.agent = agent;
        this.file = file || homesteadFileFor(agent?.name);
        this.now = now;
        this.progress = loadProgress(this.file);
    }
    snapshot() { return this.progress; }
    save() { return saveProgress(this.file, this.progress); }
    statusText() { return statusText(this.progress, this.agent?.homeState?.snapshot?.() || null); }
    chooseSite(pos) {
        const r = recordSiteChoice(this.progress, pos);
        if (r.ok) { this.progress = r.progress; this.save(); }
        return r;
    }
    observe({ getBlock, inventory, position, home } = {}) {
        const evidence = evaluateWorld({
            getBlock: getBlock || ((x, y, z) => this.agent?.bot?.blockAt?.({ x, y, z, offset() { return this; } })),
            inventory, position, progress: this.progress, home,
        });
        const next = applyObservation(this.progress, evidence, {
            now: this.now(),
            materials: countInventory(inventory || {}),
        });
        this.progress = next;
        this.save();
        return next;
    }
}

// Deterministic one-step work used when Andy (or a test) asks to continue.
// Site selection scores nearby standable cells; it never teleports to a hardcoded house.
export function pickSiteFromSamples(samples) {
    let best = null, bestScore = -Infinity;
    for (const p of samples || []) {
        const s = scoreSite(p);
        if (s > bestScore) { bestScore = s; best = p; }
    }
    if (!best || bestScore <= 0) return null;
    return { x: Math.floor(best.x), y: Math.floor(best.y), z: Math.floor(best.z) };
}

export function starterPlan(site) {
    if (!site) return [];
    const y = Math.floor(site.y);
    const cells = cellsAround(site, 5);
    const xs = cells.map((c) => c.x), zs = cells.map((c) => c.z);
    const x1 = Math.min(...xs), x2 = Math.max(...xs), z1 = Math.min(...zs), z2 = Math.max(...zs);
    const doorX = Math.floor((x1 + x2) / 2);
    const placements = [];
    for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
        placements.push({ x, y: y - 1, z, name: 'oak_planks', kind: 'foundation' });
        const edge = x === x1 || x === x2 || z === z1 || z === z2;
        const isDoor = x === doorX && z === z1;
        if (edge) {
            if (isDoor) placements.push({ x, y, z, name: 'oak_door', kind: 'door' });
            else {
                placements.push({ x, y, z, name: 'oak_planks', kind: 'wall' });
                placements.push({ x, y: y + 1, z, name: 'oak_planks', kind: 'wall' });
            }
        }
        placements.push({ x, y: y + 2, z, name: 'oak_planks', kind: 'roof' });
    }
    placements.push({ x: doorX, y, z: z1 + 2, name: 'white_bed', kind: 'bed' });
    placements.push({ x: doorX + 1, y, z: z1 + 2, name: 'chest', kind: 'storage' });
    return placements;
}

export function applyPlacements(world, placements) {
    const next = { ...world };
    for (const p of placements || []) next[`${p.x},${p.y},${p.z}`] = { name: p.name };
    return next;
}

export function worldGetBlock(world) {
    return (x, y, z) => world[`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`] || { name: 'air', boundingBox: 'empty' };
}

export function continueHomesteadStep(progress, ctx = {}) {
    const { position = null, inventory = {}, getBlock = null, home = null, samples = null } = ctx;
    let cur = { ...emptyProgress(), ...progress };
    const evidence = evaluateWorld({ getBlock, inventory, position, progress: cur, home });
    cur = applyObservation(cur, evidence, { now: Date.now(), materials: countInventory(inventory) });

    if (position && isInClaim(position) && !cur.visitedClaim) {
        cur = applyObservation(cur, { ...evidence, visitedClaim: true }, {
            now: Date.now(),
            observation: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
        });
        if (!cur.site && scoreSite(position) > 0) {
            const r = recordSiteChoice(cur, position);
            if (r.ok) cur = r.progress;
        }
        return { progress: cur, placements: [], message: cur.site
            ? `You are on your claim. Recorded this standing position as a site at ${cur.site.x} ${cur.site.y} ${cur.site.z}.`
            : 'You are on your claim. Look around; nothing here is a pre-assigned house.' };
    }

    if (!cur.site) {
        const picked = position && scoreSite(position) > 0 ? { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
            : pickSiteFromSamples(samples);
        if (picked) {
            const r = recordSiteChoice(cur, picked);
            if (r.ok) return { progress: r.progress, site: r.progress.site, placements: [], message: `Recorded the site you are using at ${r.progress.site.x} ${r.progress.site.y} ${r.progress.site.z}. It is your choice, not an assigned house.` };
        }
        return { progress: cur, placements: [], message: 'No safe supported site is recorded yet. Stand on flat claim ground away from the cavity and caves.' };
    }

    if (!gatherReady(inventory) && stageIndex(cur.stage) <= STAGE_INDEX.gather) {
        const c = countInventory(inventory);
        return { progress: cur, placements: [], message: `Gather more building supplies (wood ${c.planks + c.logs * 4}/32, door ${c.doors}, bed ${c.beds}, chest ${c.chests}).` };
    }

    const features = getBlock && discoverHomeFeatures(getBlock, cur.site, { radius: 12 });
    const verified = features && verifyHomeInWorld(getBlock, features);
    if (verified?.ok) {
        cur.stage = 'verified_home';
        cur.verifiedHome = true;
        return { progress: cur, homeFeatures: { ...features, verified: true }, placements: [], message: 'Home features were found in the world and verified.' };
    }

    const plan = starterPlan(cur.site);
    const missing = plan.filter((pl) => {
        if (!getBlock) return true;
        const b = getBlock(pl.x, pl.y, pl.z);
        const n = String(b?.name || 'air');
        if (pl.kind === 'door') return !/_door$/.test(n);
        if (pl.kind === 'bed') return !/_bed$/.test(n);
        if (pl.kind === 'storage') return !/chest|barrel/.test(n);
        return n !== pl.name;
    });
    const want = cur.stage === 'shelter' ? ['wall', 'door', 'roof']
        : cur.stage === 'bed' || cur.stage === 'verified_home' ? ['bed', 'storage', 'door']
        : ['foundation'];
    const batch = missing.filter((pl) => want.includes(pl.kind)).slice(0, 12);
    const fallback = batch.length ? batch : missing.slice(0, 8);
    return {
        progress: cur,
        placements: fallback,
        message: fallback.length
            ? `Placing ${fallback.length} starter-shelter block(s) at your chosen site.`
            : statusText(cur, home),
    };
}

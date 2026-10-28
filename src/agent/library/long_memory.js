import { CLAIM } from './bob_claim.js';
// [ai-player] Long-term memory for Bob: LESSONS (Reflexion-style, rule-derived), PLACES (observed resources),
// and a Voyager-style SAVED SKILLS library (verified generated code, embedded description, top-k retrieval).
// Retrieval scoring follows generative agents (relevance + recency + importance). Everything is best-effort:
// any failure (embedding, disk, world access) degrades to keyword matching or no-op, never a crash.
import fs from 'fs';
import path from 'path';
import { cosineSimilarity } from '../../utils/math.js';
import { zoneAt } from './no_go_zones.js';

const HOUR = 3600e3;
const now = () => Date.now();
const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9_ ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
function keywordScore(query, text) {
    const q = new Set(words(query)); if (q.size === 0) return 0;
    const t = words(text); let hit = 0;
    for (const w of new Set(t)) if (q.has(w) || [...q].some(x => x.length > 4 && (w.includes(x) || x.includes(w)))) hit++;
    return hit / Math.sqrt(q.size * Math.max(1, new Set(t).size));
}

class JsonStore {
    constructor(file, fallback) {
        this.file = file; this.data = fallback; this._timer = null; this._lastBak = 0;
        try {
            if (fs.existsSync(file)) {
                this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
                fs.copyFileSync(file, file + '.bak'); this._lastBak = now();
            }
        } catch (e) {
            console.warn(`[ai-player] long-memory: could not load ${path.basename(file)} (${e.message}); trying .bak`);
            try { this.data = JSON.parse(fs.readFileSync(file + '.bak', 'utf8')); } catch (_) { this.data = fallback; }
        }
    }
    save() {
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            try {
                if (now() - this._lastBak > HOUR && fs.existsSync(this.file)) { fs.copyFileSync(this.file, this.file + '.bak'); this._lastBak = now(); }
                fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
                fs.renameSync(this.file + '.tmp', this.file);
            } catch (e) { console.warn(`[ai-player] long-memory: save ${path.basename(this.file)} failed: ${e.message}`); }
        }, 2000);
    }
}

// ---------- lesson rules: deterministic, from command results (no LLM call) ----------
const LESSON_RULES = [
    [/Don't have right tools to harvest (\w+)/i, m => [`tool:${m[1]}`, `Mining ${m[1]} needs a pickaxe in your inventory (wooden_pickaxe for stone/coal_ore, stone_pickaxe for iron_ore). Craft one first.`, 'fail']],
    [/Cannot smelt (\w+)/i, m => [`smelt:${m[1]}`, `Smelt raw items (raw_iron, raw_gold, raw_copper, sand, logs), not ore blocks like ${m[1]}. Mining coal_ore already gives coal.`, 'fail']],
    [/Invalid (?:block|item|block or item) type: (\w+)/i, m => [`name:${m[1]}`, `"${m[1]}" is not a valid name; use exact ids such as oak_log, spruce_log, dark_oak_log, cobblestone, coal.`, 'fail']],
    [/Took to long to decide path|No path to the goal/i, () => ['path:timeout', 'Long paths time out (often from inside caves). Go up or toward the target in shorter steps, and fetch surface things like trees from the surface.', 'fail']],
    [/Recipe requires craftingTable/i, () => ['craft:table', 'That recipe needs a crafting_table within reach: stand next to one or place one (!placeHere("crafting_table")) first.', 'fail']],
    [/No-go zone/i, () => ['zone', 'Targets near the market, world spawn or the racetrack are refused; choose another safe reachable destination outside all protected zones.', 'fail']],
    [/Collected 0 (\w+)/i, m => [`collect0:${m[1]}`, `!collectBlocks("${m[1]}") can find none reachable; use !searchForBlock("${m[1]}", 64) or move to where it was seen first.`, 'fail']],
    [/Successfully crafted (\w+)/i, m => [`crafted:${m[1]}`, `Crafting ${m[1]} works when you have the ingredients (check with !getCraftingPlan).`, 'success']],
    [/Collected ([1-9]\d*) (\w+)/i, m => [`collected:${m[2]}`, `!collectBlocks("${m[2]}") works; ${m[2]} was available here.`, 'success']],
];
const SEED_LESSONS = [
    ['seed:pickaxe', 'Mining stone or coal_ore needs a pickaxe; with none, craft a wooden_pickaxe (3 planks + 2 sticks at a crafting_table) first.'],
    ['seed:smelt', 'Smelt raw items (raw_iron, raw_gold), not ore blocks; coal_ore drops coal directly when mined.'],
    ['seed:lognames', 'Log names are specific: oak_log, spruce_log, dark_oak_log, birch_log (never just "log").'],
    ['seed:trees', 'Trees grow on the surface, not in caves; to get logs, go up to the surface first.'],
    ['seed:claim', `Your property is a 128 by 128 claim centered at X ${CLAIM.center.x}, Z ${CLAIM.center.z}. Build your own home after surveying the ground. The claim center is not a house or bed.`],
];

// ---------- place observation ----------
const PLACE_BLOCKS = ['oak_log', 'spruce_log', 'birch_log', 'dark_oak_log', 'jungle_log', 'acacia_log', 'mangrove_log', 'cherry_log',
    'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'gold_ore', 'deepslate_gold_ore',
    'water', 'wheat', 'carrots', 'potatoes', 'sugar_cane', 'pumpkin', 'melon', 'sweet_berry_bush'];
const PLACE_MOBS = ['cow', 'sheep', 'pig', 'chicken', 'rabbit'];
const ALIAS = { deepslate_coal_ore: 'coal_ore', deepslate_iron_ore: 'iron_ore', deepslate_gold_ore: 'gold_ore' };
// [ai-player] Ore remembered far below Bob near the house kept pulling him back into the tunnels under it (Oct 20).
const DEEP_ORE_DY = 12, DEEP_ORE_HOUSE_R = 40;
const deepOre = (p, me) => p.kind === 'block' && /_ore$/.test(p.type) && p.y < me.y - DEEP_ORE_DY && Math.hypot(p.x - CLAIM.center.x, p.z - CLAIM.center.z) < DEEP_ORE_HOUSE_R;
const MERGE_DIST = 12, MAX_PLACES = 200, MOB_TTL = 30 * 60e3, BLOCK_TTL = 3 * 24 * HOUR;

export class LongMemory {
    constructor(agent) {
        this.agent = agent;
        const dir = `./bots/${agent.name}`;
        fs.mkdirSync(`${dir}/learned_skills`, { recursive: true });
        this.dir = dir;
        this.lessons = new JsonStore(`${dir}/lessons.json`, { version: 1, lessons: [] });
        this.places = new JsonStore(`${dir}/places.json`, { version: 1, places: [] });
        this.skills = new JsonStore(`${dir}/skills.json`, { version: 1, skills: [] });
        this._embedFails = 0; this._embedOffUntil = 0;
        this.stats = { lessons_added: 0, lessons_bumped: 0, places_added: 0, places_expired: 0, skills_saved: 0 };
        for (const [key, text] of SEED_LESSONS) this._addLesson(key, text, 'seed', false);
        // Retire the abandoned hilltop as a home; preserve all unrelated discoveries.
        const obsolete = new Set(['house', 'bed', 'house_entrance']);
        this.places.data.places = this.places.data.places.filter(p => !obsolete.has(p.type) || p.kind !== 'fixed');
        this.lessons.data.lessons = this.lessons.data.lessons.filter(l => l.key !== 'seed:home');
        this.lessons.save(); this.places.save();
        this._backfill();
    }

    // ---------- embeddings (never throws) ----------
    async embed(text) {
        const model = this.agent.prompter?.embedding_model;
        if (!model?.embed || now() < this._embedOffUntil) return null;
        try {
            const v = await Promise.race([model.embed(String(text).slice(0, 2000)), new Promise((_, r) => setTimeout(() => r(new Error('embed timeout')), 3000))]);
            if (!Array.isArray(v) || v.length === 0) throw new Error('empty embedding');
            this._embedFails = 0; return v;
        } catch (e) {
            if (++this._embedFails >= 3) { this._embedOffUntil = now() + 5 * 60e3; this._embedFails = 0; }
            console.warn(`[ai-player] long-memory: embed failed (${e.message}); keyword fallback`);
            return null;
        }
    }
    async _backfill() {
        for (const l of this.lessons.data.lessons) if (!l.emb) l.emb = await this.embed(l.text);
        for (const s of this.skills.data.skills) if (!s.emb) s.emb = await this.embed(s.description);
        this.lessons.save(); this.skills.save();
    }
    _rel(qv, query, item, text) { return (qv && item.emb && item.emb.length === qv.length) ? cosineSimilarity(qv, item.emb) : keywordScore(query, text); }

    // ---------- LESSONS ----------
    _addLesson(key, text, kind, embed = true) {
        const L = this.lessons.data.lessons;
        let l = L.find(x => x.key === key);
        if (l) { l.count++; l.last = now(); l.text = text; this.stats.lessons_bumped++; }
        else {
            l = { key, text, kind, count: 1, first: now(), last: now(), emb: null }; L.push(l); this.stats.lessons_added++;
            console.log(`[ai-player] lesson learned: ${text}`);
            if (embed) this.embed(text).then(v => { l.emb = v; this.lessons.save(); });
            if (L.length > 150) { L.sort((a, b) => (b.kind === 'seed') - (a.kind === 'seed') || b.last - a.last); L.length = 150; }
        }
        this.lessons.save();
        return l;
    }
    observeCommand(command, result) {
        try {
            const text = String(result ?? '');
            for (const [re, fn] of LESSON_RULES) {
                const m = text.match(re);
                if (m) { const [key, lesson, kind] = fn(m); this._addLesson(key, lesson, kind); }
            }
            const cm = String(command || '').match(/!collectBlocks\(\s*["']?(\w+)/);
            if (cm && /Collected 0|Failed to collect/i.test(text)) this._checkGone(cm[1]);
        } catch (e) { console.warn(`[ai-player] long-memory observeCommand: ${e.message}`); }
    }
    observeDeath(message) {
        try {
            const cause = String(message).replace(this.agent.name, '').trim().replace(/\s+/g, ' ').slice(0, 80);
            const night = (this.agent.bot?.time?.timeOfDay ?? 0) > 13000;
            this._addLesson(`death:${cause.split(' ').slice(0, 3).join('_')}`, `You died (${cause})${night ? ' at night' : ''}. ${night ? 'At night stay inside the house or sleep (!goToBed).' : 'Keep health up, eat, and fight with a sword or retreat.'}`, 'fail');
        } catch (_) {}
    }
    _lessonScore(l, rel) {
        const recency = Math.pow(0.99, (now() - l.last) / HOUR);
        const importance = l.kind === 'seed' ? 0.6 : Math.min(1, (l.kind === 'fail' ? 0.4 : 0.15) + Math.log10(l.count + 1) / 2);
        return rel + 0.25 * recency + 0.25 * importance;
    }

    // ---------- PLACES ----------
    observe() {
        const bot = this.agent.bot;
        try {
            if (!bot?.entity?.position || !bot.registry) return;
            const me = bot.entity.position;
            const ids = PLACE_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined);
            const found = bot.findBlocks({ matching: ids, maxDistance: 24, count: 120 });
            const seenTypes = new Map();
            for (const pos of found) {
                const b = bot.blockAt(pos); if (!b) continue;
                const type = ALIAS[b.name] || b.name;
                if (type === 'water' && (seenTypes.get('water') || 0) > 0) continue;
                seenTypes.set(type, (seenTypes.get(type) || 0) + 1);
                this._record(type, pos.x, pos.y, pos.z, 'block');
            }
            for (const e of Object.values(bot.entities || {})) {
                if (!e?.position || !PLACE_MOBS.includes(e.name) || e.position.distanceTo(me) > 24) continue;
                this._record(e.name, Math.round(e.position.x), Math.round(e.position.y), Math.round(e.position.z), 'mob');
            }
            // expire resources that should be visible from here but are gone
            const P = this.places.data.places, before = P.length;
            this.places.data.places = P.filter(p => {
                if (p.kind === 'fixed') return true;
                const age = now() - p.last;
                if (p.kind === 'mob') return age < MOB_TTL;
                if (age > BLOCK_TTL) return false;
                const d = Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z);
                if (d < 8 && age > 60e3 && !found.some(f => Math.hypot(f.x - p.x, f.y - p.y, f.z - p.z) < MERGE_DIST && (ALIAS[bot.blockAt(f)?.name] || bot.blockAt(f)?.name) === p.type)) return false;
                return true;
            });
            if (this.places.data.places.length !== before) { this.stats.places_expired += before - this.places.data.places.length; }
            this.places.save();
        } catch (e) { console.warn(`[ai-player] long-memory observe: ${e.message}`); }
    }
    _record(type, x, y, z, kind) {
        if (zoneAt(x, z)) return; // never remember targets inside no-go zones
        const P = this.places.data.places;
        const p = P.find(p => p.type === type && Math.hypot(p.x - x, p.y - y, p.z - z) < MERGE_DIST);
        if (p) { p.last = now(); p.seen++; if (kind === 'mob') { p.x = x; p.y = y; p.z = z; } return; }
        P.push({ type, x, y, z, kind, first: now(), last: now(), seen: 1 }); this.stats.places_added++;
        if (P.length > MAX_PLACES) { P.sort((a, b) => (b.kind === 'fixed') - (a.kind === 'fixed') || b.last - a.last); P.length = MAX_PLACES; }
    }
    _checkGone(type) {
        const me = this.agent.bot?.entity?.position; if (!me) return;
        const t = ALIAS[type] || type;
        const P = this.places.data.places, n = P.length;
        this.places.data.places = P.filter(p => !(p.type === t && p.kind === 'block' && Math.hypot(p.x - me.x, p.z - me.z) < 32 && now() - p.last > 120e3));
        if (n !== this.places.data.places.length) { this.stats.places_expired += n - this.places.data.places.length; this.places.save(); }
    }
    nearestPlace(name) {
        const me = this.agent.bot?.entity?.position; if (!me) return null;
        const n = String(name || '').toLowerCase().replace(/^minecraft:/, '');
        const cands = this.places.data.places.filter(p => p.type === n || p.type === ALIAS[n] || p.type === `${n}_log` || p.type === `${n}_ore` || (n === 'log' && p.type.endsWith('_log')) || (n.endsWith('s') && p.type === n.slice(0, -1)));
        const cost = (p) => Math.hypot(p.x - me.x, p.z - me.z) + (deepOre(p, me) ? 1000 : 0); // [ai-player] deep ore near the house last
        cands.sort((a, b) => cost(a) - cost(b));
        return cands[0] || null;
    }
    placeTypes() { return [...new Set(this.places.data.places.map(p => p.type))].join(', '); }

    // ---------- prompt section for the conversing prompt ----------
    async promptBlock(messages) {
        const t0 = now();
        try {
            const recent = (messages || []).slice(-4).map(m => m.content).join('\n');
            const goal = this.agent.self_prompter?.prompt || '';
            const query = (recent.slice(-1200) + '\n' + goal.slice(0, 300)).trim();
            const qv = await this.embed(query);
            const ranked = this.lessons.data.lessons
                .map(l => ({ l, s: this._lessonScore(l, this._rel(qv, query, l, l.text)) }))
                .sort((a, b) => b.s - a.s);
            const lessons = [];
            for (const { l } of ranked) { // drop near-duplicates (MMR-style) so 5 slots carry 5 different lessons
                if (lessons.length >= 5) break;
                const dup = lessons.some(o => (l.emb && o.emb && l.emb.length === o.emb.length) ? cosineSimilarity(l.emb, o.emb) > 0.85 : keywordScore(o.text, l.text) > 0.6);
                if (!dup) lessons.push(l);
            }
            let out = '';
            if (lessons.length) out += 'Lessons learned (from your own experience):\n' + lessons.map(l => `- ${l.text}${l.count > 1 ? ` (x${l.count})` : ''}`).join('\n');
            const me = this.agent.bot?.entity?.position;
            if (me) {
                const best = new Map();
                for (const p of this.places.data.places) {
                    if (p.kind === 'fixed' || deepOre(p, me)) continue; // [ai-player] don't advertise ore deep under the house
                    const d = Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z);
                    if (!best.has(p.type) || d < best.get(p.type).d) best.set(p.type, { p, d });
                }
                const ranked = [...best.values()].map(v => ({ ...v, s: keywordScore(query, v.p.type.replace(/_/g, ' ')) * 50 - v.d / 10 }))
                    .sort((a, b) => b.s - a.s).slice(0, 6).sort((a, b) => a.d - b.d);
                const list = ranked.map(({ p, d }) => `${p.type} ${p.x} ${p.y} ${p.z} (${Math.round(d)}m)`);
                out += `\nKnown places: ${list.join('; ') || 'none yet'}. !goToRememberedPlace("<type>") goes to the nearest one.`;
            }
            const ms = now() - t0;
            if ((this._blockLogs = (this._blockLogs || 0) + 1) % 5 === 1) console.log(`[ai-player] long-memory block chars=${out.length} lessons=${lessons.length} embed=${qv ? 'ok' : 'keyword'} ms=${ms}`);
            return out.trim();
        } catch (e) { console.warn(`[ai-player] long-memory promptBlock: ${e.message}`); return ''; }
    }

    // ---------- SAVED SKILLS (Voyager) ----------
    static taskFromHistory(messages) {
        const m = (messages || []).slice().reverse().find(msg => msg.role !== 'system' && String(msg.content).includes('!newAction('));
        return m?.content?.match(/!newAction\((.*?)\)/s)?.[1]?.replace(/^["']|["']$/g, '').trim() || '';
    }
    static skillName(desc) {
        const w = words(desc).filter(x => !['the', 'and', 'then', 'with', 'for', 'some', 'from', 'into', 'that', 'this', 'your', 'you'].includes(x)).slice(0, 5);
        return (w.map((x, i) => i ? x[0].toUpperCase() + x.slice(1) : x).join('').replace(/[^A-Za-z0-9]/g, '') || 'skill').slice(0, 40);
    }
    // Deterministic critic (Voyager uses a GPT-4 critic; we cannot afford an extra LM call per task).
    verify(before, after, output) {
        if (/error|fail|could not|couldn't|cannot|can't|don't have|no \w+ (found|nearby)|interrupted|not enough|invalid|timed out|took to long/i.test(output)) return { ok: false, why: 'output reports a failure' };
        const keys = new Set([...Object.keys(before.inv), ...Object.keys(after.inv)]);
        const delta = [...keys].map(k => [k, (after.inv[k] || 0) - (before.inv[k] || 0)]).filter(([, d]) => d !== 0);
        const moved = before.pos && after.pos ? before.pos.distanceTo(after.pos) : 0;
        if (delta.length === 0 && moved < 3) return { ok: false, why: 'no inventory or position change' };
        return { ok: true, why: delta.length ? delta.slice(0, 6).map(([k, d]) => `${d > 0 ? '+' : ''}${d} ${k}`).join(', ') : `moved ${Math.round(moved)} blocks` };
    }
    async saveSkill(description, code, outcome) {
        try {
            if (!description || !code || code.length > 6000) return null;
            const S = this.skills.data.skills;
            const emb = await this.embed(description);
            let name = LongMemory.skillName(description);
            let s = S.find(x => x.name === name) || (emb && S.find(x => x.emb && x.emb.length === emb.length && cosineSimilarity(emb, x.emb) > 0.92));
            if (s) {
                if (s.code === code) { s.updated = now(); s.verified++; this.skills.save(); return s; }
                s.prev_code = s.code; s.code = code; s.version++; s.updated = now(); s.verified++; s.outcome = outcome; s.description = description; if (emb) s.emb = emb;
            } else {
                s = { name, description, code, version: 1, created: now(), updated: now(), verified: 1, uses: 0, outcome, emb };
                S.push(s);
                if (S.length > 60) { S.sort((a, b) => (b.uses + b.verified) - (a.uses + a.verified) || b.updated - a.updated); S.length = 60; }
            }
            fs.writeFileSync(`${this.dir}/learned_skills/${s.name}.js`, `// ${s.description}\n// v${s.version}, verified: ${outcome}\nasync function ${s.name}(bot) {\n${s.code}\n}\n`);
            this.stats.skills_saved++; this.skills.save();
            console.log(`[ai-player] skill saved: ${s.name} v${s.version} (${outcome})`);
            return s;
        } catch (e) { console.warn(`[ai-player] long-memory saveSkill: ${e.message}`); return null; }
    }
    noteSkillUses(code) {
        let hit = false;
        for (const s of this.skills.data.skills) if (code.includes(`learned.${s.name}(`)) { s.uses++; hit = true; }
        if (hit) this.skills.save();
    }
    async relevantSkills(task, k = 3) {
        const S = this.skills.data.skills; if (!S.length || !task) return [];
        const qv = await this.embed(task);
        return S.map(s => ({ s, r: this._rel(qv, task, s, s.description + ' ' + s.name) }))
            .filter(x => x.r > (qv ? 0.55 : 0.15)).sort((a, b) => b.r - a.r).slice(0, k).map(x => x.s);
    }
    async skillDocs(task) {
        const top = await this.relevantSkills(task, 3);
        if (!top.length) return '';
        return '\n#### SAVED SKILLS (your own code that worked before) ###\nCall one with `await learned.NAME(bot);` instead of rewriting it, or adapt it:\n' +
            top.map(s => `### learned.${s.name}(bot) v${s.version}: ${s.description}\n\`\`\`\n${s.code.slice(0, 1200)}\n\`\`\``).join('\n');
    }
    // Compile every saved skill into async functions for the code sandbox (`learned.NAME(bot)`).
    compileLearned(makeCompartment, endowments) {
        const learned = {};
        for (const s of this.skills.data.skills) {
            try { learned[s.name] = makeCompartment({ ...endowments }).evaluate(`(async (bot) => {\n${s.code}\n})`); }
            catch (e) { console.warn(`[ai-player] skill ${s.name} failed to compile: ${e.message}`); }
        }
        return learned;
    }
}

// ---------- item/block name corrector (only for names that are invalid) ----------
export function correctName(agent, commandName, name, kind) {
    const bot = agent.bot; const reg = bot?.registry; if (!reg) return null;
    const valid = (n) => kind === 'item' ? !!reg.itemsByName[n] : kind === 'block' ? !!reg.blocksByName[n] : !!(reg.itemsByName[n] || reg.blocksByName[n]);
    let n = String(name).toLowerCase().trim().replace(/^minecraft:/, '').replace(/\s+/g, '_');
    if (commandName === '!smeltItem' && /_ore$/.test(n)) { const raw = 'raw_' + n.replace(/^deepslate_/, '').replace(/_ore$/, ''); if (valid(raw)) return raw; }
    if (valid(n)) return n;
    // [ai-player] berries: the bush block is sweet_berry_bush, the item sweet_berries; glow berries grow on cave_vines
    if (/^(sweet_)?berr(y|ies)$|^sweet_berry$/.test(n)) return kind === 'item' ? 'sweet_berries' : 'sweet_berry_bush';
    if (/^glow_berr(y|ies)$/.test(n)) return kind === 'item' ? 'glow_berries' : 'cave_vines';
    if (['log', 'logs', 'wood', 'tree', 'trees'].includes(n)) {
        const logs = Object.keys(reg.blocksByName).filter(b => b.endsWith('_log') && !b.startsWith('stripped_'));
        try {
            const pos = bot.findBlock({ matching: logs.map(l => reg.blocksByName[l].id), maxDistance: 48 });
            if (pos) return pos.name;
        } catch (_) {}
        const p = agent.longMemory?.nearestPlace('log'); if (p) return p.type;
        const inv = bot.inventory?.items?.().find(i => i.name.endsWith('_log')); if (inv) return inv.name;
        return 'oak_log';
    }
    const alias = { raw_coal: 'coal', cobble: 'cobblestone', planks: 'oak_planks', plank: 'oak_planks', wooden_planks: 'oak_planks', stick_: 'stick', pickaxe: 'wooden_pickaxe' };
    if (alias[n] && valid(alias[n])) return alias[n];
    if (n.endsWith('s') && valid(n.slice(0, -1))) return n.slice(0, -1);
    if (n.endsWith('es') && valid(n.slice(0, -2))) return n.slice(0, -2);
    return null;
}

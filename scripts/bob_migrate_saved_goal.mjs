// Offline, explicit migration for MineBobNE's saved homestead-only goal.
// Run only after the live launcher is stopped. This script never stops services.
import { readFileSync, writeFileSync, renameSync, copyFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NEW_GOAL = 'Check health, food, shelter, inventory, and danger first. After stabilizing, choose a safe independent project: gather varied resources, explore reachable new terrain, farm, build in allowed areas, or socialize with players. Your homestead is a base, not a boundary. Respect no-go zones, protected structures, and other players property.';
export function migrateSavedGoal(source) {
    const obj = structuredClone(source);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw Error('Expected a memory JSON object');
    const old = obj.self_prompt;
    let changedGoal = false, changedSummary = false;
    // This exact shelter-and-lighting instruction is another known legacy
    // fallback from the homestead-only goal circuit. Do not replace arbitrary
    // player-chosen shelter projects or other independently selected goals.
    const legacyShelterGoal = typeof old === 'string' &&
        old.trim().replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase() ===
        'inspect your own shelter and lighting. choose one small safe improvement using materials you already own. do not alter protected areas or other players builds';
    if (typeof old === 'string' &&
        (/at your own homestead|homestead plateau|build\/tidy homestead|stop hunting or taming animals/i.test(old) ||
         legacyShelterGoal)) {
        obj.self_prompt = NEW_GOAL;
        changedGoal = true;
    }
    if (typeof obj.memory === 'string') {
        const prior = obj.memory;
        obj.memory = obj.memory.replace(/Goal:\s*Build\/tidy homestead[^;.]*[;.]/i, 'Goal: explore and work on safe independent projects;');
        obj.memory = obj.memory.replace(/No animal hunting/gi, 'Food gathering for survival allowed');
        changedSummary = obj.memory !== prior;
    }
    return { data: obj, changedGoal, changedSummary };
}
function main() {
    const pathArg = process.argv.find(a => a.endsWith('.json'));
    if (!pathArg) throw Error('Usage: node scripts/bob_migrate_saved_goal.mjs /path/to/bots/MineBobNE/memory.json [--apply --stopped-confirmed]');
    const path = resolve(pathArg);
    const initial = readFileSync(path);
    const stat = statSync(path);
    const migrated = migrateSavedGoal(JSON.parse(initial.toString('utf8')));
    console.log('Saved goal replacement:', migrated.changedGoal);
    console.log('Summary priority correction:', migrated.changedSummary);
    console.log('Turns and other JSON fields: retained');
    if (!process.argv.includes('--apply')) { console.log('DRY RUN ONLY: file unchanged'); return; }
    if (!process.argv.includes('--stopped-confirmed')) throw Error('Refusing write: stop Bob and supply --stopped-confirmed');
    if (!migrated.changedGoal && !migrated.changedSummary) { console.log('No changes necessary'); return; }
    if (statSync(path).mtimeMs !== stat.mtimeMs || !readFileSync(path).equals(initial))
        throw Error('Memory file changed while preparing migration; refusing write');
    const backup = path + '.pre-autonomy-' + new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(path, backup);
    const tmp = path + '.autonomy.tmp';
    writeFileSync(tmp, JSON.stringify(migrated.data, null, 2) + '\n', {flag:'wx',mode:0o600});
    renameSync(tmp, path);
    console.log('Saved goal migrated. Original backup:', backup);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

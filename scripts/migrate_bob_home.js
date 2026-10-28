#!/usr/bin/env node
// Operator-run. Default is dry-run. Does not start with the bot.
//   node scripts/migrate_bob_home.js --dir bots/MineBobNE
//   node scripts/migrate_bob_home.js --dir bots/MineBobNE --apply --bot-stopped
import path from 'path';
import { applyHomeMigration, planHomeMigration } from '../src/agent/library/bob_home_migrate.js';

function args(argv) {
    const out = { dir: 'bots/MineBobNE', apply: false, botStopped: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--apply') out.apply = true;
        else if (argv[i] === '--bot-stopped') out.botStopped = true;
        else if (argv[i] === '--dir' && argv[i + 1]) { out.dir = argv[++i]; }
        else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    }
    return out;
}

const opt = args(process.argv);
if (opt.help) {
    console.log('Usage: node scripts/migrate_bob_home.js [--dir bots/MineBobNE] [--apply] [--bot-stopped]');
    console.log('Default is a dry-run. --apply requires --bot-stopped (Bob overwrites places/lessons while running).');
    console.log('--apply copies files to bots/<name>/migrations/home-<ts>/ then retires old-home items.');
    process.exit(0);
}

const botDir = path.resolve(opt.dir);
const plan = planHomeMigration(botDir, { botStopped: opt.botStopped });
console.log(JSON.stringify({
    botDir: plan.botDir,
    dryRun: !opt.apply,
    botStopped: plan.botStopped,
    warnings: plan.warnings,
    keep: plan.keep,
    actions: plan.actions.map((a) => ({ file: a.file, op: a.op, reason: a.reason, retired: a.retired, rewritten: a.rewritten })),
}, null, 2));
const report = applyHomeMigration(plan, { apply: opt.apply, botStopped: opt.botStopped });
console.log(report.message);
if (opt.apply && !report.applied) process.exit(1);
process.exit(0);

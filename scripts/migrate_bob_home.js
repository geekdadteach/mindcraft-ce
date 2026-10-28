#!/usr/bin/env node
// Operator-run. Default is dry-run. Does not start with the bot.
//   node scripts/migrate_bob_home.js --dir bots/MineBobNE
//   node scripts/migrate_bob_home.js --dir bots/MineBobNE --apply --bot-stopped
//   node scripts/migrate_bob_home.js --dir bots/MineBobNE --apply --bot-stopped --skip-running-probe
import path from 'path';
import { applyHomeMigration, planHomeMigration, probeBobRunning } from '../src/agent/library/bob_home_migrate.js';

function args(argv) {
    const out = { dir: 'bots/MineBobNE', apply: false, botStopped: false, skipProbe: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--apply') out.apply = true;
        else if (argv[i] === '--bot-stopped') out.botStopped = true;
        else if (argv[i] === '--skip-running-probe') out.skipProbe = true;
        else if (argv[i] === '--dir' && argv[i + 1]) { out.dir = argv[++i]; }
        else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    }
    return out;
}

const opt = args(process.argv);
if (opt.help) {
    console.log('Usage: node scripts/migrate_bob_home.js [--dir bots/MineBobNE] [--apply] [--bot-stopped] [--skip-running-probe]');
    console.log('Default is a dry-run. --apply requires --bot-stopped (Bob overwrites places/lessons while running).');
    console.log('--bot-stopped also probes MindServer on 127.0.0.1:8081 and launchctl gui/502/org.newearth.mindcraft-m4.');
    console.log('--skip-running-probe keeps the acknowledgment but skips that probe.');
    console.log('--apply copies files to bots/<name>/migrations/home-<ts>/ then retires old-home items.');
    process.exit(0);
}

const botDir = path.resolve(opt.dir);
const probe = opt.skipProbe ? { running: false, findings: ['--skip-running-probe'] } : await probeBobRunning();
const plan = planHomeMigration(botDir, { botStopped: opt.botStopped, skipProbe: opt.skipProbe, probe });
console.log(JSON.stringify({
    botDir: plan.botDir,
    dryRun: !opt.apply,
    botStopped: plan.botStopped,
    skipProbe: opt.skipProbe,
    probe,
    warnings: plan.warnings,
    keep: plan.keep,
    actions: plan.actions.map((a) => ({ file: a.file, op: a.op, reason: a.reason, retired: a.retired, rewritten: a.rewritten })),
}, null, 2));
const report = applyHomeMigration(plan, { apply: opt.apply, botStopped: opt.botStopped, skipProbe: opt.skipProbe, probe });
console.log(report.message);
if (opt.apply && !report.applied) process.exit(1);
process.exit(0);

#!/usr/bin/env node
// [bob-eval] `npm run eval:bob` — offline Bob evaluation. Sets BOB_EVAL=1 for THIS process only.
// Options: --only=logs,navigation   --verbose (show agent console output)
// Output: $BOB_EVAL_DIR (default ./eval-runs, gitignored): <run>.trace.jsonl, <run>.report.json, <run>.report.md
process.env.BOB_EVAL = '1';
const args = process.argv.slice(2);
const only = args.find(a => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean) || null;
const verbose = args.includes('--verbose');

const { runAll } = await import('./harness.js');
const { writeReport } = await import('./report.js');
const { DEFAULT_EVAL_DIR, EVAL_DIR_ENV } = await import('../../src/agent/library/bob_eval_trace.js');

const { report } = await runAll({ only, quiet: !verbose });
const files = writeReport(report, process.env[EVAL_DIR_ENV] || DEFAULT_EVAL_DIR);
for (const s of report.scenarios)
    console.log(`${s.passed ? 'PASS' : 'FAIL'}  ${s.id.padEnd(12)} class=${s.failure_class ?? '-'}  expectation=${s.matched_expectation ? 'ok' : 'MISMATCH: ' + s.mismatch_reasons.join('; ')}`);
console.log(`objective ${report.summary.passed}/${report.summary.total}, expectations matched ${report.summary.matched}/${report.summary.total}`);
console.log(`trace:  ${report.trace_file}\nreport: ${files.json}\n        ${files.md}`);
process.exit(report.summary.matched === report.summary.total ? 0 : 1);

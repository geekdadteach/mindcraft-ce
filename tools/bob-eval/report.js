// [bob-eval] JSON + markdown report writer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function renderMarkdown(report) {
    const L = [];
    L.push(`# Bob eval report — ${report.run_id}`, '');
    L.push(`Generated ${report.generated_at} · mode: ${report.mode} · node ${report.node}`, '');
    L.push(`Objective pass: **${report.summary.passed}/${report.summary.total}** · matched expectations: **${report.summary.matched}/${report.summary.total}**`, '');
    L.push('| scenario | objective | failure class | expected | incidents (model/parser/guard/action) | turns | task states |');
    L.push('|---|---|---|---|---|---|---|');
    for (const s of report.scenarios) {
        const ic = s.incident_counts;
        L.push(`| ${s.id} | ${s.passed ? 'PASS' : 'FAIL'} | ${s.failure_class ?? '-'} | ${s.expected.pass ? 'pass' : 'fail/' + (s.expected.failure_class || '?')} ${s.matched_expectation ? 'ok' : '**MISMATCH**'} | ${ic['model/prompt']}/${ic.parser}/${ic.guard}/${ic.action} | ${s.trace_summary.turns} | ${s.trace_summary.task_states.join(', ') || '-'} |`);
    }
    for (const s of report.scenarios) {
        L.push('', `## ${s.id} — ${s.title}`, '');
        for (const c of s.checks) L.push(`- ${c.passed ? '✔' : '✘'} ${c.desc} (actual: ${c.actual})`);
        if (s.error) L.push(`- harness error: ${s.error}`);
        for (const i of s.incidents) L.push(`- incident [${i.class}] ${i.turn_id ?? '-'} ${i.type}: ${i.note}`);
        if (s.mismatch_reasons?.length) L.push(`- expectation mismatch: ${s.mismatch_reasons.join('; ')}`);
    }
    L.push('', 'Success is decided only by the state checks above (inventory, distance, blocks), never by task.finished or action completion.');
    return L.join('\n') + '\n';
}

export function writeReport(report, dir) {
    const out = resolve(dir);
    mkdirSync(out, { recursive: true });
    const json = join(out, `${report.run_id}.report.json`);
    const md = join(out, `${report.run_id}.report.md`);
    writeFileSync(json, JSON.stringify(report, null, 2) + '\n');
    writeFileSync(md, renderMarkdown(report));
    return { json, md };
}

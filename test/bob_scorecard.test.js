import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'bob_scorecard.py');
const fixture = join(root, 'test', 'fixtures', 'bob_scorecard_week.jsonl');

function runScorecard(args, env = {}) {
    const result = spawnSync('python3', [script, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env, BOB_SCORECARD_DISCORD_WEBHOOK: '' },
    });
    return result;
}

test('scorecard dry-run reports aggregates, not-goal-completion, and tolerates bad lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-scorecard-'));
    try {
        const log = join(dir, 'bob-eval.jsonl');
        const rotated = join(dir, 'bob-eval.jsonl.1');
        writeFileSync(log, readFileSync(fixture, 'utf8'));
        writeFileSync(rotated, [
            '{"ts":"2026-10-24T18:00:00Z","mono_ms":50,"run_id":"r050.old","goal_id":null,"turn_id":"r050.old.t1","command_id":null,"task_id":null,"type":"turn_start","source":"system","self_prompt":true,"iteration":0}',
            '{"ts":"2026-10-24T18:00:01Z","mono_ms":51,"run_id":"r050.old","goal_id":null,"turn_id":"r050.old.t1","command_id":null,"task_id":null,"type":"model_response","lane":"conversation","backend":"andy_pool","model":"andy-4.2","latency_ms":4000,"empty":false,"is_model_error":false,"text_chars":10}',
            '',
        ].join('\n'));

        const result = runScorecard([
            '--log', log,
            '--since', '2026-10-24T00:00:00Z',
            '--until', '2026-10-31T00:00:00Z',
            '--dry-run',
            '--no-discord',
        ]);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const out = result.stdout;
        assert.match(out, /Runs and restarts/);
        assert.match(out, /Distinct `run_id`: \*\*3\*\*/);
        assert.match(out, /Model calls/);
        assert.match(out, /andy-4\.2/);
        assert.match(out, /coding/);
        assert.match(out, /429\/rate-limit/);
        assert.match(out, /## Parse/);
        assert.match(out, /Valid command/);
        assert.match(out, /No command/);
        assert.match(out, /Bad param/);
        assert.match(out, /`!fly`/);
        assert.match(out, /## Guard decisions/);
        assert.match(out, /`repeat`/);
        assert.match(out, /`dropped_by_interrupt`/);
        assert.match(out, /Action results \(NOT goal completion\)/);
        assert.match(out, /task\.finished` \/ `succeeded` is never proof of goal completion/);
        assert.match(out, /Goal checks/);
        assert.match(out, /world-state verifier|food|collect|craft/);
        assert.match(out, /Met rate/);
        assert.match(out, /Gap: exec succeeded but goal not_met/);
        assert.match(out, /`!getFood`/);
        assert.match(out, /Goal changes/);
        assert.match(out, /circuit_switch/);
        assert.match(out, /Detectable death-like events: \*\*2\*\*/);
        assert.match(out, /lite: \*\*1\*\*/);
        assert.match(out, /full: \*\*[1-9]/);
        assert.match(out, /Top 5 recurring failure patterns/);
        assert.match(out, /Malformed or truncated lines: 2/);
        assert.doesNotMatch(out, /discord\.com/i);
        assert.doesNotMatch(out, /sk-[A-Za-z0-9]{8,}/);
        assert.doesNotMatch(out, /@everyone/);
        assert.doesNotMatch(out, /player whispered/i);
        assert.doesNotMatch(result.stderr, /https:\/\//);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('scorecard empty window still writes a short report and exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-scorecard-empty-'));
    try {
        const log = join(dir, 'bob-eval.jsonl');
        writeFileSync(log, readFileSync(fixture, 'utf8'));
        const outdir = join(dir, 'cards');
        const result = runScorecard([
            '--log', log,
            '--since', '2020-01-01T00:00:00Z',
            '--until', '2020-01-02T00:00:00Z',
            '--outdir', outdir,
            '--no-discord',
        ]);
        assert.equal(result.status, 1, result.stderr || result.stdout);
        const md = readFileSync(join(outdir, 'scorecard-2020-01-02.md'), 'utf8');
        assert.match(md, /No events in the requested window/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('scorecard writes 0600 files and week-over-week deltas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-scorecard-wow-'));
    try {
        const log = join(dir, 'bob-eval.jsonl');
        writeFileSync(log, readFileSync(fixture, 'utf8'));
        const outdir = join(dir, 'cards');
        const prev = {
            runs: 1, restarts: 0, turns: 2, deaths: 0,
            model_calls: [{ errors: 0 }],
            guards: { repeat: 0 },
            action_results: { totals: { failed: 0 } },
        };
        mkdirSync(outdir, { recursive: true });
        writeFileSync(join(outdir, 'scorecard-2026-10-17.json'), JSON.stringify(prev));
        const result = runScorecard([
            '--log', log,
            '--since', '2026-10-24T00:00:00Z',
            '--until', '2026-10-31T00:00:00Z',
            '--outdir', outdir,
            '--no-discord',
        ]);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const md = readFileSync(join(outdir, 'scorecard-2026-10-31.md'), 'utf8');
        assert.match(md, /Week-over-week/);
        assert.match(md, /turns: \+/);
        assert.equal(statSync(join(outdir, 'scorecard-2026-10-31.md')).mode & 0o077, 0);
        assert.equal(statSync(join(outdir, 'scorecard-2026-10-31.json')).mode & 0o077, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// [ai-player] 2026-11-01 (item 3) - the harness rotates its JSONL instead of stopping at the size cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalHarnessWriter } from '../src/agent/library/bob_eval_harness.js';

function withDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'bob-eval-rotate-'));
    return Promise.resolve().then(() => fn(dir)).finally(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
}
const rec = (n) => ({ n, pad: 'x'.repeat(40) });

test('the writer rotates to .1 instead of stopping when it passes the cap', async () => {
    await withDir(async (dir) => {
        const file = join(dir, 'bob-eval.jsonl');
        const warns = [];
        const writer = new EvalHarnessWriter(
            { enabled: true, path: file },
            { maxBytes: 300, log: { log() {}, warn: (m) => warns.push(String(m)) }, env: {} },
        );
        for (let i = 0; i < 20; i++) writer.enqueue(rec(i));
        await writer.flush();
        const disabled = writer.disabled;
        writer.close();
        assert.equal(disabled, false, 'the writer did not stop');
        assert.equal(warns.some(w => w.includes('size cap')), false, 'it never hit the size cap');
        assert.ok(existsSync(`${file}.1`), 'the previous active file was rotated to .1');
        assert.ok(existsSync(file), 'and a fresh active file was opened');
        assert.match(readFileSync(file, 'utf8'), /"n":19/, 'the newest record is in the active file');
    });
});

test('rotation is bounded: no archive beyond maxArchives', async () => {
    await withDir(async (dir) => {
        const file = join(dir, 'bob-eval.jsonl');
        const writer = new EvalHarnessWriter(
            { enabled: true, path: file },
            { maxBytes: 200, maxArchives: 2, log: { log() {}, warn() {} }, env: {} },
        );
        for (let i = 0; i < 40; i++) writer.enqueue(rec(i));
        await writer.flush();
        writer.close();
        assert.ok(existsSync(`${file}.1`));
        assert.ok(existsSync(`${file}.2`));
        assert.equal(existsSync(`${file}.3`), false, 'no archive beyond maxArchives');
    });
});

test('BOB_EVAL_HARNESS_ROTATE=0 restores the stop-at-cap behavior', async () => {
    await withDir(async (dir) => {
        const file = join(dir, 'bob-eval.jsonl');
        const warns = [];
        const writer = new EvalHarnessWriter(
            { enabled: true, path: file },
            { maxBytes: 300, log: { log() {}, warn: (m) => warns.push(String(m)) }, env: { BOB_EVAL_HARNESS_ROTATE: '0' } },
        );
        for (let i = 0; i < 20; i++) writer.enqueue(rec(i));
        await writer.flush();
        const disabled = writer.disabled;
        writer.close();
        assert.equal(disabled, true, 'the opt-out stops at the cap');
        assert.equal(warns.some(w => w.includes('size cap')), true);
        assert.equal(existsSync(`${file}.1`), false, 'no rotation');
    });
});

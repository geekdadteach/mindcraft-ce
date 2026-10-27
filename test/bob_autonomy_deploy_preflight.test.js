import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('deployment resolves actual shell variables and reports missing prerequisites before stopping Bob', () => {
  const home = mkdtempSync(join(tmpdir(), 'bob-deploy-check-'));
  const script = fileURLToPath(new URL('../scripts/bob_autonomy_deploy.sh', import.meta.url));
  const bin = join(home, 'fake-node22');
  try {
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // No LaunchAgent is installed under temporary HOME: script must fail early.
    // This is safe to run even on MM20; it never touches the real launchctl job.
    const result = spawnSync('bash', [script], {
      cwd: home,
      env: { ...process.env, HOME: home, BOB_NODE22: bin },
      encoding: 'utf8', timeout: 5000
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const source = resolve(script, '..', '..');
    assert.match(result.stdout, /Staged checkout: /);
    assert.ok(result.stdout.includes('Staged checkout: ' + source), result.stdout);
    assert.ok(result.stdout.includes('Node 22: ' + bin), result.stdout);
    assert.match(result.stdout, /FAIL: LaunchAgent plist missing:/);
    assert.doesNotMatch(result.stdout, /STOP BOB|SOURCE BACKUP|START ONE/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

test('deployment waits for stable launchd startup instead of failing after five seconds', () => {
  const script = fileURLToPath(new URL('../scripts/bob_autonomy_deploy.sh', import.meta.url));
  const source = readFileSync(script, 'utf8');
  assert.match(source, /for _ in \{1\.\.45\}; do/);
  assert.match(source, /if service_loaded; then/);
  assert.match(source, /LaunchAgent already registered; observing its startup/);
  assert.match(source, /Candidate LaunchAgent remains registered after bootout/);
  assert.doesNotMatch(source, /sleep 5\s*NEWPID=/);
});

test('deployment preserves persistence state and never silently erases failure history', () => {
  const script = fileURLToPath(new URL('../scripts/bob_autonomy_deploy.sh', import.meta.url));
  const source = readFileSync(script, 'utf8');
  assert.match(source, /bob_snapshot_state\.py/);
  assert.match(source, /BACK UP FINAL MEMORY STATE/);
  assert.match(source, /SNAPSHOT ALL KNOWN BOB STATE FILES/);
  assert.ok(source.indexOf('BACK UP FINAL MEMORY STATE') < source.indexOf('SNAPSHOT ALL KNOWN BOB STATE FILES'));
  assert.ok(source.indexOf('SNAPSHOT ALL KNOWN BOB STATE FILES') < source.indexOf('INSTALL AND VERIFY STAGED SOURCE'));
  assert.doesNotMatch(source, /rm\s+[^\n]*failures\.json/);
});

test('startup probe falls back to launchctl print PID and surfaces diagnostic state', () => {
  const script = fileURLToPath(new URL('../scripts/bob_autonomy_deploy.sh', import.meta.url));
  const source = readFileSync(script, 'utf8');
  assert.match(source, /launchctl print "\$DOMAIN\/\$LABEL" 2>\/dev\/null \| awk/);
  assert.match(source, /LaunchAgent has no stable running launcher/);
  assert.match(source, /last exit code =/);
});

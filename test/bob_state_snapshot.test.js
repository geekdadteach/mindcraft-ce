import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const snapshotScript = fileURLToPath(new URL('../scripts/bob_snapshot_state.py', import.meta.url));
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'bob-snapshot-'));
  const live = join(root, 'live');
  const backup = join(root, 'backup');
  mkdirSync(live);
  mkdirSync(backup);
  mkdirSync(join(live,'bots','MineBobNE'), {recursive:true});
  try { fn({root,live,backup}); } finally {rmSync(root,{recursive:true,force:true});}
}
function run(live, backup) {
  return spawnSync('python3',[snapshotScript,live,backup], {encoding:'utf8',timeout:5000});
}
test('snapshot preserves memory and each learned state file exactly without changing live',()=>{
  fixture(({live,backup})=>{
    const bot=join(live,'bots','MineBobNE');
    for(const name of ['memory.json','failures.json','lessons.json','places.json','home_routes.json','stuck_home.json'])
      writeFileSync(join(bot,name), name==='memory.json'?'{"turns":[1,2,3],"self_prompt":"unique"}':('content:'+name));
    const r=run(live,backup);
    assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
    const manifest=JSON.parse(readFileSync(join(backup,'persistent-state','manifest.json'),'utf8'));
    assert.equal(manifest.length,6);
    for(const entry of manifest) {
      assert.deepEqual(readFileSync(join(backup,'persistent-state',entry.path)), readFileSync(join(live,entry.path)));
    }
  });
});
test('snapshot fails closed on symlinked state and never modifies live',()=>{
  fixture(({live,backup})=>{
    const bot=join(live,'bots','MineBobNE');
    writeFileSync(join(bot,'memory.json'),'{"turns":[]}');
    symlinkSync(join(bot,'memory.json'),join(bot,'lessons.json'));
    const r=run(live,backup);
    assert.notEqual(r.status,0,r.stdout);
    assert.match(r.stderr,/unsafe state file/);
    assert.equal(readFileSync(join(bot,'memory.json'),'utf8'),'{"turns":[]}');
  });
});

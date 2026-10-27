import test from 'node:test';
import assert from 'node:assert/strict';
import {isNaturalWoodBlockName, availableWoodNames} from '../src/agent/library/bob_wood_types.js';
test('supports logs, Nether stems, new tree types and bamboo without crafted wood', () => {
  const names = ['oak_log','pale_oak_log','dark_oak_log','cherry_log','crimson_stem','warped_stem','bamboo_block'];
  for (const n of names) assert.equal(isNaturalWoodBlockName(n), true);
  for (const n of ['oak_planks','stripped_oak_log','oak_wood','fence','chest']) assert.equal(isNaturalWoodBlockName(n), false);
  assert.deepEqual(availableWoodNames(names.map(name => ({name}))).sort(), [...names].sort());
});

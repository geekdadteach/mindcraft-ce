import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateSavedGoal} from '../scripts/bob_migrate_saved_goal.mjs';
test('replaces homestead-only goals and old summary without deleting memories', () => {
 const src = {self_prompt:'Inspect your inventory and choose safe work at your own homestead.',
   self_prompting_state:1, turns:[{role:'user',content:'remember this'}],
   memory:'Goal: Build/tidy homestead near -823,124,568; Found a river; No animal hunting'};
 const result = migrateSavedGoal(src);
 assert.equal(result.changedGoal,true);
 assert.match(result.data.self_prompt,/base, not a boundary/);
 assert.equal(result.data.turns[0].content,'remember this');
 assert.match(result.data.memory,/Found a river/);
 assert.doesNotMatch(result.data.memory,/No animal hunting/);
 assert.equal(src.self_prompting_state,1);
});
test('does not replace independently selected unrelated goals', () => {
 const src = {self_prompt:'Find a new biome beyond the river',turns:[]};
 const result=migrateSavedGoal(src);
 assert.equal(result.changedGoal,false);
 assert.equal(result.data.self_prompt,src.self_prompt);
});

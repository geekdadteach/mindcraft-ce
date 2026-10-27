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

test('migrates the exact live shelter-improvement fallback, retaining 11 turns and state', () => {
 const src = {
   self_prompt: 'Inspect your own shelter and lighting. Choose one small safe improvement using materials you already own. Do not alter protected areas or other players builds.',
   self_prompting_state: 1,
   turns: Array.from({length:11}, (_,i) => ({role: 'assistant', content: 'turn '+i})),
   taskStart: 12345,
   memory: 'Goal: Build/tidy homestead at -823,124,568; equip iron. Learned: Till for wheat; protect brown_carpet at -821,124,569.'
 };
 const outcome = migrateSavedGoal(src);
 assert.equal(outcome.changedGoal, true);
 assert.equal(outcome.changedSummary, true);
 assert.match(outcome.data.self_prompt, /homestead is a base, not a boundary/);
 assert.doesNotMatch(outcome.data.memory, /Goal: Build\/tidy homestead/i);
 assert.match(outcome.data.memory, /protect brown_carpet/);
 assert.equal(outcome.data.self_prompting_state, 1);
 assert.equal(outcome.data.turns.length, 11);
 assert.equal(outcome.data.taskStart, 12345);
 assert.deepEqual(src.turns, outcome.data.turns);
 assert.match(src.self_prompt, /Inspect your own shelter/);
});
test('preserves independently selected shelter task with different intent', () => {
 const src = {self_prompt: 'Inspect your shelter and build a window to see the mountains.', memory: 'No goals yet.', turns:[]};
 const outcome = migrateSavedGoal(src);
 assert.equal(outcome.changedGoal, false);
 assert.equal(outcome.changedSummary, false);
 assert.deepEqual(outcome.data, src);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskLifecycle} from '../src/agent/library/bob_task_lifecycle.js';
test('cannot run competing tasks', () => {
 const t = new TaskLifecycle(); const a = t.begin('mine');
 assert.throws(() => t.begin('chest'), /another task/);
 assert.equal(t.settle(a, {success: true}), true);
 assert.equal(t.begin('chest').label, 'chest');
});
test('late abandoned Promise cannot overwrite a newer task', () => {
 const events = []; const t = new TaskLifecycle({emit: e => events.push(e)});
 const old = t.begin('mine'); t.requestCancel(old, 'survival.low_health');
 t.abandon(old); const next = t.begin('survival');
 assert.equal(t.settle(old, {success: true}), false);
 assert.equal(t.active, next); assert.equal(old.state, 'uncertain');
 assert.ok(events.some(x => x.type === 'task.late_settlement'));
 assert.equal(t.settle(next, {success: true}), true);
});
test('cooperative cancellation ends cancelled, not succeeded', () => {
 const t = new TaskLifecycle(); const a = t.begin('gather');
 t.requestCancel(a, 'night');
 assert.equal(t.settle(a, {success: true}), true);
 assert.equal(a.state, 'cancelled');
});

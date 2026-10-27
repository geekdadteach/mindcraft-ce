import test from 'node:test';
import assert from 'node:assert/strict';
import {criticalSurvivalGuard} from '../src/agent/library/bob_survival_gate.js';
test('critical health forbids optional mining and building', () => {
  const bot = {health: 1, food: 0};
  assert.match(criticalSurvivalGuard(bot, '!collectBlocks'), /CRITICAL/);
  assert.match(criticalSurvivalGuard(bot, '!goToCoordinates'), /CRITICAL/);
  assert.equal(criticalSurvivalGuard(bot, '!getFood'), null);
  assert.equal(criticalSurvivalGuard(bot, '!goToBed'), null);
});
test('healthy bot can roam, and player-directed actions are not overridden here', () => {
  assert.equal(criticalSurvivalGuard({health: 20, food: 19}, '!collectBlocks'), null);
  assert.equal(criticalSurvivalGuard({health: 1, food: 0}, '!collectBlocks', false), null);
});

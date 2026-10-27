import test from 'node:test';
import assert from 'node:assert/strict';
import {withInventoryWindow, windowLeaseStatus, WindowBusyError, SupersededWindowAction} from '../src/agent/library/bob_inventory_window.js';
test('overlapping chest operations are refused', async () => {
  let release; const gate = new Promise(r => {release = r});
  const win = {async close() {}};
  const bot = {_actionGen: 1, openContainer: async () => win};
  const first = withInventoryWindow(bot, {}, 'deposit', async () => {await gate; return true});
  await assert.rejects(withInventoryWindow(bot, {}, 'withdraw', async () => {}), WindowBusyError);
  release(); assert.equal(await first, true); assert.equal(windowLeaseStatus(bot).busy, false);
});
test('cancellation closes the old window', async () => {
  const win = {async close() {}};
  const bot = {_actionGen: 5, openContainer: async () => win};
  await assert.rejects(withInventoryWindow(bot, {}, 'deposit', async (_, verify) => {
    bot._actionGen++; verify();
  }), SupersededWindowAction);
  assert.equal(windowLeaseStatus(bot).busy, false);
});
test('unconfirmed close raises error and quarantines', async () => {
  const bot = {_actionGen: 1, openContainer: async () => ({async close() {throw Error('lost packet')}})};
  await assert.rejects(withInventoryWindow(bot, {}, 'withdraw', async () => true), WindowBusyError);
  assert.equal(windowLeaseStatus(bot).quarantined, true);
  await assert.rejects(withInventoryWindow(bot, {}, 'deposit', async () => {}), WindowBusyError);
});

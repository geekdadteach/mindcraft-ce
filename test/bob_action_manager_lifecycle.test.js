import test from 'node:test';
import assert from 'node:assert/strict';
import {ActionManager} from '../src/agent/action_manager.js';

function setup() {
  const events = [];
  const bot = {_actionGen:0, output:'', interrupt_code:false,
    emit(type, payload) {if (type === 'bob_task_event') events.push(payload);},
    pathfinder:{stop(){},setGoal(){}},
    clearControlStates(){}, stopDigging(){}, pvp:{stop(){}}
  };
  const agent = {bot,
    clearBotLogs() {bot.output = ''; bot.interrupt_code = false;},
    requestInterrupt() {bot.interrupt_code = true;},
    history:{add(){}}, self_prompter:{isActive(){return false;}},
    isIdle(){return true;}, cleanKill(){throw Error('unexpected termination')}
  };
  return {manager:new ActionManager(agent), bot, events};
}

test('simple action produces a successful terminal outcome', async () => {
  const {manager, events} = setup();
  const result = await manager.runAction('task:one', async () => {});
  assert.equal(result.success, true);
  assert.equal(manager.executing, false);
  assert.equal(manager.currentTask, null);
  assert.equal(events.find(x => x.type === 'task.finished')?.state, 'succeeded');
});

test('cooperative preemption returns cancelled, then runs next task', async () => {
  const {manager, events} = setup();
  let complete;
  const gate = new Promise(resolve => {complete = resolve;});
  const first = manager.runAction('collect', async () => {await gate;});
  await new Promise(r => setTimeout(r, 20));
  const second = manager.runAction('survival', async () => {});
  await new Promise(r => setTimeout(r, 70));
  complete();
  const firstResult = await first;
  const secondResult = await second;
  assert.equal(firstResult.success, false);
  assert.equal(firstResult.interrupted, true);
  assert.equal(secondResult.success, true);
  assert.equal(manager.currentTask, null);
  const finished = events.filter(e => e.type === 'task.finished');
  assert.equal(finished.length, 2);
  assert.equal(finished[0].state, 'cancelled');
  assert.equal(finished[1].state, 'succeeded');
});

test('late completion of abandoned action cannot clear newer task state', async () => {
  const {manager, events} = setup();
  let completeOld, completeNew;
  const oldGate = new Promise(resolve => {completeOld = resolve;});
  const newGate = new Promise(resolve => {completeNew = resolve;});
  const old = manager.runAction('unresponsive', async () => {await oldGate;});
  await new Promise(r => setTimeout(r, 20));
  const next = manager.runAction('critical-survival', async () => {await newGate;});
  await new Promise(r => setTimeout(r, 10500)); // exercise real 10 s abandonment
  assert.equal(manager.currentActionLabel, 'critical-survival');
  completeOld();
  const oldResult = await old;
  assert.equal(oldResult.success, false);
  assert.equal(oldResult.interrupted, true);
  assert.equal(manager.currentActionLabel, 'critical-survival');
  completeNew();
  assert.equal((await next).success, true);
  assert.ok(events.some(e => e.type === 'task.uncertain'));
  assert.ok(events.some(e => e.type === 'task.late_settlement'));
});

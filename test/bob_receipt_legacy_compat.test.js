import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionManager } from '../src/agent/action_manager.js';
import { noteRuntimeStart, noteRuntimeFinish, runCommandPerform } from '../src/agent/library/bob_brain_v2.js';

test('legacy command-depth action emits no duplicate runtime receipt', async () => {
    const events = [];
    const agent = {
        bobBrain: { receipts: {
            beginRuntime(label) { events.push(['start', label]); return { label }; },
            finishRuntime(handle, outcome) { events.push(['finish', handle.label, outcome]); }
        } },
        cleanKill() {},
        clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false; },
        bot: { output: '', interrupt_code: false, emit() {}, _actionGen: 0 }
    };
    const manager = new ActionManager(agent);
    await manager._executeAction('mode:self_defense', async () => {}, -1);
    assert.equal(events.length, 2, 'outside command context, create one start and one result');
    agent._bobV2CommandDepth = 1;
    agent._bobV2OutcomeSlot = { outcome: null };
    const before = events.length;
    await manager._executeAction('action:collectBlocks', async () => { agent.bot.interrupt_code = true; }, -1);
    assert.equal(events.length, before, 'inside a legacy command, do not double count');
    assert.equal(agent._bobV2OutcomeSlot.outcome.interrupted, true);
});

test('AsyncLocalStorage outcome wins over an unrelated old command slot', async () => {
    const results = [];
    const oldSlot = { outcome: null };
    const agent = {
        _bobV2CommandDepth: 1,
        _bobV2OutcomeSlot: oldSlot,
        bobBrain: { receipts: {
            newLocalTrace() { return 'trace-1'; },
            nextActionId() { return 'a1'; },
            emitActionStarted() {},
            emitActionResult(_handle, result) { results.push(result); }
        } }
    };
    await runCommandPerform(agent, { commandName: '!collectBlocks', action: true }, async () => {
        assert.equal(noteRuntimeStart(agent, 'nested'), null);
        noteRuntimeFinish(agent, null, { success: true, marker: 'new-command' });
        return 'ok';
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].runtime.marker, 'new-command');
    assert.equal(oldSlot.outcome, null, 'new command must not overwrite old slot');
});

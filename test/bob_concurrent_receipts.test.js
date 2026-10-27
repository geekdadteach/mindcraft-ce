import test from 'node:test';
import assert from 'node:assert/strict';
import {noteRuntimeFinish, noteRuntimeStart, runCommandPerform} from '../src/agent/library/bob_brain_v2.js';

test('interleaving two commands keeps separate async outcome slots', async () => {
    const results = [];
    let n = 0, releaseOld;
    const oldGate = new Promise(r => { releaseOld = r; });
    const agent = {bobBrain: {receipts: {
        newLocalTrace() { return 'trace-' + (++n); },
        nextActionId() { return 'action-' + n; },
        emitActionStarted() {},
        emitActionResult(handle, outcome) { results.push({name: handle.commandName, ...outcome}); }
    }}};
    const old = runCommandPerform(agent, {commandName:'!old', action:true}, async () => {
        await oldGate;
        noteRuntimeFinish(agent, null, {success: false, reason:'older cancelled'});
        return 'old result';
    });
    const newer = runCommandPerform(agent, {commandName:'!newer', action:true}, async () => {
        noteRuntimeFinish(agent, null, {success: true, reason:'newer succeeded'});
        return 'newer result';
    });
    assert.equal(await newer, 'newer result');
    releaseOld();
    assert.equal(await old, 'old result');
    const oldReceipt = results.find(x => x.name === '!old');
    const newReceipt = results.find(x => x.name === '!newer');
    assert.equal(oldReceipt.runtime.reason, 'older cancelled');
    assert.equal(newReceipt.runtime.reason, 'newer succeeded');
    assert.equal(noteRuntimeStart(agent, 'outside') == null, true); // no receipts.beginRuntime in this mock
});

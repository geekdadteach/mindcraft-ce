// [ai-player] 2026-11-01 (item 4) - the model sent !unstuck, which did not exist. It is now a real
// recovery command, and an unknown command reply names the valid commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCommand, commandExists, parseCommandMessage } from '../src/agent/commands/index.js';

const unstuck = () => getCommand('!unstuck');

test('!unstuck is registered and runs the escape-up recovery', async () => {
    const cmd = unstuck();
    assert.ok(cmd, '!unstuck is a real command');
    assert.equal(commandExists('!unstuck'), true);
    const calls = { up: 0 };
    const agent = {
        bot: { output: '' },
        escape: { up: async () => { calls.up++; return { ok: true }; } },
        actions: { runAction: async (l, fn) => { await fn(); return { message: '' }; } },
    };
    await cmd.perform(agent);
    assert.equal(calls.up, 1, 'the escape-up recovery ran');
    assert.equal(agent.stuck_guard, null, 'the stuck guard is cleared');
});

test('!unstuck does not throw when there is no escape helper', async () => {
    const agent = {
        bot: { output: '', pathfinder: { setMovements() {}, goto: async () => {}, stop() {} }, entity: { position: { x: 0, y: 64, z: 0 } } },
        actions: { runAction: async (l, fn) => { await fn(); return { message: '' }; } },
    };
    await assert.doesNotReject(() => unstuck().perform(agent));
});

test('an unknown command reply names the valid commands', () => {
    const reply = parseCommandMessage('!notARealCommand');
    assert.equal(typeof reply, 'string');
    assert.match(reply, /is not a command/);
    assert.match(reply, /Valid commands:/);
    assert.match(reply, /!unstuck/, 'the reply names the real commands');
});


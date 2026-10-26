import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GoalFailureCircuit,
    goalFailureSignature
} from '../src/agent/library/bob_goal_circuit.js';
import { SelfPrompter } from '../src/agent/self_prompter.js';

test('cow searches share a failure signature', () => {
    assert.equal(
        goalFailureSignature(
            '!searchForEntity', 'cow',
            'Could not find any cow within 128 blocks'
        ),
        goalFailureSignature(
            '!searchForEntity', 'cow',
            'Could not find any cow within 64 blocks'
        )
    );

    assert.notEqual(
        goalFailureSignature('search', 'cow', 'not found'),
        goalFailureSignature('search', 'sheep', 'not found')
    );
});

test('three spaced failures trip a goal circuit', () => {
    let now = 100_000;
    const circuit = new GoalFailureCircuit({
        now: () => now
    });

    circuit.reset('Find a cow');

    assert.equal(
        circuit.record('search', 'cow', 'Could not find cow'),
        null
    );

    // Duplicate callbacks from the same attempt do not count.
    assert.equal(
        circuit.record('search', 'cow', 'Could not find cow'),
        null
    );

    now += 10 * 60_000;
    assert.equal(
        circuit.record('search', 'cow', 'Could not find cow'),
        null
    );

    now += 10 * 60_000;
    assert.equal(
        circuit.record('search', 'cow', 'Could not find cow')
            ?.count,
        3
    );

    assert.equal(circuit.tripped.goal, 'find a cow');
});

test('success clears matching failures', () => {
    let now = 100_000;
    const circuit = new GoalFailureCircuit({
        now: () => now
    });

    circuit.reset('Gather berries');

    circuit.record('collect', 'berries', 'Not found');
    now += 5 * 60_000;
    circuit.record('collect', 'berries', 'Not found');

    circuit.success('collect', 'berries');

    now += 5 * 60_000;
    assert.equal(
        circuit.record('collect', 'berries', 'Not found'),
        null
    );
    assert.equal(circuit.tripped, null);
});

test('explicitly assigning a new goal resets the circuit', () => {
    let now = 100_000;
    const circuit = new GoalFailureCircuit({
        now: () => now
    });

    circuit.reset('Find cow');

    for (let i = 0; i < 3; i++) {
        circuit.record('search', 'cow', 'not found');
        now += 60_000;
    }

    assert.ok(circuit.tripped);

    circuit.reset('Build a cabin');
    assert.equal(circuit.tripped, null);
    assert.equal(circuit.failures.size, 0);
});

test('actual self-prompt loop changes goals and remains autonomous', async () => {
    let prompter;
    let calls = 0;
    let replacement = '';

    const agent = {
        actions: { async stop() {} },
        last_reply_was_model_error: false,
        async handleMessage() {
            calls++;

            if (prompter.prompt === 'Find a cow') {
                prompter.noteFailure(
                    'search', 'cow',
                    'Could not find cow'
                );
                return true;
            }

            replacement = prompter.prompt;

            // End the test's loop without issuing Minecraft commands.
            prompter.interrupt = true;
            return false;
        }
    };

    prompter = new SelfPrompter(agent);
    prompter.cooldown = 0;
    prompter.goalCircuit = new GoalFailureCircuit({
        minGapMs: 0
    });

    prompter.start('Find a cow');

    const deadline = Date.now() + 2000;

    while (prompter.loop_active &&
        Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5));
    }

    assert.equal(prompter.loop_active, false);
    assert.equal(prompter.isActive(), true);
    assert.equal(calls, 4);
    assert.notEqual(replacement, 'Find a cow');
    assert.match(replacement, /homestead/i);
    assert.equal(prompter.goalCircuit.tripped, null);
});

test('failed goals are skipped until their cooldown expires', () => {
    let now = 100_000;

    const circuit = new GoalFailureCircuit({
        now: () => now,
        minGapMs: 0,
        threshold: 1
    });

    circuit.reset('Find a cow');
    circuit.record('search', 'cow', 'not found');

    const first = circuit.nextAutonomousGoal();
    assert.ok(first);
    assert.notEqual(first, 'Find a cow');

    circuit.reset(first);
    circuit.record('search', 'stone', 'not found');

    const second = circuit.nextAutonomousGoal();
    assert.ok(second);
    assert.notEqual(first, second);

    // Exhaust the remaining available alternatives.
    let candidate = second;

    for (let i = 0; i < 4; i++) {
        circuit.reset(candidate);
        circuit.record('search', 'resource', 'not found');
        candidate = circuit.nextAutonomousGoal();

        if (candidate === null)
            break;
    }

    assert.equal(candidate, null);

    // Old blocked alternatives become eligible again.
    now += 31 * 60_000;

    circuit.reset('Review options');
    circuit.record('search', 'resource', 'not found');

    assert.ok(circuit.nextAutonomousGoal());
});

test('failures outside an active goal do not trip the circuit', () => {
    const prompter = new SelfPrompter({
        actions: { async stop() {} }
    });

    assert.equal(
        prompter.noteFailure(
            'search', 'cow', 'not found'
        ),
        null
    );
    assert.equal(prompter.goalCircuit.tripped, null);
});

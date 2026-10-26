import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    DistinctPathFailures,
    pathTargetKey
} from '../src/agent/library/bob_path_escalation.js';
import {
    retryPathfinding
} from '../src/agent/library/bob_path_retry.js';

const goal = (x, z) => ({ x, y: 64, z });
const noPath = () => Object.assign(
    new Error('No path to the goal!'),
    { name: 'NoPath' }
);

test('target keys distinguish real destinations', () => {
    assert.equal(pathTargetKey(goal(10, 20)), '10,64,20');
    assert.equal(pathTargetKey(goal(11, 20)), '11,64,20');
    assert.equal(pathTargetKey({}), null);
    assert.equal(pathTargetKey(null), null);
});

test('retries to one target never qualify', () => {
    const gate = new DistinctPathFailures();

    assert.equal(
        gate.record(goal(10, 20), 'noPath').escalate,
        false
    );
    assert.equal(
        gate.record(goal(10, 20), 'noPath').reason,
        'same_target'
    );
});

test('two different targets qualify for escalation', () => {
    const gate = new DistinctPathFailures();

    gate.record(goal(10, 20), 'noPath');

    const second = gate.record(
        goal(30, 20), 'noPath'
    );

    assert.equal(second.escalate, true);
    assert.equal(second.distinctTargets, 2);
});

test('target failures expire after five minutes', () => {
    let now = 100_000;

    const gate = new DistinctPathFailures({
        now: () => now
    });

    gate.record(goal(10, 20), 'noPath');
    now += 6 * 60_000;

    assert.equal(
        gate.record(goal(30, 20), 'noPath').escalate,
        false
    );
});

test('different error causes do not form one episode', () => {
    const gate = new DistinctPathFailures();

    gate.record(goal(10, 20), 'noPath');

    assert.equal(
        gate.record(goal(30, 20), 'timeout').escalate,
        false
    );
});

test('exhausted retry emits exactly one final notification', async () => {
    const bot = new EventEmitter();
    let notifications = 0;
    let attempts = 0;

    bot.on('bob_path_terminal_failure', info => {
        notifications++;
        assert.deepEqual(
            info.goal, goal(10, 20)
        );
    });

    await assert.rejects(
        () => retryPathfinding(
            bot,
            async () => {
                attempts++;
                throw noPath();
            },
            { targetGoal: goal(10, 20) }
        ),
        /No path/
    );

    assert.equal(attempts, 2);
    assert.equal(notifications, 1);
    assert.equal(bot._bobBrainLocalRetryDepth, undefined);
});

test('successful retry sends no terminal failure', async () => {
    const bot = new EventEmitter();
    let attempts = 0;
    let notifications = 0;

    bot.on('bob_path_terminal_failure', () => {
        notifications++;
    });

    assert.equal(
        await retryPathfinding(
            bot,
            async () => {
                attempts++;
                if (attempts === 1)
                    throw noPath();
            },
            { targetGoal: goal(10, 20) }
        ),
        true
    );

    assert.equal(attempts, 2);
    assert.equal(notifications, 0);
});

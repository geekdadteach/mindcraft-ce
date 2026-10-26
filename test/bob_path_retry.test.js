import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isRetryablePathError,
    retryPathfinding
} from '../src/agent/library/bob_path_retry.js';

const noPath = () => Object.assign(
    new Error('No path to the goal!'),
    { name: 'NoPath' }
);

test('retryable path failures are classified correctly', () => {
    assert.equal(isRetryablePathError(noPath()), true);

    assert.equal(isRetryablePathError(
        Object.assign(new Error('timeout'), { name: 'Timeout' })
    ), true);

    assert.equal(isRetryablePathError(
        Object.assign(new Error('Player stopped'), {
            name: 'PathStopped'
        })
    ), false);

    assert.equal(isRetryablePathError(
        new Error('Cannot break protected block')
    ), false);
});

test('one local retry can recover a transient no-path', async () => {
    const bot = {};
    let attempts = 0;
    let retries = 0;

    const result = await retryPathfinding(
        bot,
        async () => {
            attempts++;
            assert.equal(bot._bobBrainLocalRetryDepth, 1);
            if (attempts === 1) throw noPath();
        },
        { onRetry: () => retries++ }
    );

    assert.equal(result, true);
    assert.equal(attempts, 2);
    assert.equal(retries, 1);
    assert.equal(bot._bobBrainLocalRetryDepth, undefined);
});

test('persistent no-path stops after exactly two attempts', async () => {
    const bot = {};
    let attempts = 0;

    await assert.rejects(
        () => retryPathfinding(bot, async () => {
            attempts++;
            throw noPath();
        }),
        /No path/
    );

    assert.equal(attempts, 2);
    assert.equal(bot._bobBrainLocalRetryDepth, undefined);
});

test('non-path errors are never retried', async () => {
    const bot = {};
    let attempts = 0;

    await assert.rejects(
        () => retryPathfinding(bot, async () => {
            attempts++;
            throw new Error('Protected area');
        }),
        /Protected area/
    );

    assert.equal(attempts, 1);
    assert.equal(bot._bobBrainLocalRetryDepth, undefined);
});

test('interruption prevents another navigation attempt', async () => {
    const bot = { _actionGen: 10 };
    let attempts = 0;

    const result = await retryPathfinding(
        bot,
        async () => {
            attempts++;
            bot._actionGen = 11;
            throw noPath();
        }
    ).catch(() => false);

    assert.equal(result, false);
    assert.equal(attempts, 1);
    assert.equal(bot._bobBrainLocalRetryDepth, undefined);
});

test('explicit stop prevents any navigation attempt', async () => {
    const bot = { interrupt_code: true };
    let attempts = 0;

    const result = await retryPathfinding(
        bot,
        async () => { attempts++; }
    );

    assert.equal(result, false);
    assert.equal(attempts, 0);
    assert.equal(bot._bobBrainLocalRetryDepth, undefined);
});

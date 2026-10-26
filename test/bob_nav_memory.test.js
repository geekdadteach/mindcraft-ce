import test from 'node:test';
import assert from 'node:assert/strict';
import {
    UnreachableMemory,
    chooseCollectTarget,
    coordCellKey,
    createUnreachableError,
    decidePathStrategy,
    formatProbeTelemetry,
    isNoPathError,
    shouldFailFast,
    tryCollectCandidates
} from '../src/agent/library/bob_nav_memory.js';

test('blacklist remembers a block and expires after the TTL', () => {
    let now = 1_000_000;
    const memory = new UnreachableMemory({
        now: () => now,
        ttlMs: 15 * 60_000
    });
    const oak = { x: 10, y: 64, z: 20 };

    assert.equal(memory.isUnreachableBlock(oak), false);
    memory.rememberBlock(oak);
    assert.equal(memory.isUnreachableBlock(oak), true);
    assert.equal(memory.isUnreachableBlock({ x: 11, y: 64, z: 20 }), false);

    now += 14 * 60_000;
    assert.equal(memory.isUnreachableBlock(oak), true);

    now += 2 * 60_000;
    assert.equal(memory.isUnreachableBlock(oak), false);
});

test('coordinate cells cover nearby goToCoordinates with a TTL', () => {
    let now = 1_000_000;
    const memory = new UnreachableMemory({
        now: () => now,
        ttlMs: 20 * 60_000
    });

    memory.rememberCell(-800.2, 70.1, 500.4);
    assert.equal(coordCellKey(-800.2, 70.1, 500.4), coordCellKey(-801, 70, 499));
    assert.equal(memory.isUnreachableCell(-801, 70, 499), true);
    assert.equal(memory.isUnreachableGoal(-801, 70, 499), true);
    assert.equal(memory.isUnreachableCell(-820, 70, 540), false);

    now += 21 * 60_000;
    assert.equal(memory.isUnreachableGoal(-801, 70, 499), false);
});

test('collectBlock skips an unreachable block and tries the next candidate', async () => {
    const memory = new UnreachableMemory({ now: () => 1_000_000 });
    const first = { name: 'oak_log', position: { x: -810, y: 124, z: 540 } };
    const second = { name: 'oak_log', position: { x: -805, y: 124, z: 530 } };
    const attempted = [];

    memory.rememberBlock(first.position);
    assert.equal(chooseCollectTarget([first, second], memory), second);

    const result = await tryCollectCandidates(
        [first, second],
        async (block) => {
            attempted.push(`${block.position.x},${block.position.z}`);
            if (block === first) {
                throw Object.assign(new Error('No path to the goal!'), { name: 'NoPath' });
            }
        },
        memory
    );

    assert.equal(result.ok, true);
    assert.equal(result.block, second);
    assert.deepEqual(attempted, ['-805,530']);
});

test('collectBlock remembers a NoPath block and moves on', async () => {
    const memory = new UnreachableMemory({ now: () => 1_000_000 });
    const first = { name: 'oak_log', position: { x: 1, y: 64, z: 1 } };
    const second = { name: 'oak_log', position: { x: 8, y: 64, z: 8 } };
    const attempted = [];

    const result = await tryCollectCandidates(
        [first, second],
        async (block) => {
            attempted.push(block.position.x);
            if (block === first) {
                throw Object.assign(new Error('No path to the goal!'), { name: 'NoPath' });
            }
        },
        memory
    );

    assert.equal(result.ok, true);
    assert.equal(result.block, second);
    assert.deepEqual(attempted, [1, 8]);
    assert.equal(memory.isUnreachableBlock(first.position), true);
    assert.equal(memory.isUnreachableBlock(second.position), false);
});

test('fail-fast on double noPath does not goto or retry', () => {
    const nonDestructive = { status: 'noPath', visitedNodes: 40 };
    const destructive = { status: 'noPath', visitedNodes: 55 };

    assert.equal(shouldFailFast(nonDestructive, destructive), true);
    assert.deepEqual(
        decidePathStrategy(nonDestructive, destructive),
        { action: 'fail', reason: 'unreachable' }
    );
    assert.match(
        formatProbeTelemetry(nonDestructive, destructive),
        /nonDestructive=status=noPath visitedNodes=40; destructive=status=noPath visitedNodes=55/
    );

    let gotoCalls = 0;
    const strategy = decidePathStrategy(nonDestructive, destructive);
    if (strategy.action !== 'fail')
        gotoCalls++;
    assert.equal(gotoCalls, 0);

    const err = createUnreachableError('no path to the goal');
    assert.equal(isNoPathError(err), true);
    assert.match(err.message, /unreachable/);
});

test('a successful probe still goes and may retry', () => {
    assert.deepEqual(
        decidePathStrategy({ status: 'success', visitedNodes: 8 }, null),
        { action: 'goto', movements: 'nonDestructive', retry: true }
    );
    assert.deepEqual(
        decidePathStrategy(
            { status: 'timeout', visitedNodes: 200 },
            { status: 'success', visitedNodes: 30 }
        ),
        { action: 'goto', movements: 'destructive', retry: true }
    );
    assert.equal(
        shouldFailFast(
            { status: 'timeout' },
            { status: 'noPath' }
        ),
        false
    );
});

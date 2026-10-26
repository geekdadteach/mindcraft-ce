import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BobBrain,
    failureFingerprint
} from '../src/agent/library/bob_brain.js';

test('fingerprints ignore position and search distance', () => {
    assert.equal(
        failureFingerprint(
            'search:cow', 'Could not find any cow in 128 blocks'
        ),
        failureFingerprint(
            'search:cow', 'Could not find any cow in 64 blocks'
        )
    );

    assert.notEqual(
        failureFingerprint('collect:stone', 'no stone nearby'),
        failureFingerprint('collect:stone', 'pickaxe broke')
    );

    assert.equal(
        failureFingerprint('path:noPath', 'No path to the goal!'),
        failureFingerprint('path:noPath', 'noPath')
    );
});

function fixture() {
    let now = 1_000_000;
    let sequence = 0;
    const posts = [];

    const brain = new BobBrain({
        enabled: true,
        reason: 'test',
        url: 'http://127.0.0.1:8765',
        token: 'T'.repeat(40)
    }, {
        now: () => now,
        repeatThreshold: 1,
        failureGapMs: 0,
        failureCooldownMs: 0,
        failureSignatureMs: 30 * 60_000,
        eventRate: 100,
        eventDedupeMs: 0,
        env: {},
        log: { log() {}, warn() {} },
        fetchImpl: async (url, request) => {
            const path = new URL(url).pathname;
            const body = JSON.parse(request.body);
            posts.push({ path, body });

            return {
                ok: true,
                status: 201,
                text: async () => JSON.stringify(
                    path === '/v1/jobs'
                        ? { job: { id: `job-${++sequence}` } }
                        : { ok: true }
                )
            };
        }
    });

    return {
        brain,
        posts,
        advance(ms) { now += ms; },
        count(path) {
            return posts.filter(p => p.path === path).length;
        }
    };
}

test('same failure at another location is suppressed for 30 minutes', async () => {
    const f = fixture();

    const failure = (x, text = 'Could not find any cow nearby') =>
        f.brain.noteFailure({
            kind: 'search:cow',
            observed_failure: text,
            position: { x, y: 64, z: x }
        });

    assert.equal((await failure(10)).ok, true);

    f.advance(10 * 60_000);
    assert.equal(
        (await failure(150)).reason,
        'fingerprint_cooldown'
    );

    assert.equal(f.count('/v1/jobs'), 1);
    assert.equal(f.count('/v1/events'), 1);

    assert.equal(
        f.brain.counters.failure_signatures_suppressed, 1
    );
    assert.equal(
        f.brain.counters.failure_events_suppressed, 1
    );

    // A different failure cause must not be suppressed.
    assert.equal(
        (await failure(151, 'Cow escaped from pen')).ok,
        true
    );
    assert.equal(f.count('/v1/jobs'), 2);

    f.advance(21 * 60_000);
    assert.equal((await failure(240)).ok, true);
    assert.equal(f.count('/v1/jobs'), 3);

    f.brain.stop();
});

test('pathfinding repeats across locations are suppressed', async () => {
    const f = fixture();

    assert.equal(
        (await f.brain.notePathFailure({
            reason: 'noPath',
            position: { x: 1, y: 64, z: 1 }
        })).ok,
        true
    );

    f.advance(10 * 60_000);

    assert.equal(
        (await f.brain.notePathFailure({
            reason: 'No path to the goal!',
            position: { x: 90, y: 64, z: 90 }
        })).reason,
        'fingerprint_cooldown'
    );

    assert.equal(f.count('/v1/jobs'), 1);
    assert.equal(f.count('/v1/events'), 1);

    f.brain.stop();
});

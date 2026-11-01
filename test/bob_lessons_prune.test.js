// [ai-player] Fix 4.13 - the lessons list is capped and keeps the highest-value lessons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LESSONS, lessonValue, pruneLessons } from '../src/agent/library/long_memory.js';

test('pruneLessons caps the list and keeps the highest-value lessons', () => {
    const mk = (key, { kind = 'fail', count = 1, last = 0 } = {}) => ({ key, text: key, kind, count, last });
    const lessons = [];
    for (let i = 0; i < 200; i++) lessons.push(mk('fail:' + i, { count: 1, last: i }));
    lessons.push(mk('seed:pickaxe', { kind: 'seed', count: 1, last: 0 }));
    lessons.push(mk('hot:path', { kind: 'fail', count: 99, last: 0 }));
    const kept = pruneLessons(lessons);
    assert.equal(kept.length, MAX_LESSONS, 'capped');
    const keys = new Set(kept.map(l => l.key));
    assert.ok(keys.has('seed:pickaxe'), 'the seed survived');
    assert.ok(keys.has('hot:path'), 'the high-count lesson survived');
    assert.equal(keys.has('fail:0'), false, 'the oldest lowest-value lesson was dropped');
    assert.equal(lessons.length, 202, 'the input is not mutated');
});

test('pruneLessons leaves a short list alone and handles junk input', () => {
    const short = [{ key: 'a', kind: 'fail', count: 1, last: 1 }];
    assert.deepEqual(pruneLessons(short), short, 'under the cap: unchanged content');
    assert.deepEqual(pruneLessons(null), [], 'null input');
    assert.equal(MAX_LESSONS, 150);
    assert.equal(lessonValue({ kind: 'seed' }), 1);
    assert.equal(lessonValue({ kind: 'fail' }), 0);
});


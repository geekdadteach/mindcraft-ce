// [ai-player] Fix 4.13 - the lessons list is capped and keeps the highest-value lessons.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_LESSONS, lessonValue, pruneLessons, LongMemory } from '../src/agent/library/long_memory.js';

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


test('pruning archives the dropped lessons and keeps the new one', () => {
    const name = 'lessons-prune-test-' + process.pid;
    const dir = path.join('.', 'bots', name);
    fs.rmSync(dir, { recursive: true, force: true });
    try {
        const lm = new LongMemory({ name });
        const lastKey = 't:' + (MAX_LESSONS + 40);
        for (let i = 0; i <= MAX_LESSONS + 40; i++) lm._addLesson('t:' + i, 'lesson ' + i, 'fail', false);
        const lessons = lm.lessons.data.lessons;
        assert.equal(lessons.length, MAX_LESSONS, 'capped');
        assert.ok(lessons.some(x => x.key === lastKey), 'the lesson just added is kept');
        const archive = path.join(dir, 'lessons.pruned.jsonl');
        assert.ok(fs.existsSync(archive), 'lessons.pruned.jsonl is next to lessons.json');
        const lines = fs.readFileSync(archive, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
        assert.ok(lines.length > 0, 'the dropped lessons were archived');
        assert.ok(lines.every(l => l.text && Number.isFinite(l.prunedAt)), 'each archived line records the lesson and when');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});


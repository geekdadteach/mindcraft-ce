// [ai-player] Fix 4.10 - a throwing entity.metadata getter logs once (rate-limited) and names the entity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMetadata, isHuntable } from '../src/utils/mcdata.js';

test('readMetadata logs once (rate-limited) for a throwing getter and names the entity', () => {
    const logs = [];
    const entity = { name: 'cow' };
    Object.defineProperty(entity, 'metadata', { get() { throw new Error('read error'); } });
    const now = () => 1e12;
    const warn = (m) => logs.push(m);
    assert.equal(readMetadata(entity, { now, windowMs: 60000, warn }), null);
    assert.equal(readMetadata(entity, { now, windowMs: 60000, warn }), null);
    assert.equal(logs.length, 1, 'logged once inside the window');
    assert.match(logs[0], /cow/);
    assert.match(logs[0], /read error/);
});

test('readMetadata returns the metadata when it reads fine and never throws', () => {
    assert.deepEqual(readMetadata({ name: 'cow', metadata: { 16: false } }), { 16: false });
    assert.equal(readMetadata(null), null);
    assert.equal(readMetadata({ name: 'cow', metadata: null }), null);
});

test('isHuntable survives a throwing metadata getter', () => {
    const entity = { name: 'cow', type: 'mob' };
    Object.defineProperty(entity, 'metadata', { get() { throw new Error('read error'); } });
    assert.equal(isHuntable(entity), true, 'an adult cow with unreadable metadata is still huntable');
});


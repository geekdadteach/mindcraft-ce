import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { botGetBlock, isVec3Like, strictBlockAt, vec3 } from '../src/agent/library/vec3_util.js';
import { HomesteadTracker } from '../src/agent/library/bob_homestead.js';
import { claimProperty } from '../src/agent/library/bob_claim_protect.js';
import { HomeRegistry } from '../src/agent/library/bob_home.js';

test('plain objects are rejected by Vec3-strict blockAt', () => {
    const at = strictBlockAt(() => ({ name: 'air' }));
    assert.throws(() => at({ x: 1, y: 2, z: 3 }), /Vec3/);
    assert.throws(() => at(null), /Vec3/);
    const p = vec3(-1120, 68, 734);
    assert.equal(isVec3Like(p), true);
    assert.equal(at(p).name, 'air');
});

test('botGetBlock always passes a Vec3 into bot.blockAt', () => {
    const seen = [];
    const bot = { blockAt: strictBlockAt((x, y, z) => { seen.push([x, y, z]); return { name: 'grass_block' }; }) };
    const getBlock = botGetBlock(bot);
    assert.equal(getBlock(-1120, 68, 734).name, 'grass_block');
    assert.deepEqual(seen, [[-1120, 68, 734]]);
    assert.throws(() => bot.blockAt({ x: -1120, y: 68, z: 734 }), /Vec3/);
});

test('HomesteadTracker.observe uses Vec3 for bot.blockAt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-'));
    const bot = { blockAt: strictBlockAt(() => ({ name: 'air', boundingBox: 'empty' })) };
    const tracker = new HomesteadTracker({ name: 't', bot }, { file: path.join(dir, 'homestead.json') });
    assert.doesNotThrow(() => tracker.observe({ position: { x: -1120, y: 68, z: 736 } }));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('HomeRegistry.observeWorld uses Vec3-strict blockAt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3h-'));
    const bot = { blockAt: strictBlockAt(() => ({ name: 'air', boundingBox: 'empty' })) };
    const registry = new HomeRegistry({ name: 't' }, { file: path.join(dir, 'verified_home.json') });
    const getBlock = botGetBlock(bot);
    assert.doesNotThrow(() => registry.observeWorld(getBlock, { x: -1120, y: 68, z: 736 }, { requireOwned: true }));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('claimProperty blockAt path rejects plain objects and uses Vec3', async () => {
    const seen = [];
    const bot = {
        blockAt: strictBlockAt((x, y, z) => {
            seen.push([x, y, z]);
            return {
                name: y < 65 ? 'grass_block' : 'air',
                boundingBox: y < 65 ? 'block' : 'empty',
                x, y, z,
            };
        }),
        activateBlock: async () => {},
        on() {},
        removeListener() {},
        entity: { position: { x: -1208, y: 65, z: 688 } },
    };
    const result = await claimProperty({ name: 'MineBobNE', bot }, {
        approved: true,
        goto: async () => true,
        equip: async () => {},
        chat: () => {},
        wait: async () => {},
    });
    assert.equal(result.refused, undefined);
    assert.ok(seen.length >= 2, 'looked up corner blocks via Vec3');
    assert.throws(() => bot.blockAt({ x: -1208, y: 65, z: 688 }), /Vec3/);
});

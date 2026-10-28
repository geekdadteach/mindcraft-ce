import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAIM_PLUGIN, claimCorners, claimProperty, parseClaimsList } from '../src/agent/library/bob_claim_protect.js';
import { claimBounds } from '../src/agent/library/bob_claim.js';
import { ResetRecovery, readRequest } from '../src/agent/library/reset_recovery.js';

test('GriefPrevention helper uses the 128x128 corners and is not an auto-claim', () => {
    const b = claimBounds();
    assert.deepEqual(claimCorners(), [{ x: b.x1, z: b.z1 }, { x: b.x2, z: b.z2 }]);
    assert.equal(CLAIM_PLUGIN.name, 'GriefPrevention');
    assert.match(CLAIM_PLUGIN.tool, /golden_shovel/);
    assert.equal(CLAIM_PLUGIN.listCommand, '/claimslist');
    assert.ok(CLAIM_PLUGIN.adminFallback.includes('/adminclaims'));
});

test('parseClaimsList requires corner pairs, not scattered digits', () => {
    const b = claimBounds();
    const miss = parseClaimsList('You have 1 claim near spawn.');
    assert.equal(miss.coversClaim, false);
    const scattered = parseClaimsList(`unrelated ${b.x1} and later ${b.z1} then ${b.x2} ${b.z2} apart`);
    assert.equal(scattered.coversClaim, false);
    const hit = parseClaimsList(`MineBobNE claim ${b.x1}, 65, ${b.z1} to ${b.x2}, 65, ${b.z2}`);
    assert.equal(hit.coversClaim, true);
    assert.equal(hit.mentionsUser, true);
});

test('claimProperty refuses without approved:true', async () => {
    const result = await claimProperty({ name: 'MineBobNE', bot: {} }, { goto: async () => true });
    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
});

test('claimProperty walks to both corners then clicks existing surface blocks', async () => {
    const clicks = [];
    const walks = [];
    const chats = [];
    const b = claimBounds();
    const result = await claimProperty({ name: 'MineBobNE', bot: { on() {}, removeListener() {} } }, {
        approved: true,
        getBlock: (x, y, z) => ({ name: y < 65 ? 'grass_block' : 'air', boundingBox: y < 65 ? 'block' : 'empty', x, y, z }),
        activateBlock: async (blk) => { clicks.push([blk.x, blk.z]); },
        equip: async () => {},
        chat: (m) => chats.push(m),
        goto: async (x, y, z) => { walks.push([x, z]); return true; },
        wait: async () => {},
    });
    assert.equal(walks.length, 2);
    assert.deepEqual(walks[0], [b.x1, b.z1]);
    assert.deepEqual(walks[1], [b.x2, b.z2]);
    assert.equal(clicks.length, 2);
    assert.deepEqual(chats, ['/claimslist']);
    assert.match(result.approval, /Randy/);
});

test('claimProperty does not click a missing block', async () => {
    const clicks = [];
    const result = await claimProperty({ name: 'MineBobNE', bot: { on() {}, removeListener() {} } }, {
        approved: true,
        getBlock: () => null,
        activateBlock: async (blk) => { clicks.push(blk); },
        goto: async () => true,
        wait: async () => {},
    });
    assert.equal(clicks.length, 0);
    assert.ok(result.steps.some((s) => /no surface|no solid/.test(s)));
});

test('inbox kind claim-property requires approved:true', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
    const agent = {
        name: 'MineBobNE',
        bot: { on() {}, removeListener() {}, blockAt: () => null },
        history: { async add() {}, async save() {} },
        escape: { gotoChecked: async () => true },
    };
    const rr = new ResetRecovery(agent, { inboxDir: dir });
    const f = path.join(dir, 'claim.json');
    fs.writeFileSync(f, JSON.stringify({ v: 1, kind: 'claim-property', reason: 'please', by: 'operator', ts: 1 }), { mode: 0o600 });
    const req = readRequest(f);
    assert.equal(req.kind, 'claim-property');
    assert.equal(req.approved, false);
    assert.match(await rr.handle(req), /approved:true/);
    fs.writeFileSync(f, JSON.stringify({ v: 1, kind: 'claim-property', reason: 'approved', by: 'randy', ts: 1, approved: true }), { mode: 0o600 });
    const req2 = readRequest(f);
    assert.equal(req2.approved, true);
    const result = await rr.handle(req2);
    assert.match(String(result), /Randy|claim-property|covers claim|unconfirmed/);
    const src = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /claimProperty\(/);
    fs.rmSync(dir, { recursive: true, force: true });
});

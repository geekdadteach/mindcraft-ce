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

test('parseClaimsList detects coverage of the planned rectangle', () => {
    const b = claimBounds();
    const miss = parseClaimsList('You have 1 claim near spawn.');
    assert.equal(miss.coversClaim, false);
    const hit = parseClaimsList(`MineBobNE claim ${b.x1} ${b.z1} to ${b.x2} ${b.z2}`);
    assert.equal(hit.coversClaim, true);
    assert.equal(hit.mentionsUser, true);
});

test('claimProperty only runs when invoked and clicks both corners', async () => {
    const clicks = [];
    const chats = [];
    const result = await claimProperty({ name: 'MineBobNE', bot: { on() {}, removeListener() {} } }, {
        getBlock: (x, y, z) => ({ name: y < 65 ? 'grass_block' : 'air', boundingBox: y < 65 ? 'block' : 'empty', x, y, z }),
        activateBlock: async (b) => { clicks.push([b.x, b.z]); },
        equip: async () => {},
        chat: (m) => chats.push(m),
        wait: async () => {},
    });
    assert.equal(clicks.length, 2);
    assert.deepEqual(clicks[0], [claimCorners()[0].x, claimCorners()[0].z]);
    assert.deepEqual(clicks[1], [claimCorners()[1].x, claimCorners()[1].z]);
    assert.deepEqual(chats, ['/claimslist']);
    assert.match(result.approval, /Randy/);
});

test('inbox kind claim-property is operator-triggered and not automatic', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
    const clicks = [];
    const agent = {
        name: 'MineBobNE',
        bot: {
            on() {},
            removeListener() {},
            blockAt: (p) => ({ name: (p?.y ?? 0) < 65 ? 'grass_block' : 'air', boundingBox: (p?.y ?? 0) < 65 ? 'block' : 'empty', ...p }),
            activateBlock: async (b) => { clicks.push([b.x, b.z]); },
        },
        history: { async add() {}, async save() {} },
    };
    const rr = new ResetRecovery(agent, { inboxDir: dir });
    const f = path.join(dir, 'claim.json');
    fs.writeFileSync(f, JSON.stringify({ v: 1, kind: 'claim-property', reason: 'approved', by: 'operator', ts: 1 }), { mode: 0o600 });
    const req = readRequest(f);
    assert.equal(req.kind, 'claim-property');
    const result = await rr.handle(req);
    assert.match(String(result), /Randy|claim-property|covers claim|unconfirmed/);
    assert.equal(clicks.length, 2);
    const src = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /claimProperty\(/);
    fs.rmSync(dir, { recursive: true, force: true });
});

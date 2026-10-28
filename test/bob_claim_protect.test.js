import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    CLAIM_PLUGIN, LIST_WAIT_MS, claimCorners, claimProperty, gpClaimsListOutput, holdingGoldenShovel,
    isGpClaimsListReply, parseClaimsList, parseGpClaimLine,
} from '../src/agent/library/bob_claim_protect.js';
import { claimArea, claimBounds } from '../src/agent/library/bob_claim.js';
import { ResetRecovery, readRequest } from '../src/agent/library/reset_recovery.js';
import { CLAIMS_LIST_CMD, installChatGuard, sendFixedClaimsListCommand } from '../src/agent/library/chat_guard.js';

const b = claimBounds();
const area = claimArea();

function gp128() {
    return gpClaimsListOutput([
        { world: 'world', x: b.x1, z: b.z1, area },
        { world: 'world', x: -827, z: 559, area: 135 },
    ]);
}

function gpNone() {
    return gpClaimsListOutput([]);
}

function gpOther() {
    return gpClaimsListOutput([{ world: 'world', x: -827, z: 559, area: 135 }]);
}

function shovelBot(extra = {}) {
    const listeners = [];
    const bot = {
        heldItem: { name: 'golden_shovel' },
        inventory: { slots: [{ name: 'golden_shovel' }], items: () => [{ name: 'golden_shovel' }] },
        async equip(item) { this.heldItem = item; },
        async activateBlock() {},
        on(ev, fn) { listeners.push([ev, fn]); },
        removeListener() {},
        emit(ev, ...args) { for (const [e, fn] of listeners) if (e === ev) fn(...args); },
        ...extra,
    };
    return bot;
}

test('GriefPrevention helper uses the 128x128 corners and is not an auto-claim', () => {
    assert.deepEqual(claimCorners(), [{ x: b.x1, z: b.z1 }, { x: b.x2, z: b.z2 }]);
    assert.equal(CLAIM_PLUGIN.name, 'GriefPrevention');
    assert.match(CLAIM_PLUGIN.tool, /golden_shovel/);
    assert.equal(CLAIM_PLUGIN.listCommand, '/claimslist');
    assert.ok(CLAIM_PLUGIN.adminFallback.includes('/adminclaims'));
    assert.equal(area, 16384);
});

test('parseClaimsList reads GP 16.18.7 lesser-corner plus area, not both corners', () => {
    const miss = parseClaimsList('You have 1 claim near spawn.');
    assert.equal(miss.coversClaim, false);

    const scattered = parseClaimsList(`unrelated ${b.x1} and later ${b.z1} then ${b.x2} ${b.z2} apart`);
    assert.equal(scattered.coversClaim, false);

    const oldOnly = parseClaimsList(gpClaimsListOutput([{ world: 'world', x: -827, z: 559, area: 135 }]));
    assert.equal(oldOnly.coversClaim, false);
    assert.equal(oldOnly.claims.length, 1);

    const fakePairs = parseClaimsList(`MineBobNE claim ${b.x1}, 65, ${b.z1} to ${b.x2}, 65, ${b.z2}`);
    assert.equal(fakePairs.coversClaim, false, 'the old pair-on-line fixture is not the live GP format');

    const real = parseClaimsList(gp128());
    assert.equal(real.coversClaim, true);
    assert.equal(real.matching.x, b.x1);
    assert.equal(real.matching.z, b.z1);
    assert.equal(real.matching.area, 16384);
    assert.equal(real.claims.length, 2);

    const lesserWrongArea = parseClaimsList(gpClaimsListOutput([{ world: 'world', x: b.x1, z: b.z1, area: 135 }]));
    assert.equal(lesserWrongArea.coversClaim, false);
    assert.equal(lesserWrongArea.lesserMatches, true);
    assert.equal(lesserWrongArea.areaMatches, false);

    const parsed = parseGpClaimLine('world: x-1208, z688 (-16384 blocks)');
    assert.deepEqual(parsed, { world: 'world', x: -1208, z: 688, area: 16384, line: 'world: x-1208, z688 (-16384 blocks)' });

    assert.equal(parseGpClaimLine('world_nether: x-1208, z688 (-16384 blocks)'), null);
    assert.equal(parseGpClaimLine('world_the_end: x-1208, z688 (-16384 blocks)'), null);
    const nether = parseClaimsList(gpClaimsListOutput([
        { world: 'world_nether', x: b.x1, z: b.z1, area },
        { world: 'world_the_end', x: b.x1, z: b.z1, area },
    ]));
    assert.equal(nether.claims.length, 0);
    assert.equal(nether.coversClaim, false);
    assert.equal(isGpClaimsListReply(gpNone()), true);
    assert.equal(isGpClaimsListReply(''), false);
    assert.equal(LIST_WAIT_MS, 5000);
});

test('claimProperty refuses without approved:true', async () => {
    const result = await claimProperty({ name: 'MineBobNE', bot: shovelBot() }, { goto: async () => true });
    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
});

test('existing covering claim is success and does nothing', async () => {
    const clicks = [];
    const walks = [];
    const chats = [];
    const bot = shovelBot({ heldItem: { name: 'dirt' }, inventory: { slots: [], items: () => [] } });
    const result = await claimProperty({ name: 'MineBobNE', bot }, {
        approved: true,
        activateBlock: async (blk) => { clicks.push(blk); },
        goto: async (x, y, z) => { walks.push([x, z]); return true; },
        chat: (m) => { chats.push(m); bot.emit('messagestr', gp128()); },
        wait: async () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyExists, true);
    assert.equal(clicks.length, 0);
    assert.equal(walks.length, 0);
    assert.deepEqual(chats, ['/claimslist']);
    assert.match(result.steps[0], /nothing to do/);
});

test('claimProperty aborts before clicking without a golden shovel in hand', async () => {
    const clicks = [];
    const walks = [];
    const bot = shovelBot({ heldItem: { name: 'dirt' }, inventory: { slots: [], items: () => [] } });
    const result = await claimProperty({ name: 'MineBobNE', bot }, {
        approved: true,
        getBlock: (x, y, z) => ({ name: y < 65 ? 'grass_block' : 'air', boundingBox: y < 65 ? 'block' : 'empty', x, y, z }),
        activateBlock: async (blk) => { clicks.push(blk); },
        equip: async () => {},
        chat: () => { bot.emit('messagestr', gpNone()); },
        goto: async (x, y, z) => { walks.push([x, z]); return true; },
        wait: async () => {},
    });
    assert.equal(result.aborted, true);
    assert.equal(clicks.length, 0);
    assert.equal(walks.length, 0);
    assert.ok(result.steps.some((s) => /golden_shovel is not in hand/.test(s)));
});

test('fallback create walks to both corners then clicks with a shovel', async () => {
    const clicks = [];
    const walks = [];
    const chats = [];
    const bot = shovelBot();
    let lists = 0;
    const result = await claimProperty({ name: 'MineBobNE', bot }, {
        approved: true,
        getBlock: (x, y, z) => ({ name: y < 65 ? 'grass_block' : 'air', boundingBox: y < 65 ? 'block' : 'empty', x, y, z }),
        activateBlock: async (blk) => { clicks.push([blk.x, blk.z]); },
        equip: async () => { bot.heldItem = { name: 'golden_shovel' }; },
        chat: (m) => {
            chats.push(m);
            lists += 1;
            bot.emit('messagestr', lists === 1 ? gpOther() : gp128());
        },
        goto: async (x, y, z) => { walks.push([x, z]); return true; },
        wait: async () => {},
    });
    assert.equal(holdingGoldenShovel(bot), true);
    assert.equal(walks.length, 2);
    assert.deepEqual(walks[0], [b.x1, b.z1]);
    assert.deepEqual(walks[1], [b.x2, b.z2]);
    assert.equal(clicks.length, 2);
    assert.deepEqual(chats, ['/claimslist', '/claimslist']);
    assert.equal(result.ok, true);
    assert.equal(result.alreadyExists, undefined);
    assert.equal(result.claimsList.matching.area, 16384);
    assert.match(result.approval, /Randy/);
});

test('claimProperty does not click a missing block', async () => {
    const clicks = [];
    const bot = shovelBot();
    const result = await claimProperty({ name: 'MineBobNE', bot }, {
        approved: true,
        getBlock: () => null,
        activateBlock: async (blk) => { clicks.push(blk); },
        goto: async () => true,
        wait: async () => {},
        chat: () => { bot.emit('messagestr', gpNone()); },
    });
    assert.equal(clicks.length, 0);
    assert.ok(result.steps.some((s) => /no surface|no solid/.test(s)));
});

test('chat guard allows /claimslist only through the helper sender', () => {
    const sent = [];
    const bot = { _client: { chat: (m) => sent.push(m) } };
    bot.chat = (m) => bot._client.chat(m);
    assert.equal(installChatGuard(bot, () => {}), true);
    bot.chat('/claimslist');
    assert.deepEqual(sent, []);
    assert.equal(sendFixedClaimsListCommand(bot), CLAIMS_LIST_CMD);
    assert.deepEqual(sent, ['/claimslist']);
});

test('inbox kind claim-property requires approved:true and wires bot functions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
    const clicks = [];
    const chats = [];
    const bot = shovelBot({
        heldItem: { name: 'dirt' },
        inventory: { slots: [], items: () => [] },
        async activateBlock(blk) { clicks.push(blk); },
    });
    const agent = {
        name: 'MineBobNE',
        bot,
        history: { async add() {}, async save() {} },
        escape: { gotoChecked: async () => true },
    };
    const rr = new ResetRecovery(agent, { inboxDir: dir, wait: async () => {} });
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
    assert.match(String(result), /reply unknown/);
    assert.doesNotMatch(String(result), /fallback create/);
    assert.equal(clicks.length, 0, 'inbox path must not click with dirt in hand');
    assert.equal(chats.length, 0);

    const src = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /claimProperty\(/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('late or unrecognized /claimslist is unknown abort, never create', async () => {
    const clicks = [];
    const walks = [];
    const bot = shovelBot();
    const result = await claimProperty({ name: 'MineBobNE', bot }, {
        approved: true,
        getBlock: (x, y, z) => ({ name: y < 65 ? 'grass_block' : 'air', boundingBox: y < 65 ? 'block' : 'empty', x, y, z }),
        activateBlock: async (blk) => { clicks.push(blk); },
        goto: async (x, y, z) => { walks.push([x, z]); return true; },
        wait: async () => {},
        chat: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.equal(clicks.length, 0);
    assert.equal(walks.length, 0);
    assert.match(result.steps[0], /reply unknown/);
    assert.equal(result.alreadyExists, undefined);
});

test('nether covering line is ignored so overworld is not treated as claimed', async () => {
    const clicks = [];
    const bot = shovelBot({ heldItem: { name: 'dirt' }, inventory: { slots: [], items: () => [] } });
    const result = await claimProperty({ name: 'MineBobNE', bot }, {
        approved: true,
        activateBlock: async (blk) => { clicks.push(blk); },
        goto: async () => true,
        wait: async () => {},
        chat: () => {
            bot.emit('messagestr', gpClaimsListOutput([
                { world: 'world_nether', x: b.x1, z: b.z1, area },
            ]));
        },
        equip: async () => {},
    });
    assert.equal(result.claimsList.coversClaim, false);
    assert.equal(result.alreadyExists, undefined);
    assert.ok(result.steps.some((s) => /fallback create/.test(s)));
    assert.ok(result.aborted);
    assert.equal(clicks.length, 0);
});

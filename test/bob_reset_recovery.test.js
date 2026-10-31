import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDetector, resetLesson, readRequest, ResetRecovery, TELEPORT_NOTE } from '../src/agent/library/reset_recovery.js';
import { emptyHome, exampleVerifiedHome, setActiveHome } from '../src/agent/library/bob_home.js';

const fixture = exampleVerifiedHome();
const door = { ...fixture.entrance };
test('teleport onto a non-home location does not fire without a verified entrance', () => {
    setActiveHome(emptyHome());
    const d = createDetector({ target: () => null });
    assert.equal(d.feed(0, { x: -840, y: 115, z: 553 }, 'action:collectBlocks'), null);
    assert.equal(d.feed(500, { x: -1144, y: 65, z: 752 }), null);
});

test('teleport onto the door plate triggers once, then cooldown', () => {
    const d = createDetector({ target: door });
    assert.equal(d.feed(0, { x: -840, y: 115, z: 553 }, 'action:collectBlocks'), null);
    const hit = d.feed(500, door);
    assert.ok(hit && !hit.suppressed);
    assert.equal(hit.fromAction, 'action:collectBlocks');
    d.feed(1000, { x: -900, y: 70, z: 600 });
    assert.equal(d.feed(1500, door).suppressed, 'cooldown');
    d.feed(200000, { x: -900, y: 70, z: 600 });
    assert.ok(d.feed(200500, door).moved > 20);
});
test('walking to the door, bed respawn and far teleports do not trigger', () => {
    const d = createDetector();
    let t = 0;
    for (let z = 530; z <= 565.5; z += 2) assert.equal(d.feed(t += 500, { x: -819.5, y: 124, z }), null);
    const d2 = createDetector();
    d2.feed(0, { x: -700, y: 60, z: 400 });
    assert.equal(d2.feed(500, { x: -822, y: 124, z: 569 }), null, 'bed respawn spot is not the door');
    const d3 = createDetector();
    d3.feed(0, { x: -700, y: 60, z: 400 });
    assert.equal(d3.feed(5000, door), null, 'samples more than 3 s apart');
});
test('lesson key/text match the .60 watcher format', () => {
    const l = resetLesson({ x: -840.2, y: 115, z: 553.6 }, 'action:collectBlocks');
    assert.equal(l.key, 'reset:collectBlocks');
    assert.equal(l.text, 'Got stuck and needed a reset near -840 115 554 while doing collectBlocks; if an action keeps failing there, move elsewhere or switch task sooner.');
    assert.equal(resetLesson(null, 'mode:night').key, 'reset:night');
    assert.equal(resetLesson(null, '').key, 'reset:unknown');
});
function fakeAgent() {
    const a = { turns: [], lessons: [], saved: 0, stopped: 0, label: 'action:collectBlocks', pos: { x: -830, y: 100, z: 560 } };
    a.agent = {
        bot: { entity: { get position() { return a.pos; } }, on() {} },
        actions: { get currentActionLabel() { return a.label; }, cancelResume() {}, async stop() { a.stopped++; } },
        history: { async add(r, c) { a.turns.push([r, c]); }, async save() { a.saved++; } },
        longMemory: { _addLesson(k, t, kind) { a.lessons.push({ k, t, kind }); } },
    };
    return a;
}
test('teleport records note + lesson and stops the action, no restart', async () => {
    const f = fakeAgent(); let t = 0;
    f.agent.homeState = { snapshot: () => fixture };
    setActiveHome(fixture);
    const r = new ResetRecovery(f.agent, { inboxDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rr-')), now: () => t });
    r.sample(); t = 500; f.pos = door; r.sample();
    await new Promise(res => setTimeout(res, 20));
    assert.deepEqual(f.turns, [['system', TELEPORT_NOTE]]);
    assert.equal(f.lessons[0].k, 'reset:collectBlocks');
    assert.equal(f.stopped, 1);
    assert.equal(f.saved, 1);
});
test('inbox: validates files, honors planned-restart only in a later process, moves to done', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
    const f = fakeAgent(); let t = 1000;
    const r = new ResetRecovery(f.agent, { inboxDir: dir, now: () => t });
    const w = (n, o, mode = 0o600) => { fs.writeFileSync(path.join(dir, n), JSON.stringify(o)); fs.chmodSync(path.join(dir, n), mode); };
    w('a.json', { v: 1, kind: 'planned-restart', reason: 'test', by: 't', ts: 5000 });
    w('b.json', { v: 1, kind: 'reset', reason: 'manual', by: 't' });
    w('c.json', { v: 1, kind: 'reset', by: 't' }, 0o666);
    w('d.json', { v: 2, kind: 'rm -rf' });
    await r.pollInbox();
    assert.ok(fs.existsSync(path.join(dir, 'a.json')), 'planned marker left for the next process');
    assert.ok(fs.existsSync(path.join(dir, 'done', 'b.json')));
    assert.match(fs.readFileSync(path.join(dir, 'done', 'c.result.json'), 'utf8'), /group\/other writable/);
    assert.match(fs.readFileSync(path.join(dir, 'done', 'd.result.json'), 'utf8'), /bad request/);
    assert.equal(f.lessons.length, 1);
    const r2 = new ResetRecovery(f.agent, { inboxDir: dir, now: () => 9000 });
    await r2.onSpawn();
    assert.ok(fs.existsSync(path.join(dir, 'done', 'a.json')));
    assert.match(f.turns.at(-1)[1], /restarted on purpose by the operator \(test\)/);
    assert.equal(f.turns.filter(x => /reconnected after a restart/.test(x[1])).length, 0);
    const r3 = new ResetRecovery(f.agent, { inboxDir: dir, now: () => 99999 });
    await r3.onSpawn();
    assert.match(f.turns.at(-1)[1], /reconnected after a restart/);
});
test('readRequest rejects symlinks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
    fs.writeFileSync(path.join(dir, 'x'), '{}'); fs.symlinkSync(path.join(dir, 'x'), path.join(dir, 'l.json'));
    assert.throws(() => readRequest(path.join(dir, 'l.json')), /regular/);
});

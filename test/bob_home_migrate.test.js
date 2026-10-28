import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyHomeMigration, botLooksStopped, lessonMigration, planHomeMigration, probeBobRunning } from '../src/agent/library/bob_home_migrate.js';
import { backfillMissingEmbeddings, LongMemory } from '../src/agent/library/long_memory.js';

function write(dir, name, data) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
}

test('dry-run reports retirement and does not write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    write(dir, 'home_routes.json', { version: 1, routes: [{ id: 'seed-north', pts: [[-819.5, 123, 553.5], [-819.5, 124, 565.5]] }] });
    write(dir, 'places.json', { version: 1, places: [
        { type: 'house', kind: 'fixed', x: -823, y: 124, z: 568 },
        { type: 'oak_log', kind: 'block', x: -900, y: 70, z: 600 },
        { type: 'cow', kind: 'mob', x: -1100, y: 65, z: 740 },
    ] });
    write(dir, 'lessons.json', { version: 1, lessons: [
        { key: 'seed:home', text: 'Your house is at -823 124 568' },
        { key: 'seed:pickaxe', text: 'Mining needs a pickaxe' },
    ] });
    write(dir, 'memory.json', { memory: 'Trees to the west.', self_prompt: 'Go home to your house at -823 124 568 and sleep.', turns: [{ role: 'user', content: 'hi' }] });
    const plan = planHomeMigration(dir, { now: 1 });
    assert.ok(plan.actions.some((a) => a.file === 'home_routes.json'));
    assert.ok(plan.actions.some((a) => a.file === 'places.json'));
    const places = plan.actions.find((a) => a.file === 'places.json');
    assert.equal(places.write.places.length, 2);
    assert.ok(places.write.places.every((p) => p.type !== 'house'));
    const report = applyHomeMigration(plan, { apply: false });
    assert.equal(report.applied, false);
    assert.match(report.message, /dry-run/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'places.json'), 'utf8')).places.length, 3);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('apply backs up first then retires old-home items and keeps unrelated knowledge', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    write(dir, 'home_routes.json', { version: 1, routes: [{ id: 'a', pts: [[-820, 124, 565]] }] });
    write(dir, 'places.json', { version: 1, places: [
        { type: 'house', kind: 'fixed', x: -823, y: 124, z: 568 },
        { type: 'oak_log', kind: 'block', x: -900, y: 70, z: 600 },
    ] });
    write(dir, 'memory.json', { memory: 'You found coal.', self_prompt: 'Walk to -820 124 566 and live at the house.', turns: [] });
    const plan = planHomeMigration(dir, { now: 42, botStopped: true });
    const report = applyHomeMigration(plan, { apply: true, botStopped: true });
    assert.equal(report.applied, true);
    assert.ok(fs.existsSync(path.join(dir, 'migrations', 'home-42', 'places.json')));
    const places = JSON.parse(fs.readFileSync(path.join(dir, 'places.json'), 'utf8'));
    assert.deepEqual(places.places.map((p) => p.type), ['oak_log']);
    const routes = JSON.parse(fs.readFileSync(path.join(dir, 'home_routes.json'), 'utf8'));
    assert.equal(routes.home, null);
    assert.deepEqual(routes.routes, []);
    const mem = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
    assert.match(mem.self_prompt, /claim/);
    assert.doesNotMatch(mem.self_prompt, /-823/);
    assert.match(mem.memory, /coal/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('apply refuses unless the operator acknowledges the bot is stopped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    write(dir, 'places.json', { version: 1, places: [
        { type: 'house', kind: 'fixed', x: -823, y: 124, z: 568 },
    ] });
    const plan = planHomeMigration(dir, { now: 7, botStopped: false });
    assert.ok(plan.warnings.some((w) => /bot-stopped/.test(w)));
    const report = applyHomeMigration(plan, { apply: true, botStopped: false });
    assert.equal(report.applied, false);
    assert.match(report.message, /refused/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'places.json'), 'utf8')).places.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('lessonMigration retires seed:home and rewrites death, zone, and reset lessons', () => {
    assert.equal(lessonMigration({ key: 'seed:home', text: 'Your house is at -823 124 568' }).op, 'retire');
    const death = lessonMigration({ key: 'death:zombie', text: 'You died. At night stay inside the house near the door.' });
    assert.equal(death.op, 'rewrite');
    assert.match(death.text, /verified bed/);
    assert.doesNotMatch(death.text, /stay inside the house/i);
    const zone = lessonMigration({ key: 'zone:work', text: 'When idle, pick work near the homestead and chop wood.' });
    assert.equal(zone.op, 'rewrite');
    assert.match(zone.text, /reachable task/);
    const reset = lessonMigration({ key: 'reset:dig', text: 'Got stuck near -821 121 571 while digging.' });
    assert.equal(reset.op, 'rewrite');
    assert.match(reset.text, /retired/);
    assert.doesNotMatch(reset.text, /-821 121 571/);
});

test('compact lessons.json stays compact and a lone z-number 570 is not a hilltop hit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    const compact = JSON.stringify({
        version: 1,
        lessons: [
            { key: 'seed:home', text: 'Your house is at -823 124 568' },
            { key: 'note:cow', text: 'You saw a cow at z 570 near a river.' },
        ],
    });
    fs.writeFileSync(path.join(dir, 'lessons.json'), compact);
    const plan = planHomeMigration(dir, { now: 9, botStopped: true });
    const lessons = plan.actions.find((a) => a.file === 'lessons.json');
    assert.ok(lessons);
    assert.equal(lessons.pretty, false);
    assert.ok(lessons.write.lessons.some((l) => l.key === 'note:cow'));
    assert.equal(lessons.write.lessons.some((l) => l.key === 'seed:home'), false);
    const report = applyHomeMigration(plan, { apply: true, botStopped: true });
    assert.equal(report.applied, true);
    const raw = fs.readFileSync(path.join(dir, 'lessons.json'), 'utf8');
    assert.equal(/\n\s+"/.test(raw), false);
    assert.match(raw, /note:cow/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('rewritten lessons drop stale emb so backfill can re-embed them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-emb-'));
    write(dir, 'lessons.json', { version: 1, lessons: [
        { key: 'death:zombie', text: 'At night stay inside the house near the door.', emb: [9, 9, 9] },
        { key: 'seed:pickaxe', text: 'Mining needs a pickaxe', emb: [1, 2, 3] },
    ] });
    const plan = planHomeMigration(dir, { now: 11, botStopped: true });
    const lessons = plan.actions.find((a) => a.file === 'lessons.json');
    const death = lessons.write.lessons.find((l) => l.key === 'death:zombie');
    const pickaxe = lessons.write.lessons.find((l) => l.key === 'seed:pickaxe');
    assert.equal(death.emb, null);
    assert.deepEqual(pickaxe.emb, [1, 2, 3]);
    const filled = await backfillMissingEmbeddings(lessons.write.lessons, async (text) => [text.length]);
    assert.equal(filled, 1);
    assert.deepEqual(death.emb, [death.text.length]);
    assert.deepEqual(pickaxe.emb, [1, 2, 3]);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('backfillMissingEmbeddings fills only lessons that have no emb', async () => {
    const items = [
        { key: 'a', text: 'one', emb: null },
        { key: 'b', text: 'two', emb: [0] },
        { key: 'c', text: 'three' },
    ];
    const seen = [];
    const n = await backfillMissingEmbeddings(items, async (text) => {
        seen.push(text);
        return [text.length];
    });
    assert.equal(n, 2);
    assert.deepEqual(seen, ['one', 'three']);
    assert.deepEqual(items[0].emb, [3]);
    assert.deepEqual(items[1].emb, [0]);
    assert.deepEqual(items[2].emb, [5]);
});

test('backfillMissingEmbeddings leaves items unset when embed is not ready', async () => {
    const items = [{ key: 'a', text: 'one', emb: null }];
    const n = await backfillMissingEmbeddings(items, async () => null);
    assert.equal(n, 0);
    assert.equal(items[0].emb, null);
});

test('embedding backfill retries later in the session when the model was not ready', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-bf-'));
    const prev = process.cwd();
    process.chdir(root);
    try {
        fs.mkdirSync(path.join(root, 'bots', 't', 'learned_skills'), { recursive: true });
        fs.writeFileSync(path.join(root, 'bots', 't', 'lessons.json'), JSON.stringify({
            version: 1,
            lessons: [{ key: 'need', text: 'need embed', kind: 'fail', count: 1, first: 1, last: 1, emb: null }],
        }));
        let ready = false;
        const memory = new LongMemory({
            name: 't',
            prompter: { embedding_model: { embed: async () => (ready ? [1, 2, 3] : null) } },
            bot: null,
        });
        await memory._backfillPromise;
        const need = memory.lessons.data.lessons.find((l) => l.key === 'need');
        assert.equal(need.emb, null);
        assert.equal(memory._backfillPending, true);
        ready = true;
        memory.observe();
        await memory._backfillPromise;
        assert.deepEqual(need.emb, [1, 2, 3]);
        assert.equal(memory._backfillPending, false);
    } finally {
        process.chdir(prev);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('--bot-stopped still refuses if the running probe says Bob is up', () => {
    assert.equal(botLooksStopped({ botStopped: true, probe: { running: true, findings: ['MindServer answered 200'] } }).stopped, false);
    assert.equal(botLooksStopped({ botStopped: true, skipProbe: true, probe: { running: true } }).stopped, true);
});

test('probeBobRunning treats a MindServer 200 as running', async () => {
    const running = await probeBobRunning({
        fetchImpl: async () => ({ ok: true, status: 200 }),
        execFileImpl: (_cmd, _args, _opts, cb) => cb(new Error('no launchctl')),
    });
    assert.equal(running.running, true);
    assert.ok(running.findings.some((f) => /MindServer/.test(f)));
    const stopped = await probeBobRunning({
        fetchImpl: async () => { throw new Error('econnrefused'); },
        execFileImpl: (_cmd, _args, _opts, cb) => cb(new Error('no launchctl')),
    });
    assert.equal(stopped.running, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyHomeMigration, lessonMigration, planHomeMigration } from '../src/agent/library/bob_home_migrate.js';

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

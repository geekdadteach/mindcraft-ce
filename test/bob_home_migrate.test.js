import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyHomeMigration, planHomeMigration } from '../src/agent/library/bob_home_migrate.js';

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
    const plan = planHomeMigration(dir, { now: 42 });
    const report = applyHomeMigration(plan, { apply: true });
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

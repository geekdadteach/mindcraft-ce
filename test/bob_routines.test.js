import test from 'node:test';
import assert from 'node:assert/strict';
import { obtainWithRoutines, ROUTINES } from '../src/agent/library/bob_routines.js';

function rig(initial = {}) {
    const bag = { ...initial };
    const calls = [];
    const inventory = () => ({ ...bag });
    const gather = async (item, quantity) => {
        calls.push(['gather', item, quantity]);
        bag[item] = (bag[item] || 0) + quantity;
    };
    const craft = async (item, runs) => {
        calls.push(['craft', item, runs]);
        const recipe = ROUTINES[item];
        for (const [name, amount] of Object.entries(recipe.ingredients))
            bag[name] -= amount * runs;
        bag[item] = (bag[item] || 0) + recipe.output * runs;
    };
    return { bag, calls, inventory, gather, craft };
}

test('already owned: no work', async () => {
    const r = rig({ stick: 12 });
    const out = await obtainWithRoutines({ item: 'stick', quantity: 8, ...r });
    assert.equal(out.ok, true);
    assert.equal(out.steps, 0);
    assert.deepEqual(r.calls, []);
});

test('gather only missing wood, then craft planks', async () => {
    const r = rig({ oak_log: 2 });
    const out = await obtainWithRoutines({ item: 'oak_planks', quantity: 16, ...r });
    assert.equal(out.ok, true);
    assert.deepEqual(r.calls, [['gather', 'oak_log', 2], ['craft', 'oak_planks', 4]]);
    assert.equal(r.bag.oak_planks, 16);
});

test('multi-step stick dependency chain', async () => {
    const r = rig();
    const out = await obtainWithRoutines({ item: 'stick', quantity: 8, ...r });
    assert.equal(out.ok, true);
    assert.deepEqual(r.calls, [
        ['gather', 'oak_log', 1],
        ['craft', 'oak_planks', 1],
        ['craft', 'stick', 2]
    ]);
});

test('crafting table uses current plank inventory', async () => {
    const r = rig({ oak_planks: 4 });
    const out = await obtainWithRoutines({ item: 'crafting_table', quantity: 1, ...r });
    assert.equal(out.ok, true);
    assert.deepEqual(r.calls, [['craft', 'crafting_table', 1]]);
});

test('blocked gather does not report success or retry indefinitely', async () => {
    const r = rig();
    r.gather = async () => { r.calls.push(['blocked']); return true; };
    const out = await obtainWithRoutines({ item: 'oak_planks', quantity: 16, ...r });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'gather_shortfall:oak_log');
    assert.deepEqual(r.calls, [['blocked']]);
});

test('craft claims success without inventory change: fails verification', async () => {
    const r = rig({ oak_log: 1 });
    r.craft = async () => true;
    const out = await obtainWithRoutines({ item: 'oak_planks', quantity: 4, ...r });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'craft_shortfall:oak_planks');
});

test('interrupted before starting: no action', async () => {
    const r = rig();
    const out = await obtainWithRoutines({ item: 'stick', quantity: 8, ...r, interrupted: () => true });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'interrupted');
    assert.deepEqual(r.calls, []);
});

test('interrupted after gather: skips crafting', async () => {
    const r = rig();
    const gather = async (item, amount) => { await r.gather(item, amount); };
    const out = await obtainWithRoutines({
        item: 'oak_planks', quantity: 4, ...r, gather,
        interrupted: () => r.calls.length > 0
    });
    assert.equal(out.reason, 'interrupted');
    assert.equal(r.calls.length, 1);
});

test('invalid requests have no effects', async () => {
    const r = rig();
    const a = await obtainWithRoutines({ item: 'diamond', quantity: 1, ...r });
    const b = await obtainWithRoutines({ item: 'stick', quantity: 9999, ...r });
    assert.equal(a.reason, 'unsupported_item');
    assert.equal(b.reason, 'invalid_quantity');
    assert.deepEqual(r.calls, []);
});

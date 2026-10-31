import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    VERIFIER_VERSION,
    captureWorldSnapshot,
    describeCommand,
    publicDescriptor,
    mapGoalText,
    verifyGoal,
} from '../src/agent/library/bob_goal_verifier.js';
import {
    BobEvalHarness,
    defaultGoalVerifier,
    resolveEvalHarnessConfig,
} from '../src/agent/library/bob_eval_harness.js';

function snap(overrides = {}) {
    return {
        position: { x: 10, y: 64, z: 20 },
        health: 18,
        food: 12,
        dimension: 'overworld',
        inventory: [{ name: 'oak_log', count: 2 }, { name: 'bread', count: 0 }],
        nearby_blocks: [{ name: 'grass_block', x: 10, y: 63, z: 20 }],
        target_kind: null,
        target_present: false,
        target_distance: null,
        ...overrides,
    };
}

function fakeAgent(inv = [{ name: 'oak_log', count: 2 }], extras = {}) {
    return {
        self_prompter: { prompt: extras.prompt || 'get food nearby', isActive: () => true },
        bot: {
            entity: { position: extras.position || { x: 10, y: 64, z: 20 } },
            health: extras.health ?? 18,
            food: extras.food ?? 12,
            game: { dimension: 'overworld' },
            inventory: { items: () => inv },
            blockAt: (pos) => {
                const y = pos?.y ?? 0;
                if (y <= 63) return { name: extras.block || 'grass_block' };
                return { name: 'air' };
            },
            entities: extras.entities || {},
            players: extras.players || {},
        },
    };
}

test('collectBlocks met / progress / not_met from inventory delta', () => {
    const before = snap({ inventory: [{ name: 'oak_log', count: 2 }] });
    const met = verifyGoal({
        before,
        after: snap({ inventory: [{ name: 'oak_log', count: 6 }] }),
        descriptor: { command: '!collectBlocks', item: 'oak_log', count: 4 },
    });
    assert.equal(met.verdict, 'met');
    assert.equal(met.verifier, 'collect');
    assert.equal(met.verifier_version, VERIFIER_VERSION);
    assert.ok(met.evidence?.delta?.items?.oak_log >= 4);

    const progress = verifyGoal({
        before,
        after: snap({ inventory: [{ name: 'oak_log', count: 3 }] }),
        descriptor: { command: '!collectBlocks', item: 'oak_log', count: 4 },
    });
    assert.equal(progress.verdict, 'progress');

    const miss = verifyGoal({
        before,
        after: snap({ inventory: [{ name: 'oak_log', count: 2 }] }),
        descriptor: { command: '!collectBlocks', item: 'oak_log', count: 4 },
    });
    assert.equal(miss.verdict, 'not_met');
});

test('collect aliases treat coal_ore as coal', () => {
    const out = verifyGoal({
        before: snap({ inventory: [{ name: 'coal', count: 1 }] }),
        after: snap({ inventory: [{ name: 'coal', count: 8 }] }),
        descriptor: { command: '!collectBlocks', item: 'coal_ore', count: 5 },
    });
    assert.equal(out.verdict, 'met');
});

test('goToCoordinates / moveAway / goToPlayer', () => {
    const here = snap({ position: { x: 0, y: 64, z: 0 } });
    const arrived = verifyGoal({
        before: here,
        after: snap({ position: { x: 100, y: 64, z: 100 } }),
        descriptor: { command: '!goToCoordinates', x: 100, y: 64, z: 100, closeness: 2 },
    });
    assert.equal(arrived.verdict, 'met');
    assert.equal(arrived.verifier, 'navigate');

    const far = verifyGoal({
        before: here,
        after: snap({ position: { x: 0, y: 64, z: 0 } }),
        descriptor: { command: '!goToCoordinates', x: 100, y: 64, z: 100, closeness: 2 },
    });
    assert.equal(far.verdict, 'not_met');

    const away = verifyGoal({
        before: here,
        after: snap({ position: { x: 12, y: 64, z: 0 } }),
        descriptor: { command: '!moveAway', distance: 10 },
    });
    assert.equal(away.verdict, 'met');

    const player = verifyGoal({
        before: snap({ target_kind: 'player', target_present: true, target_distance: 30 }),
        after: snap({ target_kind: 'player', target_present: true, target_distance: 1.5 }),
        descriptor: { command: '!goToPlayer', target: 'player', closeness: 2 },
    });
    assert.equal(player.verdict, 'met');
    assert.equal(JSON.stringify(player).includes('"Steve"'), false);
});

test('getFood false positive: exec-style success with no food gained is not_met', () => {
    const before = snap({ food: 12, inventory: [{ name: 'bread', count: 0 }] });
    const after = snap({ food: 12, inventory: [{ name: 'bread', count: 0 }] });
    const out = verifyGoal({
        before,
        after,
        descriptor: { command: '!getFood' },
    });
    assert.equal(out.verdict, 'not_met');
    assert.equal(out.verifier, 'food');
    assert.match(out.reason, /did not rise/i);
});

test('getFood met when food level rises or food items are gained', () => {
    const ate = verifyGoal({
        before: snap({ food: 8 }),
        after: snap({ food: 14 }),
        descriptor: { command: '!getFood' },
    });
    assert.equal(ate.verdict, 'met');

    const loot = verifyGoal({
        before: snap({ food: 8, inventory: [{ name: 'beef', count: 0 }] }),
        after: snap({ food: 8, inventory: [{ name: 'beef', count: 2 }] }),
        descriptor: { command: '!getFood' },
    });
    assert.equal(loot.verdict, 'met');

    const consume = verifyGoal({
        before: snap({ food: 8, inventory: [{ name: 'bread', count: 1 }] }),
        after: snap({ food: 12, inventory: [{ name: 'bread', count: 0 }] }),
        descriptor: { command: '!consume', item: 'bread' },
    });
    assert.equal(consume.verdict, 'met');
});

test('craft and smelt use output inventory delta', () => {
    const craft = verifyGoal({
        before: snap({ inventory: [{ name: 'oak_planks', count: 0 }] }),
        after: snap({ inventory: [{ name: 'oak_planks', count: 4 }] }),
        descriptor: { command: '!craftRecipe', item: 'oak_planks', count: 1 },
    });
    assert.equal(craft.verdict, 'met');
    assert.equal(craft.verifier, 'craft');

    const smelt = verifyGoal({
        before: snap({ inventory: [{ name: 'iron_ingot', count: 0 }, { name: 'raw_iron', count: 3 }] }),
        after: snap({ inventory: [{ name: 'iron_ingot', count: 2 }, { name: 'raw_iron', count: 1 }] }),
        descriptor: { command: '!smeltItem', item: 'raw_iron', count: 2 },
    });
    assert.equal(smelt.verdict, 'met');

    const unknownSmelt = verifyGoal({
        before: snap(),
        after: snap({ inventory: [{ name: 'mystery', count: 4 }] }),
        descriptor: { command: '!smeltItem', item: 'mystery_input', count: 1 },
    });
    assert.equal(unknownSmelt.verdict, 'unevaluated');
});

test('placeHere looks at the nearby-block sample', () => {
    const met = verifyGoal({
        before: snap(),
        after: snap({ nearby_blocks: [{ name: 'torch', x: 10, y: 64, z: 20 }] }),
        descriptor: { command: '!placeHere', block: 'torch' },
    });
    assert.equal(met.verdict, 'met');

    const miss = verifyGoal({
        before: snap(),
        after: snap({ nearby_blocks: [{ name: 'dirt', x: 10, y: 64, z: 20 }] }),
        descriptor: { command: '!placeHere', block: 'torch' },
    });
    assert.equal(miss.verdict, 'not_met');
});

test('attack met when target gone or drops gained', () => {
    const gone = verifyGoal({
        before: snap({ target_kind: 'entity', target_present: true, target_nearby: 1 }),
        after: snap({ target_kind: 'entity', target_present: false, target_nearby: 0 }),
        descriptor: { command: '!attack', entity: 'cow' },
    });
    assert.equal(gone.verdict, 'met');

    const drops = verifyGoal({
        before: snap({ target_kind: 'entity', target_present: true, inventory: [] }),
        after: snap({ target_kind: 'entity', target_present: true, inventory: [{ name: 'beef', count: 2 }] }),
        descriptor: { command: '!attack', entity: 'cow' },
    });
    assert.equal(drops.verdict, 'met');

    const miss = verifyGoal({
        before: snap({ target_kind: 'entity', target_present: true, target_nearby: 1 }),
        after: snap({ target_kind: 'entity', target_present: true, target_nearby: 1 }),
        descriptor: { command: '!attack', entity: 'cow' },
    });
    assert.equal(miss.verdict, 'not_met');
});

test('survival tracks health/food trend and deaths', () => {
    const heal = verifyGoal({
        before: snap({ health: 8, food: 6 }),
        after: snap({ health: 16, food: 10 }),
        descriptor: {},
        goalText: 'heal and survive',
    });
    assert.equal(heal.verdict, 'met');
    assert.equal(heal.verifier, 'survival');

    const died = verifyGoal({
        before: snap({ health: 6 }),
        after: snap({ health: 0 }),
        goalText: 'survive',
    });
    assert.equal(died.verdict, 'not_met');
});

test('goal text maps heuristically and never guesses met', () => {
    assert.equal(mapGoalText('collect 16 oak_log').kind, 'collect');
    assert.equal(mapGoalText('collect 16 oak_log').item, 'oak_log');
    assert.equal(mapGoalText('get food nearby').kind, 'food');
    assert.equal(mapGoalText('wander around thinking').kind, null);

    const vague = verifyGoal({
        before: snap(),
        after: snap({ inventory: [{ name: 'diamond', count: 64 }] }),
        goalText: 'do something useful today',
    });
    assert.equal(vague.verdict, 'unevaluated');

    const noBefore = verifyGoal({
        after: snap({ food: 20, inventory: [{ name: 'bread', count: 8 }] }),
        descriptor: { command: '!getFood' },
    });
    assert.equal(noBefore.verdict, 'unevaluated');
});

test('describeCommand strips player names from the public descriptor', () => {
    const desc = describeCommand('!goToPlayer', ['SomePlayer', 3]);
    assert.equal(desc.target, 'player');
    assert.equal(desc.player_lookup, 'SomePlayer');
    const pub = publicDescriptor(desc);
    assert.equal(pub.player_lookup, undefined);
    assert.equal(pub.target, 'player');
});

test('captureWorldSnapshot is sync, bounded, and survives throws', () => {
    const agent = fakeAgent([{ name: 'oak_log', count: 3 }], {
        entities: { e1: { name: 'cow', position: { x: 12, y: 64, z: 20 } } },
    });
    const snap1 = captureWorldSnapshot(agent, { entity: 'cow' });
    assert.equal(snap1.position.x, 10);
    assert.equal(snap1.food, 12);
    assert.ok(snap1.inventory.some((i) => i.name === 'oak_log'));
    assert.equal(snap1.target_kind, 'entity');
    assert.equal(snap1.target_present, true);
    assert.ok(Array.isArray(snap1.nearby_blocks));
    assert.ok(snap1.nearby_blocks.length <= 12);

    const bad = {
        bot: {
            entity: { position: { x: 1, y: 2, z: 3 } },
            inventory: { items() { throw new Error('boom'); } },
            blockAt() { throw new Error('chunk'); },
        },
    };
    const snap2 = captureWorldSnapshot(bad);
    assert.equal(snap2.position.x, 1);
    assert.deepEqual(snap2.inventory, []);
});

test('harness verifier is on by default and opt-out BOB_EVAL_GOAL_VERIFIER=0 uses the stub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-goal-ver-'));
    try {
        const onFile = join(dir, 'on.jsonl');
        const offFile = join(dir, 'off.jsonl');
        const beforeAgent = fakeAgent([{ name: 'bread', count: 0 }], { food: 12, prompt: 'get food nearby' });
        const afterAgent = fakeAgent([{ name: 'bread', count: 0 }], { food: 12, prompt: 'get food nearby' });

        const on = new BobEvalHarness({ env: { BOB_EVAL_HARNESS_LOG: onFile }, agent: beforeAgent });
        assert.equal(on.goalVerifierOn, true);
        on.noteGoalChange('get food nearby', 'start', beforeAgent);
        on.noteTurnStart(beforeAgent, { source: 'system', self_prompt: true });
        on.noteExecStart({ command_name: '!getFood', args: [] }, beforeAgent);
        on.noteTaskEvent({ type: 'task.finished', state: 'succeeded', taskId: 'bob-task-food', reason: 'Could not find food nearby' });
        on.noteExecEnd({ duration_ms: 10, result: 'Could not find food nearby', task_state: 'succeeded' }, afterAgent);
        on.noteGoalCheck(afterAgent);
        await on.flush();
        on.close();
        const onGoal = readFileSync(onFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'goal_check');
        assert.equal(onGoal.verdict, 'not_met');
        assert.equal(onGoal.verifier, 'food');
        assert.equal(onGoal.verifier_version, VERIFIER_VERSION);
        assert.equal(onGoal.task_finished_state, 'succeeded');
        assert.equal(onGoal.task_finished_is_not_goal_outcome, true);
        assert.notEqual(onGoal.verdict, 'succeeded');

        const cfg = resolveEvalHarnessConfig({
            BOB_EVAL_HARNESS_LOG: offFile,
            BOB_EVAL_GOAL_VERIFIER: '0',
        });
        assert.equal(cfg.goalVerifier, false);
        const off = new BobEvalHarness({ env: { BOB_EVAL_HARNESS_LOG: offFile, BOB_EVAL_GOAL_VERIFIER: '0' } });
        assert.equal(off.goalVerifierOn, false);
        off.noteGoalCheck(afterAgent);
        await off.flush();
        off.close();
        const offGoal = JSON.parse(readFileSync(offFile, 'utf8').trim().split('\n').pop());
        assert.equal(offGoal.verdict_source, 'world_state_stub');
        assert.match(offGoal.verdict, /unevaluated|insufficient_world_state|no_active_goal/);
        assert.equal(defaultGoalVerifier({ position: { x: 1, y: 2, z: 3 }, inventory: [] }, {
            last_task_finished_state: 'succeeded',
            self_prompt_present: true,
        }).verdict_source, 'world_state_stub');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    BobEvalHarness,
    EvalHarnessWriter,
    attachBobEvalHarness,
    defaultGoalVerifier,
    harnessOf,
    inferGuardKind,
    resolveEvalHarnessConfig,
    snapshotWorld,
} from '../src/agent/library/bob_eval_harness.js';

function withDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'bob-eval-harness-'));
    const done = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
    return Promise.resolve()
        .then(() => fn(dir))
        .finally(done);
}

function rows(file) {
    if (!existsSync(file)) return [];
    const text = readFileSync(file, 'utf8');
    if (!text) return [];
    return text.trim().split('\n').map((line) => JSON.parse(line));
}

function fakeAgent(prompt = 'get food nearby') {
    return {
        self_prompter: {
            prompt,
            isActive: () => true,
        },
        bot: {
            entity: { position: { x: -10.2, y: 64.1, z: 20.8 } },
            health: 18,
            food: 12,
            inventory: {
                items: () => [{ name: 'bread', count: 2 }, { name: 'oak_log', count: 8 }],
            },
        },
        prompter: {
            chat_model: { constructor: { name: 'AndyPool' }, lm_model: 'andy-4.2', model_name: 'andy-4.2' },
            code_model: { constructor: { name: 'Andy' }, model_name: 'claude-haiku-5.5' },
            profile: { model: { api: 'andy_pool', model: 'andy-4.2' }, code_model: { api: 'andy', model: 'claude-haiku-5.5' } },
        },
    };
}

test('disabled unless BOB_EVAL_HARNESS_LOG is an absolute path', () => {
    assert.equal(resolveEvalHarnessConfig({}).enabled, false);
    assert.equal(resolveEvalHarnessConfig({}).rejected, false);
    assert.equal(resolveEvalHarnessConfig({ BOB_EVAL_HARNESS_LOG: 'eval.jsonl' }).enabled, false);
    assert.equal(resolveEvalHarnessConfig({ BOB_EVAL_HARNESS_LOG: 'eval.jsonl' }).rejected, true);
    assert.equal(resolveEvalHarnessConfig({ BOB_EVAL_HARNESS_LOG: '/tmp/has space.jsonl' }).enabled, false);
    assert.equal(resolveEvalHarnessConfig({ BOB_EVAL_HARNESS_LOG: '/tmp/bob-eval.jsonl' }).enabled, true);
    assert.equal(resolveEvalHarnessConfig({ BOB_EVAL_HARNESS_LOG: '/tmp/bob-eval.jsonl' }).logRaw, false);
    assert.equal(resolveEvalHarnessConfig({
        BOB_EVAL_HARNESS_LOG: '/tmp/bob-eval.jsonl',
        BOB_EVAL_HARNESS_LOG_RAW: '1',
    }).logRaw, true);
});

test('disabled hooks create no file and do not change caller values', async () => {
    await withDir(async (dir) => {
        const file = join(dir, 'should-not-exist.jsonl');
        const harness = new BobEvalHarness({ env: {} });
        const payload = { source: 'system', self_prompt: true, extra: { n: 1 } };
        const before = JSON.stringify(payload);

        let threw = false;
        try {
            harness.noteGoalChange('get food', 'start');
            harness.noteTurnStart(fakeAgent(), payload);
            const mark = harness.markModelCall(fakeAgent(), 'conversation', null);
            harness.finishModelCall(mark, '!getFood');
            harness.noteParse({ has_command: true, command_name: '!getFood', exists: true });
            harness.noteGuard({ kind: 'repeat', blocked: true, note: 'You already did that; pick a different task such as getting food or gathering resources.' });
            harness.noteExecStart({ command_name: '!getFood' });
            harness.noteExecEnd({ duration_ms: 12, result: 'Could not find food nearby' });
            harness.noteHistoryAppend({ role: 'assistant', kind: 'command_reply', chars: 8 });
            harness.noteTaskEvent({ type: 'task.finished', state: 'succeeded', taskId: 'bob-task-1' });
            harness.noteGoalCheck(fakeAgent());
            harness.noteTurnEnd({ reason: 'command_returned' });
            await harness.flush();
        } catch {
            threw = true;
        }

        assert.equal(threw, false);
        assert.equal(harness.enabled, false);
        assert.equal(existsSync(file), false);
        assert.equal(JSON.stringify(payload), before);
        assert.equal(harness.markNow(), 0);
        assert.equal(harness.elapsedMs(1), 0);
        harness.close();
    });
});

test('writer failures never throw and self-disable after repeated errors', async () => {
    const exploding = {
        calls: 0,
        enqueue() {
            this.calls += 1;
            throw new Error('disk full');
        },
        async flush() { throw new Error('flush failed'); },
        close() { throw new Error('close failed'); },
    };
    const harness = new BobEvalHarness({
        env: { BOB_EVAL_HARNESS_LOG: '/tmp/bob-eval-never-used.jsonl' },
        writer: exploding,
    });
    assert.doesNotThrow(() => {
        harness.noteTurnStart(fakeAgent(), { source: 'system' });
        harness.noteExecEnd({ result: 'x' });
        harness.noteGoalCheck(fakeAgent());
    });
    assert.ok(exploding.calls >= 1);
    await assert.doesNotReject(() => harness.flush());
    assert.doesNotThrow(() => harness.close());

    await withDir(async (dir) => {
        const notDir = join(dir, 'not-a-dir');
        writeFileSync(notDir, 'nope');
        const bad = join(notDir, 'eval.jsonl');
        const writer = new EvalHarnessWriter({ enabled: true, path: bad });
        const live = new BobEvalHarness({
            env: { BOB_EVAL_HARNESS_LOG: bad },
            writer,
        });
        assert.doesNotThrow(() => {
            for (let i = 0; i < 6; i++) live.noteTurnStart(fakeAgent(), { source: 'system', iteration: i });
        });
        await live.flush();
        assert.equal(writer.disabled, true);
        live.close();
    });
});

test('IDs correlate across a simulated model turn', async () => {
    await withDir(async (dir) => {
        const file = join(dir, 'eval.jsonl');
        const harness = new BobEvalHarness({ env: { BOB_EVAL_HARNESS_LOG: file } });
        const agent = fakeAgent('collect 16 oak_log');

        harness.noteGoalChange(agent.self_prompter.prompt, 'start');
        harness.noteTurnStart(agent, { source: 'system', self_prompt: true, iteration: 0 });
        const mark = harness.markModelCall(agent, 'conversation', agent.prompter.chat_model);
        harness.finishModelCall(mark, 'I will gather wood. !collectBlocks("oak_log")');
        harness.noteParse({ has_command: true, command_name: '!collectBlocks', exists: true, parse_ok: true, arg_count: 1 });
        harness.noteHistoryAppend({ role: 'assistant', kind: 'command_reply', chars: 40 });
        harness.noteExecStart({ command_name: '!collectBlocks' });
        harness.noteTaskEvent({
            type: 'task.finished',
            state: 'succeeded',
            taskId: 'bob-task-sim-1',
            label: 'action:collectBlocks',
            reason: 'Could not find oak_log nearby',
        });
        harness.noteExecEnd({
            duration_ms: 40,
            result: 'Could not find oak_log nearby',
            interrupted: false,
            timedout: false,
        });
        harness.noteHistoryAppend({ role: 'system', kind: 'command_result', chars: 30 });
        harness.noteGoalCheck(agent);
        harness.noteTurnEnd({ reason: 'command_returned' });
        await harness.flush();
        harness.close();

        const events = rows(file);
        const types = events.map(e => e.type);
        assert.deepEqual(types, [
            'goal_change', 'turn_start', 'model_response', 'parse', 'history_append',
            'exec_start', 'task_event', 'exec_end', 'history_append', 'goal_check', 'turn_end',
        ]);
        assert.ok(events.every(e => e.run_id === harness.run_id || e.run_id === events[0].run_id));
        const runIds = new Set(events.map(e => e.run_id));
        const goalIds = new Set(events.map(e => e.goal_id));
        assert.equal(runIds.size, 1);
        assert.equal(goalIds.size, 1);
        assert.match([...goalIds][0], /^g1\.[0-9a-f]{12}$/);

        const afterStart = events.filter(e => e.type !== 'goal_change');
        const turnIds = new Set(afterStart.map(e => e.turn_id));
        assert.equal(turnIds.size, 1);
        const turnId = [...turnIds][0];
        assert.match(turnId, /\.t1$/);

        const commandEvents = events.filter(e => ['parse', 'exec_start', 'exec_end', 'task_event'].includes(e.type));
        assert.ok(commandEvents.every(e => e.command_id === `${turnId}.1`));
        assert.ok(events.filter(e => e.type === 'task_event' || e.type === 'exec_end' || e.type === 'goal_check')
            .every(e => e.task_id === 'bob-task-sim-1'));

        const model = events.find(e => e.type === 'model_response');
        assert.equal(model.lane, 'conversation');
        assert.equal(model.model, 'andy-4.2');
        assert.equal(Object.hasOwn(model, 'text'), false);
        assert.equal(Object.hasOwn(model, 'prompt'), false);
        assert.ok(events.every(e => typeof e.ts === 'string' && e.ts.endsWith('Z')));
        assert.ok(events.every(e => Number.isFinite(e.mono_ms)));
        assert.equal(statSync(file).mode & 0o077, 0);
    });
});

test('task.finished succeeded is not recorded as goal success', async () => {
    await withDir(async (dir) => {
        const file = join(dir, 'eval.jsonl');
        const harness = new BobEvalHarness({ env: { BOB_EVAL_HARNESS_LOG: file } });
        const agent = fakeAgent('get food nearby');

        harness.noteGoalChange(agent.self_prompter.prompt, 'start');
        harness.noteTurnStart(agent, { source: 'system', self_prompt: true });
        harness.noteTaskEvent({
            type: 'task.finished',
            state: 'succeeded',
            taskId: 'bob-task-food',
            label: 'action:getFood',
            reason: 'Could not find food nearby',
        });
        harness.noteGoalCheck(agent);
        await harness.flush();
        harness.close();

        const events = rows(file);
        const goal = events.find(e => e.type === 'goal_check');
        const task = events.find(e => e.type === 'task_event');
        assert.ok(goal);
        assert.ok(task);
        assert.equal(task.state, 'succeeded');
        assert.equal(goal.task_finished_state, 'succeeded');
        assert.equal(goal.task_finished_is_not_goal_outcome, true);
        assert.notEqual(goal.verdict, 'succeeded');
        assert.notEqual(goal.verdict, 'success');
        assert.notEqual(goal.verdict, 'goal_succeeded');
        assert.notEqual(goal.verdict, 'complete');
        assert.ok(goal.verifier === 'food' || goal.verdict_source === 'world_state_stub' || goal.verifier === 'world_state_stub');
        assert.match(goal.verdict, /unevaluated|not_met|insufficient_world_state|no_active_goal/);
        assert.ok(goal.verifier_version);

        const fromTask = defaultGoalVerifier(snapshotWorld(agent), {
            last_task_finished_state: 'succeeded',
            last_task_finished_reason: 'Could not find food nearby',
            self_prompt_present: true,
        });
        assert.notEqual(fromTask.verdict, 'succeeded');
        assert.equal(fromTask.task_finished_is_not_goal_outcome, true);
        assert.equal(fromTask.task_finished_state, 'succeeded');
    });
});

test('inferGuardKind reads returned strings and does not need the live guards', () => {
    assert.equal(inferGuardKind('You already did that; pick a different task such as getting food or gathering resources.'), 'repeat');
    assert.equal(inferGuardKind('CRITICAL SURVIVAL: health=3/20, food=2/20. Optional action blocked. Prioritize !getFood, eating immediately, or safe shelter. Do not mine, build or explore until stabilized.'), 'survival');
    assert.equal(inferGuardKind('!collectBlocks("coal_ore") is blocked for about 2 more min: you got stuck doing it at 1 2 3. Pick a different task or place.'), 'stuck');
    assert.equal(inferGuardKind('!mineBlock("stone") failed 2 times near 1 2 3 recently (NoPath). Do not repeat it here: choose a different task, target or place.'), 'failure');
    assert.equal(inferGuardKind('You already have 37 coal, which is plenty; no need to collect coal_ore now. Use it or do something else (food, crafting, farming).'), 'collect');
    assert.equal(inferGuardKind('dropped_by_interrupt'), 'dropped_by_interrupt');
    assert.equal(inferGuardKind(''), null);
});

test('raw model text stays out of the log unless the extra opt-in is set', async () => {
    await withDir(async (dir) => {
        const offFile = join(dir, 'off.jsonl');
        const onFile = join(dir, 'on.jsonl');
        const secret = 'player whispered a private plan';

        const off = new BobEvalHarness({ env: { BOB_EVAL_HARNESS_LOG: offFile } });
        const markOff = off.markModelCall(fakeAgent(), 'conversation', null);
        off.finishModelCall(markOff, `I heard: ${secret} !getFood`, { prompt: `LONG MEMORY ${secret}` });
        await off.flush();
        off.close();
        assert.equal(readFileSync(offFile, 'utf8').includes(secret), false);

        const on = new BobEvalHarness({
            env: { BOB_EVAL_HARNESS_LOG: onFile, BOB_EVAL_HARNESS_LOG_RAW: '1' },
        });
        const markOn = on.markModelCall(fakeAgent(), 'conversation', null);
        on.finishModelCall(markOn, `short reply`);
        await on.flush();
        on.close();
        const rec = rows(onFile).find(e => e.type === 'model_response');
        assert.equal(rec.text, 'short reply');
        assert.equal(Object.hasOwn(rec, 'prompt'), false);
    });
});

test('attach stays passive when disabled and adds a second listener only when enabled', () => {
    const listeners = [];
    const agent = {
        bot: { on(event, fn) { listeners.push([event, fn]); } },
    };
    const disabled = attachBobEvalHarness(agent, { env: {} });
    assert.equal(disabled.enabled, false);
    assert.equal(listeners.length, 0);
    assert.equal(harnessOf(agent), disabled);

    const liveAgent = {
        bot: { on(event, fn) { listeners.push([event, fn]); } },
    };
    const enabled = attachBobEvalHarness(liveAgent, {
        env: { BOB_EVAL_HARNESS_LOG: '/tmp/bob-eval-attach.jsonl' },
        writer: { enqueue() { return true; }, close() {}, async flush() {} },
    });
    assert.equal(enabled.enabled, true);
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0][0], 'bob_task_event');
    enabled.close();
});

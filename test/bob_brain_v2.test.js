import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BobBrain, attachBobBrain, withConversationAdvice } from '../src/agent/library/bob_brain.js';
import { ActionManager } from '../src/agent/action_manager.js';
import {
    BobV2Receipts,
    EVENT_ID_RE,
    TRACE_ID_RE,
    V2EventLog,
    advicePresentInPrompt,
    buildV2Event,
    resolveV2EventLogConfig,
    runCommandPerform,
} from '../src/agent/library/bob_brain_v2.js';

function makeLog() {
    return {
        lines: [],
        warnings: [],
        log(message) { this.lines.push(String(message)); },
        warn(message) { this.warnings.push(String(message)); },
    };
}

function readEvents(file) {
    if (!existsSync(file)) return [];
    const text = readFileSync(file, 'utf8');
    if (!text) return [];
    assert.equal(text.endsWith('\n'), true);
    assert.equal(text.slice(0, -1).includes('\n\n'), false);
    return text.slice(0, -1).split('\n').map((line) => {
        assert.equal(line.includes('\n'), false);
        const event = JSON.parse(line);
        assert.equal(event.version, 1);
        assert.equal(event.source, 'mindcraft');
        assert.match(event.trace_id, TRACE_ID_RE);
        assert.ok(event.summary.length > 0 && event.summary.length <= 700);
        if (event.event_id != null) assert.match(event.event_id, EVENT_ID_RE);
        const keys = Object.keys(event).sort();
        assert.deepEqual(keys, event.event_id ? ['event_id', 'source', 'summary', 'trace_id', 'type', 'version'].sort() : ['source', 'summary', 'trace_id', 'type', 'version'].sort());
        return event;
    });
}

function receiptBrain(file, extra = {}) {
    const log = makeLog();
    let now = 1_000_000;
    const brain = new BobBrain({ enabled: false, reason: 'test' }, {
        log,
        now: () => now,
        env: { BOB_BRAIN_V2_EVENT_LOG: file },
        ...extra,
    });
    return { brain, log, advance(ms) { now += ms; } };
}

function stored(brain, summary, id = 'job-7', kind = 'plan') {
    brain._storeAdvice({ id, kind, result: { summary } });
}

function finishedPrompt(brain, template = 'You are $NAME.\n$LONG_MEMORY\n$STATS') {
    const conversation = template.includes('$LONG_MEMORY');
    let prompt = template.replaceAll('$NAME', 'Bob');
    if (conversation) {
        const note = brain.adviceBlock();
        const memory = ['Lessons learned (from your own experience):\n- stay upstairs', note].filter(Boolean).join('\n');
        prompt = withConversationAdvice(prompt, memory);
    }
    return prompt.replaceAll('$STATS', 'health 20');
}

test('version-1 shape and identifier rules', () => {
    assert.equal(resolveV2EventLogConfig({}).enabled, false);
    assert.equal(resolveV2EventLogConfig({}).rejected, false);
    assert.equal(resolveV2EventLogConfig({ BOB_BRAIN_V2_EVENT_LOG: 'bob.jsonl' }).rejected, true);
    assert.match(resolveV2EventLogConfig({ BOB_BRAIN_V2_EVENT_LOG: 'bob.jsonl' }).reason, /absolute/);
    assert.equal(resolveV2EventLogConfig({ BOB_BRAIN_V2_EVENT_LOG: '/tmp/has space.jsonl' }).enabled, false);

    const good = buildV2Event({
        eventId: 'bob.boot.job-7.advice_injected.1',
        traceId: 'job-7',
        type: 'advice_injected',
        summary: `Bearer super-secret-token and sk-abcdefghij ${'x'.repeat(800)}`,
        secrets: ['super-secret-token'],
    });
    assert.equal(good.version, 1);
    assert.equal(good.summary.length, 700);
    assert.equal(good.summary.includes('super-secret-token'), false);
    assert.equal(good.summary.includes('sk-abcdefghij'), false);
    assert.match(good.summary, /Bearer \[redacted\]/);
    assert.equal(buildV2Event({ traceId: 'job 7', type: 'advice_injected', summary: 'hi' }), null);
    assert.equal(buildV2Event({ traceId: '../job', type: 'advice_injected', summary: 'hi' }), null);
    assert.equal(buildV2Event({ traceId: 'a'.repeat(81), type: 'advice_injected', summary: 'hi' }), null);
    assert.equal(buildV2Event({ traceId: '', type: 'advice_injected', summary: 'hi' }), null);
    assert.equal(buildV2Event({ traceId: 'job-7', type: 'Advice', summary: 'hi' }), null);
    assert.equal(buildV2Event({ eventId: 'bad id', traceId: 'job-7', type: 'advice_injected', summary: 'hi' }), null);
    assert.equal(buildV2Event({ eventId: 'x'.repeat(129), traceId: 'job-7', type: 'advice_injected', summary: 'hi' }), null);
    assert.equal(buildV2Event({ traceId: 'job-7', type: 'advice_injected', summary: 'hi', source: 'bob' }), null);
    assert.equal(Object.hasOwn(buildV2Event({ traceId: 'job-7', type: 'advice_injected', summary: 'hi' }), 'event_id'), false);

    assert.equal(advicePresentInPrompt('Bob Brain suggestion (unverified):\n- (plan) oak planks\n', { kind: 'plan', text: 'oak' }), false);
    assert.equal(advicePresentInPrompt('Bob Brain suggestion (unverified):\n- (plan) oak\n', { kind: 'plan', text: 'oak' }), true);
    assert.equal(advicePresentInPrompt('oak', { kind: 'plan', text: 'oak' }), false);
});

test('receipts are disabled unless the env var is an absolute path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-v2-'));
    try {
        const log = makeLog();
        const off = new BobBrain({ enabled: false, reason: 'test' }, { env: {}, log });
        off._storeAdvice({ id: 'job-1', kind: 'plan', result: { summary: 'Dig a secret hole' } });
        off.observeAssembledPrompt(finishedPrompt(off), { conversationPrompt: true, armAction: true });
        assert.equal(off.receipts.writer.fd, null);
        assert.equal(off.receipts.config.enabled, false);
        assert.equal(existsSync(join(dir, 'v2.jsonl')), false);

        const agent = { bot: null };
        const attached = attachBobBrain(agent, { env: {}, log });
        assert.equal(log.lines.join('\n').includes('v2 receipts'), false);
        assert.equal(log.warnings.join('\n').includes('v2 receipts'), false);
        attached.stop();

        const warned = makeLog();
        attachBobBrain({ bot: null }, { env: { BOB_BRAIN_V2_EVENT_LOG: 'relative.jsonl' }, log: warned });
        assert.match(warned.warnings.join('\n'), /absolute path/);

        const file = join(dir, 'v2.jsonl');
        const enabled = makeLog();
        const brain = attachBobBrain({ bot: null }, { env: { BOB_BRAIN_V2_EVENT_LOG: file }, log: enabled });
        assert.match(enabled.lines.join('\n'), /v2 receipts enabled/);
        assert.equal(existsSync(file), false);
        brain.stop();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('advice is injected only after the stored line is in the finished prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-v2-'));
    const file = join(dir, 'v2.jsonl');
    try {
        const { brain } = receiptBrain(file, { maxAdviceChars: 280 });
        const secret = 'Dig a secret hole under the house';
        stored(brain, secret, 'job-7');
        const missing = 'You are Bob.\n$LONG_MEMORY\nhealth 20';
        const token = brain.observeAssembledPrompt(missing, { conversationPrompt: true, armAction: true });
        assert.equal(typeof token, 'number');
        let events = readEvents(file);
        assert.equal(events.some((event) => event.type === 'advice_injected'), false);
        assert.equal(events.some((event) => event.type === 'advice_rejected' && /not fully present/.test(event.summary)), true);
        assert.equal(readFileSync(file, 'utf8').includes('secret hole'), false);

        const prompt = finishedPrompt(brain);
        assert.match(prompt, /secret hole/);
        const armed = brain.observeAssembledPrompt(prompt, { conversationPrompt: true, armAction: true });
        events = readEvents(file);
        const injected = events.filter((event) => event.type === 'advice_injected');
        assert.equal(injected.length, 1);
        assert.equal(injected[0].trace_id, 'job-7');
        assert.match(injected[0].event_id, /^bob\.[0-9a-f]{8}\.job-7\.advice_injected\.1$/);
        assert.match(injected[0].summary, /kind=plan/);
        assert.match(injected[0].summary, /truncated=no/);
        assert.equal(injected[0].summary.includes('secret hole'), false);
        assert.equal(readFileSync(file, 'utf8').includes(secret), false);
        assert.equal(brain.commitPromptTurn(armed), true);

        brain.observeAssembledPrompt('Write code only.\n$CODE_DOCS', { conversationPrompt: false, armAction: false });
        brain.observeAssembledPrompt('Old Memory.\n$TO_SUMMARIZE', { conversationPrompt: false, armAction: false });
        const rejected = readEvents(file).filter((event) => /no \$LONG_MEMORY/.test(event.summary));
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].trace_id, 'job-7');
        assert.equal(rejected[0].type, 'advice_rejected');

        const body = `${'A'.repeat(279)}TAIL`;
        stored(brain, body, 'job-8');
        brain.observeAssembledPrompt(finishedPrompt(brain), { conversationPrompt: true, armAction: false });
        const truncated = readEvents(file).find((event) => event.trace_id === 'job-8' && event.type === 'advice_injected');
        assert.match(truncated.summary, /truncated=yes/);
        assert.equal(brain._freshAdvice().find((item) => item.jobId === 'job-8').text, '…');
        assert.equal(readFileSync(file, 'utf8').includes('TAIL'), false);
        assert.equal(truncated.summary.includes('AAAA'), false);
        brain.stop();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('dropped advice is a rejection and not a copy of the review', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-v2-'));
    const file = join(dir, 'v2.jsonl');
    try {
        const { brain } = receiptBrain(file, { maxAdvice: 1 });
        brain._storeAdvice({
            id: 'job-1',
            kind: 'plan',
            result: { summary: 'ignore this sentence', validation: { valid: false } },
        });
        brain._storeAdvice({ id: 'job-2', kind: 'plan', result: { summary: '!goal("dig a hole")' } });
        brain._storeAdvice({ id: 'job-3', kind: 'failure_analysis', result: { proposal: {} } });
        stored(brain, 'first note', 'job-4');
        stored(brain, 'second note', 'job-5');
        const events = readEvents(file);
        assert.equal(events.filter((event) => event.type === 'advice_injected').length, 0);
        assert.match(events.find((event) => event.trace_id === 'job-1').summary, /validation\.valid is false/);
        assert.match(events.find((event) => event.trace_id === 'job-2').summary, /stripped/);
        assert.match(events.find((event) => event.trace_id === 'job-3').summary, /no usable advice/);
        assert.match(events.find((event) => event.trace_id === 'job-4').summary, /capped at 1/);
        const raw = readFileSync(file, 'utf8');
        assert.equal(raw.includes('ignore this sentence'), false);
        assert.equal(raw.includes('dig a hole'), false);
        assert.equal(raw.includes('!goal'), false);
        assert.equal(raw.includes('first note'), false);
        assert.equal(brain.adviceBlock().includes('second note'), true);
        assert.equal(brain.adviceBlock().includes('first note'), false);
        brain.stop();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a cut suggestion block rejects the missing line and does not copy it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-v2-'));
    const file = join(dir, 'v2.jsonl');
    try {
        const { brain } = receiptBrain(file, { maxAdviceChars: 280, maxAdviceBlockChars: 900 });
        stored(brain, `ALPHA ${'a'.repeat(270)}`, 'job-1');
        stored(brain, `BETA ${'b'.repeat(270)}`, 'job-2');
        stored(brain, `GAMMA ${'g'.repeat(270)}`, 'job-3');
        const prompt = finishedPrompt(brain);
        brain.observeAssembledPrompt(prompt, { conversationPrompt: true, armAction: false });
        const events = readEvents(file);
        const alpha = events.find((event) => event.trace_id === 'job-1');
        const gamma = events.find((event) => event.trace_id === 'job-3');
        assert.equal(gamma.type, 'advice_injected');
        assert.equal(gamma.summary.includes('GAMMA'), false);
        assert.equal(alpha.type, 'advice_rejected');
        assert.match(alpha.summary, /900/);
        assert.equal(prompt.includes('ALPHA'), false);
        assert.equal(advicePresentInPrompt(prompt, brain._freshAdvice().find((item) => item.jobId === 'job-1')), false);
        assert.equal(readFileSync(file, 'utf8').includes('ALPHA'), false);
        brain.stop();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a command string is not a result, and only the model reply joins the advice trace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-v2-'));
    const file = join(dir, 'v2.jsonl');
    try {
        const { brain } = receiptBrain(file);
        stored(brain, 'Place oak planks', 'job-7');
        stored(brain, 'Then add a roof', 'job-8', 'failure_analysis');
        const prompt = finishedPrompt(brain);
        const token = brain.observeAssembledPrompt(prompt, { conversationPrompt: true, armAction: true });
        assert.equal(brain.commitPromptTurn(token), true);
        const agent = { bobBrain: brain, bot: { output: '', interrupt_code: false, emit() {}, _actionGen: 0 } };

        agent._bobV2ClaimAdvice = false;
        await runCommandPerform(agent, { commandName: '!stats', action: false }, async () => 'health 20');
        let events = readEvents(file);
        const local = events.find((event) => event.type === 'action_started');
        assert.match(local.trace_id, /^bob\.[0-9a-f]{16}$/);
        assert.notEqual(local.trace_id, 'job-7');
        assert.match(events.find((event) => event.type === 'action_result').summary, /outcome=returned/);
        assert.equal(events.find((event) => event.type === 'action_result').summary.includes('health'), false);

        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        agent._bobV2ClaimAdvice = token;
        const pending = runCommandPerform(agent, { commandName: '!collectBlocks', action: true }, () => gate);
        await new Promise((resolve) => setImmediate(resolve));
        const mid = readEvents(file);
        const started = mid.filter((event) => event.type === 'action_started' && event.trace_id === 'job-7');
        assert.equal(started.length, 1);
        assert.equal(started[0].summary.includes('outcome='), false);
        assert.match(started[0].summary, /note=1\/2/);
        assert.equal(mid.some((event) => event.type === 'action_result' && event.trace_id === 'job-7'), false);
        release('Collected 4 oak_log and the model said hello');
        const value = await pending;
        assert.equal(value, 'Collected 4 oak_log and the model said hello');
        events = readEvents(file);
        const results = events.filter((event) => event.type === 'action_result' && (event.trace_id === 'job-7' || event.trace_id === 'job-8'));
        assert.equal(results.length, 2);
        assert.equal(results[0].summary.includes('oak_log'), false);
        assert.equal(results[0].summary.includes('hello'), false);
        assert.match(results[0].summary, /action_id=a2/);
        assert.match(results[1].summary, /action_id=a2/);
        assert.match(results[0].summary, /outcome=returned/);
        assert.equal(results[0].trace_id, 'job-7');
        assert.equal(results[1].trace_id, 'job-8');
        const raw = readFileSync(file, 'utf8');
        assert.equal(raw.includes('Place oak planks'), false);
        assert.equal(raw.includes('Then add a roof'), false);
        brain.stop();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('action runtime reports the observed outcome and does not double-count a command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-v2-'));
    const file = join(dir, 'v2.jsonl');
    try {
        const { brain } = receiptBrain(file);
        const agent = {
            bobBrain: brain,
            cleanKill() {},
            clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false; },
            bot: { output: '', interrupt_code: false, emit() {}, _actionGen: 0 },
        };
        const actions = new ActionManager(agent);
        await actions._executeAction('mode:self_defense', async () => {}, -1);
        let events = readEvents(file);
        assert.equal(events.length, 2);
        assert.equal(events[0].type, 'action_started');
        assert.equal(events[1].type, 'action_result');
        assert.match(events[0].trace_id, /^bob\.[0-9a-f]{16}$/);
        assert.equal(events[0].trace_id, events[1].trace_id);
        assert.match(events[1].summary, /command=mode:self_defense/);
        assert.match(events[1].summary, /outcome=finished/);

        agent._bobV2CommandDepth = 1;
        agent._bobV2OutcomeSlot = { outcome: null };
        const before = events.length;
        await actions._executeAction('action:collectBlocks', async () => {
            agent.bot.interrupt_code = true;
        }, -1);
        assert.equal(readEvents(file).length, before);
        assert.equal(agent._bobV2OutcomeSlot.outcome.interrupted, true);
        agent._bobV2CommandDepth = 0;
        agent._bobV2OutcomeSlot = null;

        await actions._executeAction('mode:unstuck', async () => {
            throw new Error('path said the secret phrase');
        }, -1);
        events = readEvents(file);
        const failed = events[events.length - 1];
        assert.equal(failed.type, 'action_result');
        assert.match(failed.summary, /outcome=threw/);
        assert.equal(readFileSync(file, 'utf8').includes('secret phrase'), false);
        brain.stop();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('file mode, symlink, size cap, and writer failures stay inside the receipt log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-v2-'));
    const file = join(dir, 'v2.jsonl');
    try {
        const { brain } = receiptBrain(file);
        stored(brain, 'Place oak planks', 'job-7');
        brain.observeAssembledPrompt(finishedPrompt(brain), { conversationPrompt: true, armAction: false });
        const mode = statSync(file).mode & 0o777;
        assert.equal(mode, 0o640);
        const size = statSync(file).size;
        const beforeCap = readEvents(file).length;
        brain.receipts.writer.maxBytes = size;
        brain.observeAssembledPrompt(finishedPrompt(brain), { conversationPrompt: true, armAction: false });
        assert.equal(statSync(file).size, size);
        assert.equal(readEvents(file).length, beforeCap);
        assert.match(brain.receipts.writer.log.warnings.join('\n'), /size cap/);

        const loose = join(dir, 'loose.jsonl');
        writeFileSync(loose, 'keep\n');
        chmodSync(loose, 0o644);
        const looseLog = new V2EventLog(resolveV2EventLogConfig({ BOB_BRAIN_V2_EVENT_LOG: loose }), { log: makeLog() });
        const sample = buildV2Event({ traceId: 'job-1', type: 'advice_injected', summary: 'should not land' });
        assert.equal(looseLog.append(sample), false);
        assert.equal(looseLog.append(sample), false);
        assert.equal(readFileSync(loose, 'utf8'), 'keep\n');

        const real = join(dir, 'real.jsonl');
        writeFileSync(real, 'safe\n');
        const link = join(dir, 'link.jsonl');
        symlinkSync(real, link);
        const linkLog = new V2EventLog(resolveV2EventLogConfig({ BOB_BRAIN_V2_EVENT_LOG: link }), { log: makeLog() });
        assert.equal(linkLog.append(sample), false);
        assert.equal(readFileSync(real, 'utf8'), 'safe\n');

        const asDir = join(dir, 'subdir');
        mkdirSync(asDir);
        const dirLog = new V2EventLog(resolveV2EventLogConfig({ BOB_BRAIN_V2_EVENT_LOG: asDir }), { log: makeLog() });
        assert.doesNotThrow(() => dirLog.append(sample));
        assert.equal(dirLog.append(sample), false);

        brain.receipts.writer.disabled = false;
        brain.receipts.writer.full = false;
        brain.receipts.writer.append = () => { throw new Error('disk full'); };
        assert.doesNotThrow(() => brain.observeAssembledPrompt(finishedPrompt(brain), { conversationPrompt: true, armAction: true }));
        const agent = { bobBrain: brain };
        const value = await runCommandPerform(agent, { commandName: '!stop', action: true }, async () => 'Agent stopped.');
        assert.equal(value, 'Agent stopped.');
        await assert.rejects(
            () => runCommandPerform(agent, { commandName: '!stop', action: true }, async () => { throw new Error('boom'); }),
            /boom/
        );
        brain.stop();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('prompter and command hooks are the real paths, and lessons are not a receipt type', () => {
    const prompter = readFileSync(new URL('../src/models/prompter.js', import.meta.url), 'utf8');
    const agent = readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    const commands = readFileSync(new URL('../src/agent/commands/index.js', import.meta.url), 'utf8');
    const runtime = readFileSync(new URL('../src/agent/action_manager.js', import.meta.url), 'utf8');
    const receipts = readFileSync(new URL('../src/agent/library/bob_brain_v2.js', import.meta.url), 'utf8');
    assert.ok(prompter.indexOf('withConversationAdvice') < prompter.lastIndexOf('observeAssembledPrompt'));
    assert.match(prompter, /supersedeTurn/);
    assert.match(prompter, /commitPromptTurn/);
    assert.match(agent, /_bobV2ClaimAdvice = v2Turn/);
    assert.equal(agent.split('_bobV2ClaimAdvice = v2Turn').length, 2);
    const userCommand = agent.slice(agent.indexOf('from user, check for forced commands'), agent.indexOf('Now translate the message'));
    assert.equal(userCommand.includes('_bobV2ClaimAdvice'), false);
    assert.ok(commands.indexOf('return parsed;') < commands.indexOf('performParsed'));
    assert.ok(commands.indexOf('if (blocked) return blocked;') < commands.indexOf('return await performParsed'));
    assert.match(runtime, /noteRuntimeStart/);
    assert.match(runtime, /noteRuntimeFinish/);
    assert.match(receipts, /lesson_applied and lesson_outcome are not emitted/);
    assert.equal(receipts.includes("'lesson_applied'"), false);
    assert.equal(receipts.includes("'lesson_outcome'"), false);
    assert.equal(new BobV2Receipts({ env: {} }).config.enabled, false);
});


test('opt-in bounded receipt rotation reopens active log without touching gameplay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-v2-ring-'));
    const path = join(dir, 'mindcraft.jsonl');
    const log = makeLog();
    try {
        const config = resolveV2EventLogConfig({
            BOB_BRAIN_V2_EVENT_LOG: path, BOB_BRAIN_V2_ROTATE_LOG: '1',
        });
        assert.equal(config.rotateEnabled, true);
        assert.equal(resolveV2EventLogConfig({ BOB_BRAIN_V2_EVENT_LOG: path }).rotateEnabled, false);
        const writer = new V2EventLog(config, { maxBytes: 330, log });
        for (let index = 0; index < 13; index++) {
            const event = buildV2Event({
                traceId: 'job-rotation', eventId: 'receipt.' + index,
                type: 'action_result', summary: 'action returned safely',
            });
            assert.equal(writer.append(event), true);
        }
        writer.close();
        assert.equal(existsSync(path), true);
        for (let index = 1; index <= 4; index++) {
            const archive = path + '.' + index;
            assert.equal(existsSync(archive), true);
            assert.equal((statSync(archive).mode & 0o777), 0o640);
            assert.ok(readEvents(archive).length >= 1);
        }
        assert.ok(readEvents(path).length >= 1);
        assert.equal(log.warnings.join(' ').includes('size cap'), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('opt-in rotation fails safely on symlinked archive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-v2-unsafe-'));
    const path = join(dir, 'mindcraft.jsonl');
    const safe = join(dir, 'keep.txt');
    try {
        writeFileSync(safe, 'do not change me');
        symlinkSync(safe, path + '.1');
        const writer = new V2EventLog(
            resolveV2EventLogConfig({
                BOB_BRAIN_V2_EVENT_LOG: path, BOB_BRAIN_V2_ROTATE_LOG: '1',
            }),
            { maxBytes: 260, log: makeLog() },
        );
        for (let index = 0; index < 5; index++) {
            const event = buildV2Event({
                traceId: 'job-unsafe', eventId: 'unsafe.' + index,
                type: 'action_result', summary: 'safe',
            });
            writer.append(event);
        }
        assert.equal(writer.disabled, true);
        assert.equal(readFileSync(safe, 'utf8'), 'do not change me');
        writer.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

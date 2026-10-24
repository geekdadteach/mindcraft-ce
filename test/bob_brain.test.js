import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    BobBrain,
    DEFAULT_MAX_ADVICE_BLOCK_CHARS,
    DEFAULT_MAX_ADVICE_CHARS,
    HTTP_ERROR_CLIP,
    attachBobBrain,
    clipAdviceText,
    planPayloadForGoal,
    resolveBobBrainConfig,
    toAdvisoryText,
    withConversationAdvice,
} from '../src/agent/library/bob_brain.js';

const TOKEN = 'random-secret-with-minimum-32-bytes';

function writeToken(dir, contents = TOKEN, mode = 0o600) {
    const file = join(dir, 'bob-brain.token');
    writeFileSync(file, contents);
    chmodSync(file, mode);
    return file;
}

function startServer(onRequest) {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body = null;
            if (raw) {
                try { body = JSON.parse(raw); } catch { body = raw; }
            }
            const url = new URL(req.url, 'http://127.0.0.1');
            onRequest({ req, res, body, url });
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                server,
                url: `http://127.0.0.1:${port}`,
                close() {
                    return new Promise((done) => {
                        server.closeAllConnections?.();
                        server.close(() => done());
                    });
                },
            });
        });
    });
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function queueServer(token = TOKEN, options = {}) {
    const requests = [];
    const replies = [];
    const jobs = new Map();
    const jobsByKey = new Map();
    const strictKeys = options.strictKeys === true;
    const api = {
        requests,
        replies,
        jobs,
        listen: null,
    };
    const pending = startServer(({ req, res, body, url }) => {
        requests.push({
            method: req.method,
            path: url.pathname,
            body,
            auth: req.headers.authorization || '',
        });
        if (url.pathname === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, echo: req.headers.authorization || '' }));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/events') {
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/jobs') {
            const clientKey = typeof body?.client_key === 'string' ? body.client_key : '';
            if (strictKeys && clientKey && jobsByKey.has(clientKey)) {
                const prev = jobsByKey.get(clientKey);
                const same = prev.kind === body.kind && stableJson(prev.payload) === stableJson(body.payload);
                if (!same) {
                    const error = { error: 'client_key already used for different job' };
                    replies.push({ status: 400, path: url.pathname, body: error });
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(error));
                    return;
                }
                const replay = { job: prev };
                replies.push({ status: 200, path: url.pathname, body: replay });
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(replay));
                return;
            }
            const id = `job-${jobs.size + 1}`;
            const job = {
                id,
                kind: body.kind,
                status: 'queued',
                result: null,
                error: null,
                client_key: body.client_key,
                payload: body.payload,
            };
            jobs.set(id, job);
            if (clientKey) jobsByKey.set(clientKey, job);
            const created = { job };
            replies.push({ status: 201, path: url.pathname, body: created });
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify(created));
            return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
            const id = decodeURIComponent(url.pathname.slice('/v1/jobs/'.length));
            const job = jobs.get(id);
            if (!job) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ job }));
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
    }).then((listener) => {
        api.listen = listener;
        return api;
    });
    return pending;
}

function posted(requests, path) {
    return requests.filter((entry) => entry.method === 'POST' && entry.path === path);
}

function makeLog() {
    return {
        lines: [],
        warnings: [],
        log(message) { this.lines.push(String(message)); },
        warn(message) { this.warnings.push(String(message)); },
    };
}

function brainOptions(url, extra = {}) {
    let now = 1_000_000;
    return {
        now: () => now,
        advance(ms) { now += ms; },
        log: makeLog(),
        timeoutMs: 1000,
        eventDedupeMs: 500,
        failureGapMs: 1000,
        failureCooldownMs: 10_000,
        deathCooldownMs: 10_000,
        planCooldownMs: 10_000,
        deathCoalesceMs: 30_000,
        errorLogIntervalMs: 60_000,
        pollIntervalMs: 60_000,
        eventRate: 100,
        ...extra,
        url,
    };
}

function makeBrain(url, tokenFile, extra = {}) {
    const opts = brainOptions(url, extra);
    const config = resolveBobBrainConfig({
        BOB_BRAIN_URL: url,
        BOB_BRAIN_TOKEN_FILE: tokenFile,
    });
    assert.equal(config.enabled, true, config.reason);
    const brain = new BobBrain(config, opts);
    return { brain, opts };
}

class FakeBot extends EventEmitter {
    constructor() {
        super();
        this.health = 20;
        this.entity = { position: { x: 1.2, y: 64, z: -3.4 } };
        this.game = { dimension: 'overworld' };
        this.gotoError = Object.assign(new Error('No path to the goal!'), { name: 'NoPath' });
        const bot = this;
        this.pathfinder = {
            async goto() {
                throw bot.gotoError;
            },
        };
    }
}

function makeAgent() {
    const executed = [];
    const agent = {
        name: 'MineBobNE',
        executed,
        executeCommand() { executed.push('executeCommand'); },
        bot: new FakeBot(),
        self_prompter: {
            state: 0,
            prompt: '',
            isStopped() { return this.state === 0; },
            isActive() { return this.state === 1; },
            isPaused() { return this.state === 2; },
            start(prompt) {
                if (!prompt) {
                    if (!this.prompt) return 'No prompt specified. Ignoring request.';
                    prompt = this.prompt;
                }
                this.prompt = prompt;
                this.state = 1;
                return 'started';
            },
            setPromptPaused(prompt) {
                this.prompt = prompt;
                this.state = 2;
            },
            stop() {
                this.state = 0;
                return Promise.resolve('stopped');
            },
        },
        failures: {
            calls: [],
            record(cmd, target, pos, error) {
                this.calls.push({ cmd, target, pos, error });
                return { count: this.calls.length };
            },
        },
    };
    return agent;
}

async function waitFor(fn, ms = 1500) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (fn()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for brain request');
}

test('plan payload is build-style only, with a conservative footprint', () => {
    assert.equal(planPayloadForGoal('collect 16 oak logs'), null);
    assert.deepEqual(planPayloadForGoal('build a house').footprint, { width: 5, depth: 5 });
    assert.equal(planPayloadForGoal('build a house').assumed, true);
    assert.deepEqual(planPayloadForGoal('build a 6x4 hut').footprint, { width: 6, depth: 4 });
    assert.deepEqual(planPayloadForGoal('construct a 3 by 9 bridge').footprint, { width: 3, depth: 9 });
    assert.deepEqual(planPayloadForGoal('building an 8 wide and 10 deep barn').footprint, { width: 8, depth: 10 });
    assert.deepEqual(planPayloadForGoal('build a 99x99 castle').footprint, { width: 32, depth: 32 });
    assert.deepEqual(planPayloadForGoal('build a 0x4 shed').footprint, { width: 1, depth: 4 });
    assert.equal(toAdvisoryText({ summary: 'Dig up. !goal("dig")', commands: ['!kill()'] }).includes('!'), false);
});

test('review results render as plain text and invalid ones are skipped', () => {
    const plan = {
        proposal: {
            footprint: { width: 6, depth: 4 },
            wall_height: 3,
            materials: { oak_planks: 48, glass: 8 },
            stages: [
                { title: 'Lay the floor' },
                { title: 'Raise walls !goal("dig")' },
                { title: 'Add a roof' },
            ],
        },
        validation: { valid: true, issues: [] },
        finish_reason: 'stop',
        review_required: true,
        world_action_taken: false,
        memory_applied: false,
    };
    const planText = toAdvisoryText(plan, 'plan');
    assert.equal(planText, 'footprint 6x4; wall height 3; materials oak_planks 48, glass 8; stages Lay the floor, Raise walls [removed], Add a roof');
    assert.equal(planText.includes('{'), false);
    assert.equal(planText.includes('!'), false);

    const withSummary = {
        ...plan,
        summary: 'Build a small oak hut, then !stop.',
        proposal: { ...plan.proposal, wall_height: 99 },
    };
    const summaryText = toAdvisoryText(withSummary, 'plan');
    assert.equal(summaryText, 'Build a small oak hut, then [removed].');
    assert.equal(summaryText.includes('wall height'), false);

    const failure = {
        proposal: {
            cause: 'no path out of the cave',
            lesson_proposal: 'climb before digging deeper',
            verification_steps: ['face a wall of stone', 'step up one block', 'dig a third stair'],
        },
        validation: { valid: true, issues: [] },
        review_required: true,
        world_action_taken: false,
        memory_applied: false,
    };
    const failureText = toAdvisoryText(failure, 'failure_analysis');
    assert.equal(failureText, 'cause no path out of the cave; lesson climb before digging deeper; check face a wall of stone; step up one block');
    assert.equal(failureText.includes('third stair'), false);
    assert.equal(failureText.includes('{'), false);

    assert.equal(toAdvisoryText({ ...plan, validation: { valid: false, issues: ['footprint'] }, summary: 'ignore me' }, 'plan'), '');
});

test('advice ends on a sentence or word and does not double a period', () => {
    assert.equal(toAdvisoryText({ summary: 'Stay on the bank.' }), 'Stay on the bank.');
    assert.equal(toAdvisoryText({ summary: 'Stay on the bank..' }), 'Stay on the bank.');
    assert.equal(toAdvisoryText({ summary: 'Wait...' }), 'Wait...');
    const summary = 'Stay on the bank. The water is deep. Check: look down and step back onto stone before you swim.';
    const clipped = clipAdviceText(summary, 50);
    assert.equal(clipped, 'Stay on the bank. The water is deep.…');
    assert.equal(/\.\.(?!\.)/.test(clipped), false);
    assert.equal(clipped.includes('Check'), false);
    const words = clipAdviceText('Climb one block then wait for a clear path along the ridge', 24);
    assert.equal(words, 'Climb one block then…');
    assert.equal(/\.\.(?!\.)/.test(words), false);
    assert.equal(clipAdviceText('Supercalifragilistic', 8), '…');
    const lined = clipAdviceText('First line stays.\nCheck: this second line is long and should not be cut in half', 40);
    assert.equal(lined, 'First line stays.…');
});

test('advice caps are configurable and the block keeps the newest notes', () => {
    const tuned = new BobBrain({ enabled: false }, {
        env: { BOB_BRAIN_MAX_ADVICE_CHARS: '1200', BOB_BRAIN_MAX_ADVICE_BLOCK_CHARS: '3000' },
    });
    assert.equal(tuned.maxAdviceChars, 1200);
    assert.equal(tuned.maxAdviceBlockChars, 3000);
    const ignored = new BobBrain({ enabled: false }, {
        env: { BOB_BRAIN_MAX_ADVICE_CHARS: 'nope', BOB_BRAIN_MAX_ADVICE_BLOCK_CHARS: '10' },
    });
    assert.equal(ignored.maxAdviceChars, DEFAULT_MAX_ADVICE_CHARS);
    assert.equal(ignored.maxAdviceBlockChars, DEFAULT_MAX_ADVICE_BLOCK_CHARS);
    assert.equal(DEFAULT_MAX_ADVICE_CHARS, 900);
    assert.equal(DEFAULT_MAX_ADVICE_BLOCK_CHARS, 2500);
    const explicit = new BobBrain({ enabled: false }, {
        maxAdviceChars: 80,
        env: { BOB_BRAIN_MAX_ADVICE_CHARS: '1200' },
    });
    assert.equal(explicit.maxAdviceChars, 80);

    const brain = new BobBrain({ enabled: false }, {
        env: {},
        maxAdvice: 3,
        maxAdviceBlockChars: 220,
    });
    brain._storeAdvice({ id: 'job-1', kind: 'plan', result: { summary: `OLD ${'o'.repeat(40)}` } });
    brain._storeAdvice({ id: 'job-2', kind: 'plan', result: { summary: `MID ${'m'.repeat(40)}` } });
    brain._storeAdvice({ id: 'job-3', kind: 'plan', result: { summary: `NEW ${'n'.repeat(40)}` } });
    const block = brain.adviceBlock();
    assert.match(block, /Bob Brain suggestion \(unverified\)/);
    assert.equal(block.includes('NEW'), true);
    assert.equal(block.includes('OLD'), false);
    assert.equal(block.length <= 220, true);
    assert.equal(block.endsWith('…'), false);
});

test('advice is inserted only into the conversation prompt', () => {
    const note = 'Recent failures\nBob Brain suggestion (unverified): footprint 6x4';
    const conversation = 'You are Bob.\n$LONG_MEMORY\n$STATS';
    const coding = 'Write javascript only.\n$CODE_DOCS\n$SELF_PROMPT';
    const saving = "Old Memory: '$MEMORY'\nRecent conversation:\n$TO_SUMMARIZE";
    const withNote = withConversationAdvice(conversation, note);
    assert.match(withNote, /Bob Brain suggestion \(unverified\)/);
    assert.equal(withNote.includes('$LONG_MEMORY'), false);
    assert.equal(withConversationAdvice(coding, note), coding);
    assert.equal(withConversationAdvice(saving, note), saving);
    assert.equal(coding.includes('Bob Brain'), false);
    assert.equal(saving.includes('Bob Brain'), false);
    const source = readFileSync(new URL('../src/models/prompter.js', import.meta.url), 'utf8');
    assert.match(source, /withConversationAdvice/);
    assert.equal(/else if \(brainNote\)/.test(source), false);
});

test('public enqueue, advice, and status methods track jobs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-brain-'));
    const api = await queueServer();
    try {
        const tokenFile = writeToken(dir);
        const { brain } = makeBrain(api.listen.url, tokenFile);
        const disabled = new BobBrain(resolveBobBrainConfig({}), {
            fetchImpl() { throw new Error('should not be called'); },
        });
        assert.deepEqual(
            await disabled.enqueuePlan({ objective: 'build a hut', footprint: { width: 5, depth: 5 } }),
            { ok: false, reason: 'disabled' }
        );
        assert.deepEqual(disabled.currentAdvice(), []);

        const plan = await brain.enqueuePlan({
            objective: 'build a hut',
            footprint: { width: 6, depth: 4 },
        }, { clientKey: 'plan-hut-1', priority: 9 });
        assert.equal(plan.ok, true);
        assert.equal(plan.id, 'job-1');
        const planBody = posted(api.requests, '/v1/jobs')[0].body;
        assert.equal(planBody.kind, 'plan');
        assert.equal(planBody.client_key, 'plan-hut-1');
        assert.equal(planBody.priority, 5);
        assert.deepEqual(planBody.payload.footprint, { width: 6, depth: 4 });

        const failure = await brain.enqueueFailureAnalysis({ observed_failure: 'fell in a hole' });
        assert.equal(failure.ok, true);
        const failureBody = posted(api.requests, '/v1/jobs')[1].body;
        assert.equal(failureBody.kind, 'failure_analysis');
        assert.match(failureBody.client_key, /^fail:[a-f0-9]{40}$/);
        assert.equal(failureBody.payload.observed_failure, 'fell in a hole');
        assert.equal(brain.status().outstanding_jobs, 2);
        assert.equal(brain.status().enabled, true);
        assert.equal(JSON.stringify(brain.status()).includes(TOKEN), false);

        const review = {
            proposal: {
                footprint: { width: 6, depth: 4 },
                wall_height: 3,
                materials: { oak_planks: 48 },
                stages: [{ title: 'Lay the floor' }, { title: 'Raise walls' }],
            },
            validation: { valid: true, issues: [] },
            review_required: true,
            world_action_taken: false,
            memory_applied: false,
        };
        api.jobs.get('job-1').status = 'review';
        api.jobs.get('job-1').kind = 'plan';
        api.jobs.get('job-1').result = review;
        api.jobs.get(failure.id).status = 'review';
        api.jobs.get(failure.id).kind = 'failure_analysis';
        api.jobs.get(failure.id).result = {
            summary: 'should not be stored',
            validation: { valid: false, issues: ['empty'] },
            proposal: { cause: 'ignored' },
        };
        await brain.pollOnce();
        const advice = brain.currentAdvice();
        assert.equal(advice.length, 1);
        assert.equal(advice[0].kind, 'plan');
        assert.match(advice[0].text, /footprint 6x4/);
        assert.match(advice[0].text, /wall height 3/);
        assert.match(advice[0].text, /oak_planks 48/);
        assert.match(advice[0].text, /Lay the floor/);
        assert.equal(advice[0].text.includes('{'), false);
        assert.match(brain.adviceBlock(), /Bob Brain suggestion \(unverified\)/);
        assert.equal(brain.status().advice, 1);
        assert.equal(brain.status().outstanding_jobs, 0);
        assert.equal(brain.counters.jobs_review, 2);
        brain.stop();
    } finally {
        await api.listen.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('disabled when unconfigured, and a bad URL is refused', async () => {
    const log = makeLog();
    let fetches = 0;
    const disabled = new BobBrain(resolveBobBrainConfig({}), {
        log,
        fetchImpl() { fetches++; return Promise.reject(new Error('should not be called')); },
    });
    await disabled.noteDeath({ cause: 'death', position: { x: 1, y: 2, z: 3 } });
    await disabled.flushPending();
    await disabled.noteGoal('set', 'build a house');
    assert.equal(disabled.status().enabled, false);
    assert.match(disabled.status().reason, /unset/);
    assert.equal(fetches, 0);

    const dir = mkdtempSync(join(tmpdir(), 'bob-brain-'));
    try {
        const tokenFile = writeToken(dir);
        const rejected = resolveBobBrainConfig({
            BOB_BRAIN_URL: 'http://example.com:8765',
            BOB_BRAIN_TOKEN_FILE: tokenFile,
        });
        assert.equal(rejected.enabled, false);
        assert.equal(rejected.rejected, true);
        assert.match(rejected.reason, /loopback/);
        assert.equal(JSON.stringify(rejected).includes(TOKEN), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('bad token file permissions, symlink, and short token disable the client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-brain-'));
    try {
        const secretFile = writeToken(dir, TOKEN, 0o644);
        const loose = resolveBobBrainConfig({ BOB_BRAIN_TOKEN_FILE: secretFile });
        assert.equal(loose.enabled, false);
        assert.match(loose.reason, /private/);
        assert.equal(JSON.stringify(loose).includes(TOKEN), false);

        chmodSync(secretFile, 0o600);
        writeFileSync(secretFile, 'too-short');
        chmodSync(secretFile, 0o600);
        const short = resolveBobBrainConfig({ BOB_BRAIN_TOKEN_FILE: secretFile });
        assert.equal(short.enabled, false);
        assert.match(short.reason, /32/);

        writeFileSync(secretFile, `${TOKEN}\n`);
        chmodSync(secretFile, 0o600);
        const ok = resolveBobBrainConfig({ BOB_BRAIN_TOKEN_FILE: secretFile });
        assert.equal(ok.enabled, true);
        assert.equal(ok.url, 'http://127.0.0.1:8765');
        assert.equal(ok.token, TOKEN);

        const link = join(dir, 'linked-token');
        symlinkSync(secretFile, link);
        const linked = resolveBobBrainConfig({ BOB_BRAIN_TOKEN_FILE: link });
        assert.equal(linked.enabled, false);
        assert.match(linked.reason, /regular file/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('events and jobs are posted, deduped, and keyed so one incident is one job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-brain-'));
    const api = await queueServer();
    try {
        const tokenFile = writeToken(dir);
        const { brain, opts } = makeBrain(api.listen.url, tokenFile);
        const pos = { x: 10, y: 64, z: 20 };

        await brain.noteLowHealth({ health: 4, position: pos });
        await brain.noteLowHealth({ health: 3, position: pos });
        assert.equal(posted(api.requests, '/v1/events').filter((entry) => entry.body.type === 'low_health').length, 1);
        await brain.noteLowHealth({ health: 20, position: pos });
        await brain.noteLowHealth({ health: 5, position: pos });
        assert.equal(posted(api.requests, '/v1/events').filter((entry) => entry.body.type === 'low_health').length, 2);

        await brain.noteFailure({ kind: 'collect:stone', observed_failure: 'no stone nearby', position: pos });
        assert.equal(posted(api.requests, '/v1/jobs').length, 0);
        opts.advance(1000);
        await brain.noteFailure({ kind: 'collect:stone', observed_failure: 'no stone nearby', position: pos });
        const jobs = posted(api.requests, '/v1/jobs');
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].body.kind, 'failure_analysis');
        assert.equal(jobs[0].body.payload.observed_failure, 'no stone nearby');
        assert.match(jobs[0].body.client_key, /^fail:[a-f0-9]{40}$/);
        assert.equal(jobs[0].auth, `Bearer ${TOKEN}`);
        opts.advance(1000);
        await brain.noteFailure({ kind: 'collect:stone', observed_failure: 'no stone nearby', position: pos });
        opts.advance(1000);
        await brain.noteFailure({ kind: 'collect:stone', observed_failure: 'no stone nearby', position: pos });
        assert.equal(posted(api.requests, '/v1/jobs').length, 1);
        opts.advance(10_000);
        await brain.noteFailure({ kind: 'collect:stone', observed_failure: 'no stone nearby', position: pos });
        opts.advance(1000);
        await brain.noteFailure({ kind: 'collect:stone', observed_failure: 'no stone nearby', position: pos });
        const failureJobs = posted(api.requests, '/v1/jobs');
        assert.equal(failureJobs.length, 2);
        assert.equal(failureJobs[0].body.client_key, failureJobs[1].body.client_key);

        await brain.noteGoal('set', 'collect 16 oak logs');
        assert.equal(posted(api.requests, '/v1/jobs').filter((entry) => entry.body.kind === 'plan').length, 0);
        assert.equal(posted(api.requests, '/v1/events').some((entry) => entry.body.type === 'goal_set'), true);

        await brain.noteGoal('set', 'build a 6x4 hut');
        const plans = posted(api.requests, '/v1/jobs').filter((entry) => entry.body.kind === 'plan');
        assert.equal(plans.length, 1);
        assert.deepEqual(plans[0].body.payload.footprint, { width: 6, depth: 4 });
        assert.equal(plans[0].body.payload.objective, 'build a 6x4 hut');
        assert.equal(Object.hasOwn(plans[0].body.payload, 'assumed'), false);
        await brain.noteGoal('set', 'build a 6x4 hut');
        assert.equal(posted(api.requests, '/v1/jobs').filter((entry) => entry.body.kind === 'plan').length, 1);

        await brain.noteDeath({ cause: 'death', position: pos, dimension: 'overworld' });
        await brain.noteDeath({ cause: 'MineBobNE was slain by Zombie', position: pos, dimension: 'overworld' });
        await brain.flushPending();
        const deathJobs = posted(api.requests, '/v1/jobs').filter((entry) => entry.body.kind === 'failure_analysis' && /slain/.test(entry.body.payload.observed_failure));
        assert.equal(deathJobs.length, 1);
        assert.equal(deathJobs[0].body.priority, 1);
        assert.deepEqual(deathJobs[0].body.payload.position, { x: 10, y: 64, z: 20 });
        const deathEvents = posted(api.requests, '/v1/events').filter((entry) => entry.body.type === 'death');
        assert.equal(deathEvents.length, 1);
        assert.match(deathEvents[0].body.payload.cause, /slain by Zombie/);
        await brain.noteDeath({ cause: 'MineBobNE was slain by Zombie', position: pos });
        await brain.flushPending();
        assert.equal(posted(api.requests, '/v1/jobs').filter((entry) => /slain/.test(entry.body.payload?.observed_failure || '')).length, 1);

        const huge = await brain._request('POST', '/v1/events', { source: 'mindcraft', type: 'death', payload: { blob: 'x'.repeat(200_000) } });
        assert.equal(huge.reason, 'too_large');
        assert.equal(api.requests.some((entry) => entry.body?.payload?.blob), false);

        brain.stop();
    } finally {
        await api.listen.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a review result becomes advisory memory and a failed job is only logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-brain-'));
    const api = await queueServer();
    try {
        const tokenFile = writeToken(dir);
        const { brain, opts } = makeBrain(api.listen.url, tokenFile);
        const executed = [];
        brain.executeCommand = () => executed.push('ran');
        await brain.noteGoal('set', 'build a 6x4 hut');
        const job = api.jobs.get('job-1');
        job.status = 'review';
        job.kind = 'plan';
        job.result = {
            summary: 'Start with a floor, then !goal("dig straight down") immediately.',
            commands: ['!kill()', '!collectBlocks("tnt", 64)'],
        };
        await brain.pollOnce();
        const note = brain.adviceBlock();
        assert.match(note, /Bob Brain suggestion \(unverified\)/);
        assert.match(note, /Start with a floor/);
        assert.equal(note.includes('!'), false);
        assert.equal(executed.length, 0);
        assert.equal(brain.counters.jobs_review, 1);
        await brain.pollOnce();
        assert.equal(brain.adviceBlock(), note);

        await brain.noteDeath({ cause: 'MineBobNE drowned', position: { x: 1, y: 2, z: 3 } });
        await brain.flushPending();
        const failed = [...api.jobs.values()].find((entry) => entry.kind === 'failure_analysis');
        failed.status = 'failed';
        failed.error = `worker down ${TOKEN}`;
        await brain.pollOnce();
        assert.equal(brain.adviceBlock().includes('drowned'), false);
        assert.match(opts.log.warnings.join('\n'), new RegExp(`job ${failed.id} failed`));
        assert.equal(opts.log.warnings.join('\n').includes(TOKEN), false);
        assert.match(opts.log.warnings.join('\n'), /\[redacted\]/);
        assert.equal(executed.length, 0);
        brain.stop();
    } finally {
        await api.listen.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('advice never executes a command, including through the live hooks', async () => {
    const source = readFileSync(new URL('../src/agent/library/bob_brain.js', import.meta.url), 'utf8');
    const prompter = readFileSync(new URL('../src/models/prompter.js', import.meta.url), 'utf8');
    assert.equal(/executeCommand|commands\/index|bot\.chat\(/.test(source), false);
    assert.match(prompter, /adviceBlock/);
    assert.equal(prompter.includes('executeCommand(this.agent.bobBrain') || prompter.includes('executeCommand(brain'), false);

    const dir = mkdtempSync(join(tmpdir(), 'bob-brain-'));
    const api = await queueServer();
    try {
        const tokenFile = writeToken(dir);
        const agent = makeAgent();
        const log = makeLog();
        const brain = attachBobBrain(agent, {
            env: { BOB_BRAIN_URL: api.listen.url, BOB_BRAIN_TOKEN_FILE: tokenFile },
            log,
            deathCoalesceMs: 30_000,
            eventDedupeMs: 500,
            failureGapMs: 1000,
            failureCooldownMs: 10_000,
            planCooldownMs: 10_000,
            timeoutMs: 1000,
            now: brainOptions(api.listen.url).now,
        });
        await brain.ready;
        assert.match(log.lines.join('\n'), /\[bob-brain\] enabled/);
        assert.match(log.lines.join('\n'), /health ok/);

        agent.self_prompter.start('build a 6x4 hut');
        await waitFor(() => posted(api.requests, '/v1/jobs').some((entry) => entry.body.kind === 'plan'));
        agent.self_prompter.setPromptPaused('build a house');
        await waitFor(() => posted(api.requests, '/v1/jobs').filter((entry) => entry.body.kind === 'plan').length === 2);
        const stopped = agent.self_prompter.stop();
        await stopped;
        await waitFor(() => posted(api.requests, '/v1/events').some((entry) => entry.body.type === 'goal_cleared'));

        agent.bot.health = 4;
        agent.bot.emit('health');
        await waitFor(() => posted(api.requests, '/v1/events').some((entry) => entry.body.type === 'low_health'));
        agent.bot.emit('health');

        agent.bot.emit('death');
        agent.bot.emit('messagestr', 'MineBobNE was slain by Zombie', null, { translate: 'death.attack.mob' });
        await brain.flushPending();
        assert.equal(posted(api.requests, '/v1/events').filter((entry) => entry.body.type === 'death').length, 1);

        agent.bot.emit('path_reset', 'goal_updated');
        agent.bot.emit('path_reset', 'stuck');
        await waitFor(() => posted(api.requests, '/v1/events').some((entry) => entry.body.type === 'pathfinding_failed' && entry.body.payload.reason === 'stuck'));

        await assert.rejects(() => agent.bot.pathfinder.goto({}), /No path to the goal!/);
        await waitFor(() => posted(api.requests, '/v1/events').some((entry) => entry.body.payload?.reason === 'noPath'));

        const before = posted(api.requests, '/v1/events').length;
        agent.bot.gotoError = Object.assign(
            new Error('Path was stopped before it could be completed! Thus, the desired goal was not reached.'),
            { name: 'PathStopped' }
        );
        await assert.rejects(() => agent.bot.pathfinder.goto({}), /stopped/);
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(posted(api.requests, '/v1/events').length, before);

        const recorded = agent.failures.record('!collectBlocks', 'stuck', { x: 3, y: 4, z: 5 }, 'no movement');
        assert.equal(recorded.count, 1);
        await waitFor(() => posted(api.requests, '/v1/events').some((entry) => entry.body.type === 'stuck'));

        const plan = [...api.jobs.values()].find((entry) => entry.kind === 'plan');
        plan.status = 'review';
        plan.result = { summary: 'Place oak planks. !goal("dig a hole under the house")' };
        await brain.pollOnce();
        const note = brain.adviceBlock();
        assert.match(note, /Bob Brain suggestion \(unverified\)/);
        assert.equal(note.includes('!'), false);
        assert.equal(agent.executed.length, 0);
        const names = Object.getOwnPropertyNames(Object.getPrototypeOf(brain));
        assert.equal(names.some((name) => /execute|perform|chat/i.test(name)), false);
        brain.stop();
    } finally {
        await api.listen.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('brain downtime, HTTP errors, and malformed JSON do not throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-brain-'));
    try {
        const tokenFile = writeToken(dir);
        const log = makeLog();
        let now = 5_000;
        const down = new BobBrain(resolveBobBrainConfig({
            BOB_BRAIN_URL: 'http://127.0.0.1:9',
            BOB_BRAIN_TOKEN_FILE: tokenFile,
        }), {
            log,
            now: () => now,
            timeoutMs: 400,
            errorLogIntervalMs: 60_000,
            deathCoalesceMs: 30_000,
        });
        await down.noteLowHealth({ health: 2, position: { x: 1, y: 2, z: 3 } });
        await down.noteGoal('set', 'build a house');
        await down.probe();
        assert.equal(log.warnings.length, 1);
        assert.equal(log.warnings.join('\n').includes(TOKEN), false);
        assert.equal(down.counters.request_errors >= 2, true);
        down.stop();

        const api = await queueServer();
        const bad = new BobBrain(resolveBobBrainConfig({
            BOB_BRAIN_URL: api.listen.url,
            BOB_BRAIN_TOKEN_FILE: tokenFile,
        }), { log: makeLog(), timeoutMs: 500, errorLogIntervalMs: 60_000, now: () => now });
        api.listen.server.removeAllListeners('request');
        api.listen.server.on('request', (req, res) => {
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
                if (req.url === '/v1/events') {
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: TOKEN }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('not-json');
            });
        });
        const first = await bad.noteLowHealth({ health: 4, position: { x: 1, y: 2, z: 3 } });
        assert.equal(first.ok, false);
        const second = await bad._request('GET', '/health');
        assert.equal(second.reason, 'malformed_json');
        assert.equal(bad.status().enabled, true);
        assert.equal(JSON.stringify(bad.status()).includes(TOKEN), false);
        assert.equal(bad.log.warnings.join('\n').includes(TOKEN), false);
        bad.stop();
        await api.listen.close();

        const hung = await startServer(() => {});
        const slowLog = makeLog();
        const slow = new BobBrain(resolveBobBrainConfig({
            BOB_BRAIN_URL: hung.url,
            BOB_BRAIN_TOKEN_FILE: tokenFile,
        }), { log: slowLog, timeoutMs: 150, errorLogIntervalMs: 60_000, now: () => now });
        const timed = await slow.noteLowHealth({ health: 4, position: { x: 1, y: 2, z: 3 } });
        assert.equal(timed.reason, 'timeout');
        assert.match(slowLog.warnings.join('\n'), /timeout/);
        slow.stop();
        await hung.close();
        assert.equal(now > 0, true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('numeric job ids are polled and advice stays capped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-brain-'));
    const requests = [];
    const api = await startServer(({ req, res, body, url }) => {
        requests.push({ method: req.method, path: url.pathname, body });
        if (url.pathname === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/jobs') {
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ job: { id: 7, kind: body.kind, status: 'queued' } }));
            return;
        }
        if (req.method === 'GET' && url.pathname === '/v1/jobs/7') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                job: { id: 7, kind: 'plan', status: 'review', result: { summary: 'Use oak. !goal("dig")' } },
            }));
            return;
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });
    try {
        const tokenFile = writeToken(dir);
        const { brain } = makeBrain(api.url, tokenFile, { maxAdvice: 2, maxAdviceChars: 80 });
        await brain.noteGoal('set', 'build a hut');
        assert.equal(requests.some((entry) => entry.path === '/v1/jobs/7'), false);
        await brain.pollOnce();
        assert.equal(requests.some((entry) => entry.method === 'GET' && entry.path === '/v1/jobs/7'), true);
        assert.match(brain.adviceBlock(), /Use oak/);
        assert.equal(brain.adviceBlock().includes('!'), false);
        brain._storeAdvice({ id: '8', kind: 'plan', result: { summary: 'second note' } });
        brain._storeAdvice({ id: '9', kind: 'plan', result: { summary: 'third note' } });
        const note = brain.adviceBlock();
        assert.equal(note.includes('Use oak'), false);
        assert.match(note, /second note/);
        assert.match(note, /third note/);
        assert.equal(brain.status().advice, 2);
        brain.stop();
    } finally {
        await api.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('client keys are per request, retries match, and a conflicting key does not loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-brain-'));
    const api = await queueServer(TOKEN, { strictKeys: true });
    try {
        const tokenFile = writeToken(dir);
        const { brain, opts } = makeBrain(api.listen.url, tokenFile, {
            keyBucketMs: 1000,
            deathCooldownMs: 0,
            planCooldownMs: 1000,
            failureGapMs: 1000,
            failureCooldownMs: 1000,
            httpErrorLogIntervalMs: 60_000,
            maxTrackedJobs: 20,
        });
        const cause = 'MineBobNE fell from a high place';
        const posA = { x: 10.2, y: 64.4, z: 20.2 };
        const posB = { x: 14.2, y: 70.2, z: 23.4 };

        await brain.noteDeath({ cause, position: posA, dimension: 'overworld' });
        const first = await brain.flushPending();
        await brain.noteDeath({ cause, position: posB, dimension: 'overworld' });
        const second = await brain.flushPending();
        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        assert.notEqual(first.id, second.id);

        await brain.noteDeath({ cause, position: posB, dimension: 'overworld' });
        const retry = await brain.flushPending();
        assert.equal(retry.ok, true);
        assert.equal(retry.id, second.id);
        assert.equal(api.jobs.size, 2);

        const deaths = posted(api.requests, '/v1/jobs').filter((entry) => String(entry.body.client_key).startsWith('death:'));
        assert.equal(deaths.length, 3);
        assert.match(deaths[0].body.client_key, /^death:[a-f0-9]{40}$/);
        assert.equal(deaths[0].body.client_key.length <= 128, true);
        assert.notEqual(deaths[0].body.client_key, deaths[1].body.client_key);
        assert.equal(deaths[1].body.client_key, deaths[2].body.client_key);
        assert.deepEqual(deaths[0].body.payload.position, { x: 10, y: 64, z: 20 });
        assert.deepEqual(deaths[1].body.payload.position, { x: 14, y: 70, z: 23 });
        assert.deepEqual(api.replies.slice(0, 3).map((entry) => entry.status), [201, 201, 200]);

        opts.advance(1000);
        await brain.noteDeath({ cause, position: posB, dimension: 'overworld' });
        const later = await brain.flushPending();
        assert.equal(later.ok, true);
        assert.notEqual(later.id, second.id);
        const deathKeys = posted(api.requests, '/v1/jobs')
            .filter((entry) => String(entry.body.client_key).startsWith('death:'))
            .map((entry) => entry.body.client_key);
        assert.notEqual(deathKeys[2], deathKeys[3]);
        assert.equal(api.replies[3].status, 201);

        await brain.noteFailure({ kind: 'collect:stone', observed_failure: 'no stone nearby', position: posA });
        opts.advance(1000);
        const fail1 = await brain.noteFailure({ kind: 'collect:stone', observed_failure: 'no stone nearby', position: posA });
        opts.advance(1000);
        await brain.noteFailure({ kind: 'collect:stone', observed_failure: 'pickaxe broke', position: posB });
        opts.advance(1000);
        const fail2 = await brain.noteFailure({ kind: 'collect:stone', observed_failure: 'pickaxe broke', position: posB });
        assert.equal(fail1.ok, true);
        assert.equal(fail2.ok, true);
        assert.notEqual(fail1.id, fail2.id);
        const failPosts = posted(api.requests, '/v1/jobs').filter((entry) => entry.body.kind === 'failure_analysis' && entry.body.payload.action === 'collect:stone');
        assert.equal(failPosts.length, 2);
        assert.match(failPosts[0].body.client_key, /^fail:[a-f0-9]{40}$/);
        assert.notEqual(failPosts[0].body.client_key, failPosts[1].body.client_key);

        const hut = await brain.noteGoal('set', 'build a 6x4 hut');
        const barn = await brain.noteGoal('set', 'build an 8x8 barn');
        assert.equal(hut.ok, true);
        assert.equal(barn.ok, true);
        assert.notEqual(hut.id, barn.id);
        const goalPlans = posted(api.requests, '/v1/jobs').filter((entry) => entry.body.kind === 'plan' && /hut|barn/.test(entry.body.payload.objective));
        assert.equal(goalPlans.length, 2);
        assert.match(goalPlans[0].body.client_key, /^plan:[a-f0-9]{40}$/);
        assert.notEqual(goalPlans[0].body.client_key, goalPlans[1].body.client_key);
        assert.equal(api.replies.find((entry) => entry.body?.job?.id === hut.id).status, 201);
        assert.equal(api.replies.find((entry) => entry.body?.job?.id === barn.id).status, 201);

        const payload = { objective: 'build a hut', footprint: { width: 6, depth: 4 } };
        const reordered = { footprint: { depth: 4, width: 6 }, objective: 'build a hut' };
        const plan1 = await brain.enqueuePlan(payload);
        const plan2 = await brain.enqueuePlan(reordered);
        assert.equal(plan1.ok, true);
        assert.equal(plan2.ok, true);
        assert.equal(plan1.id, plan2.id);
        const hutPosts = posted(api.requests, '/v1/jobs').filter((entry) => entry.body.payload?.objective === 'build a hut' && entry.body.kind === 'plan');
        assert.equal(hutPosts.length, 2);
        assert.equal(hutPosts[0].body.client_key, hutPosts[1].body.client_key);
        assert.match(hutPosts[0].body.client_key, /^plan:[a-f0-9]{40}$/);

        opts.advance(1000);
        const plan3 = await brain.enqueuePlan(payload);
        assert.equal(plan3.ok, true);
        assert.notEqual(plan3.id, plan1.id);
        const hutKeys = posted(api.requests, '/v1/jobs')
            .filter((entry) => entry.body.payload?.objective === 'build a hut' && entry.body.kind === 'plan')
            .map((entry) => entry.body.client_key);
        assert.notEqual(hutKeys[1], hutKeys[2]);

        assert.equal(opts.log.warnings.length, 0);
        const created = await brain.enqueuePlan(
            { objective: 'build a barn', footprint: { width: 4, depth: 4 } },
            { clientKey: 'plan-barn' }
        );
        assert.equal(created.ok, true);
        const conflict = await brain.enqueueFailureAnalysis(
            { observed_failure: 'UNIQUE_PAYLOAD_SENTINEL fell' },
            { clientKey: 'plan-barn' }
        );
        assert.deepEqual(
            { ok: conflict.ok, reason: conflict.reason, status: conflict.status },
            { ok: false, reason: 'client_key_conflict', status: 400 }
        );
        for (let i = 0; i < 4; i++) {
            const again = await brain.enqueueFailureAnalysis(
                { observed_failure: 'UNIQUE_PAYLOAD_SENTINEL fell', n: i },
                { clientKey: 'plan-barn' }
            );
            assert.equal(again.reason, 'client_key_conflict');
        }
        const barnPosts = api.requests.filter((entry) => entry.body?.client_key === 'plan-barn');
        assert.equal(barnPosts.length, 6);
        assert.equal(opts.log.warnings.length, 1);
        const line = opts.log.warnings[0];
        assert.match(line, /\[bob-brain\] HTTP 400 POST \/v1\/jobs: client_key already used for different job \(x1\)/);
        assert.equal(line.includes('UNIQUE_PAYLOAD_SENTINEL'), false);
        assert.equal(line.includes(TOKEN), false);
        assert.equal(line.includes('Authorization'), false);
        assert.equal(line.includes('payload'), false);
        assert.equal(brain.counters.client_key_conflicts, 5);
        assert.equal(brain.status().counters.client_key_conflicts, 5);
        brain.stop();
    } finally {
        await api.listen.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('non-2xx responses log the server error once per text, without the payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-brain-'));
    let errorBody = () => ({
        error: `queue busy \n\t${'B'.repeat(200)}\u0001`,
        leaked: 'PAYLOAD_SENTINEL',
        token: TOKEN,
    });
    const api = await startServer(({ req, res }) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(503, {
            'content-type': 'application/json',
            authorization: req.headers.authorization || '',
            'x-token': TOKEN,
        });
        res.end(JSON.stringify(errorBody()));
    });
    try {
        const tokenFile = writeToken(dir);
        const { brain, opts } = makeBrain(api.url, tokenFile, { httpErrorLogIntervalMs: 5000 });
        const send = () => brain._request('POST', '/v1/jobs', {
            kind: 'plan',
            payload: { objective: 'PAYLOAD_SENTINEL' },
            client_key: 'k',
            priority: 0,
        });
        await send();
        await send();
        await send();
        assert.equal(opts.log.warnings.length, 1);
        const match = opts.log.warnings[0].match(/^\[bob-brain\] HTTP 503 POST \/v1\/jobs: (.*) \(x1\)$/);
        assert.ok(match);
        assert.equal(match[1].length, HTTP_ERROR_CLIP);
        assert.equal(match[1].startsWith('queue busy B'), true);
        assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(opts.log.warnings.join('\n')), false);
        assert.equal(opts.log.warnings[0].includes('PAYLOAD_SENTINEL'), false);
        assert.equal(opts.log.warnings[0].includes(TOKEN), false);
        assert.equal(opts.log.warnings[0].includes('Bearer'), false);
        assert.equal(brain.counters.request_errors, 3);
        assert.equal(brain.counters.client_key_conflicts, 0);

        errorBody = () => ({ error: `disk ${TOKEN} full`, leaked: 'PAYLOAD_SENTINEL' });
        await send();
        assert.equal(opts.log.warnings.length, 2);
        assert.match(opts.log.warnings[1], /HTTP 503 POST \/v1\/jobs: disk \[redacted\] full \(x1\)/);
        assert.equal(opts.log.warnings[1].includes(TOKEN), false);
        assert.equal(opts.log.warnings[1].includes('PAYLOAD_SENTINEL'), false);

        errorBody = () => ({ error: { detail: 'PAYLOAD_SENTINEL' }, request: { secret: 'PAYLOAD_SENTINEL' } });
        const weird = await send();
        assert.equal(weird.reason, 'http_error');
        assert.match(opts.log.warnings[2], /^\[bob-brain\] HTTP 503 POST \/v1\/jobs \(x1\)$/);
        assert.equal(opts.log.warnings[2].includes('PAYLOAD_SENTINEL'), false);

        errorBody = () => ({
            error: `queue busy \n\t${'B'.repeat(200)}\u0001`,
            leaked: 'PAYLOAD_SENTINEL',
        });
        opts.advance(5000);
        await send();
        assert.equal(opts.log.warnings.length, 4);
        assert.match(opts.log.warnings[3], /HTTP 503 POST \/v1\/jobs: queue busy B/);
        assert.match(opts.log.warnings[3], /\(x3\)$/);
        assert.equal(opts.log.warnings[3].includes('PAYLOAD_SENTINEL'), false);
        assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(opts.log.warnings[3]), false);
        brain.stop();
    } finally {
        await api.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('startup reports disabled when the token file is unreadable', () => {
    const agent = makeAgent();
    const log = makeLog();
    const brain = attachBobBrain(agent, { env: {}, log });
    assert.equal(brain.status().enabled, false);
    assert.match(log.lines.join('\n'), /\[bob-brain\] disabled: BOB_BRAIN_TOKEN_FILE is unset/);
    agent.self_prompter.start('build a house');
    assert.equal(agent.executed.length, 0);
    const again = attachBobBrain(agent, {
        env: { BOB_BRAIN_TOKEN_FILE: '/no/such/token', BOB_BRAIN_URL: 'http://127.0.0.1:8765' },
        log,
    });
    assert.equal(again, brain);
});

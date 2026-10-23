import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    BobBrain,
    attachBobBrain,
    planPayloadForGoal,
    resolveBobBrainConfig,
    toAdvisoryText,
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

function queueServer(token = TOKEN) {
    const requests = [];
    const jobs = new Map();
    const api = {
        requests,
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
            const id = `job-${jobs.size + 1}`;
            const job = {
                id,
                kind: body.kind,
                status: 'queued',
                result: null,
                error: null,
                client_key: body.client_key,
            };
            jobs.set(id, job);
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ job }));
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

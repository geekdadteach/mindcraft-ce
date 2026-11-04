// [bob-eval] Offline harness: drives the REAL Agent.handleMessage / SelfPrompter / RepeatGuard /
// executeCommand / ActionManager / TaskLifecycle against a mocked LLM and a fake world. No server, no network,
// no keys. Only command `perform` bodies are simulated (see sim_commands.js).
import { Agent } from '../../src/agent/agent.js';
import { ActionManager } from '../../src/agent/action_manager.js';
import { SelfPrompter } from '../../src/agent/self_prompter.js';
import { RepeatGuard } from '../../src/agent/library/repeat_guard.js';
import settings, { setSettings } from '../../src/agent/settings.js';
import { loadMcDataOffline } from '../../src/utils/mcdata.js';
import { evalEnabled, evalNotePrompt, evalSetContext, evalAddCollector, evalTraceInfo, evalRecord, evalResetForTests }
    from '../../src/agent/library/bob_eval_trace.js';
import { FakeWorld, createFakeBot } from './fake_world.js';
import { installSimCommands } from './sim_commands.js';
import { SCENARIOS } from './scenarios.js';
import { verifyObjective } from './verify.js';
import { collectIncidents, summarizeTrace, classifyFailure, countByClass } from './classify.js';

export const MC_VERSION = '1.21.6';
const HARNESS_SETTINGS = { language: 'en', max_commands: -1, only_chat_with: [], speak: false, blocked_actions: [] };

class FakeHistory {
    constructor(agent) { this.agent = agent; this.turns = []; }
    async add(name, content) {
        const role = name === this.agent.name ? 'assistant' : (name === 'system' ? 'system' : 'user');
        this.turns.push({ role, content: role === 'user' ? `${name}: ${content}` : String(content) });
    }
    getHistory() { return structuredClone(this.turns); }
    save() {}
}

// Mocked LLM: one scripted reply per call. When the script (or turn budget) runs out it ends the
// self-prompt loop and returns '' (an empty reply ends Agent.handleMessage's loop).
class ScriptedPrompter {
    constructor(agent, script, { model = 'mock-llm/scripted', maxCalls = 20 } = {}) {
        this.agent = agent; this.script = [...script]; this.maxCalls = maxCalls;
        this.calls = 0; this.exhaustedTurns = new Set();
        this.chat_model = { model_name: model };
        this.profile = { name: agent.name, model };
    }
    getName() { return this.agent.name; }
    async promptConvo(messages) {
        this.calls++;
        const prompt = `scripted-eval-prompt\n${JSON.stringify(messages)}`;
        evalNotePrompt(this.agent, prompt, this.chat_model.model_name);   // same hook point as the real Prompter
        if (this.calls > this.maxCalls || this.script.length === 0) {
            if (this.agent._evalTurnId) this.exhaustedTurns.add(this.agent._evalTurnId);
            await this.agent.self_prompter.stop(false);
            return '';
        }
        const step = this.script.shift();
        return typeof step === 'function' ? String(await step(this.agent)) : String(step);
    }
}

export function createHarnessAgent({ bot, script, model, maxCalls }) {
    const agent = Object.create(Agent.prototype);
    Object.assign(agent, {
        name: bot.username, bot, count_id: 0, task: { data: null, blocked_actions: [] },
        shut_up: false, last_sender: null, blocked_actions: [], routed: [],
        last_reply_was_model_error: false,
    });
    agent.history = new FakeHistory(agent);
    agent.prompter = new ScriptedPrompter(agent, script, { model, maxCalls });
    agent.actions = new ActionManager(agent);
    agent.self_prompter = new SelfPrompter(agent);
    agent.self_prompter.cooldown = 0;
    agent._repeatGuard = new RepeatGuard();
    // Same listener as the Agent constructor: recent non-success task events feed the next self-prompt.
    agent._recentTaskEvents = [];
    agent._taskEventSerial = 0;
    bot.on('bob_task_event', event => {
        if (!['task.cancel_requested', 'task.uncertain', 'task.finished'].includes(event?.type)) return;
        if (event.type === 'task.finished' && event.state === 'succeeded') return;
        agent._recentTaskEvents.push({ serial: ++agent._taskEventSerial, type: event.type,
            label: String(event.label || '').slice(0, 80), taskId: String(event.taskId || '').slice(0, 80),
            reason: String(event.reason || '').slice(0, 110), state: String(event.state || '').slice(0, 30) });
        if (agent._recentTaskEvents.length > 12) agent._recentTaskEvents.splice(0, agent._recentTaskEvents.length - 12);
    });
    agent.routeResponse = async (to, message, opts = {}) => { agent.routed.push({ to, message: String(message), talk: !!opts.talk }); };
    agent.openChat = async () => {};
    agent.cleanKill = (msg) => { throw new Error(`cleanKill called in harness: ${msg}`); };
    return agent;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function driveSelfPrompt(agent, goal, timeoutMs) {
    agent.self_prompter.start(goal);
    const until = Date.now() + timeoutMs;
    await sleep(0);
    while (agent.self_prompter.loop_active || agent.actions.executing) {
        if (Date.now() > until) {
            await agent.self_prompter.stop(false);
            return 'timeout';
        }
        await sleep(5);
    }
    return null;
}

function quietConsole(enabled) {
    if (!enabled) return () => {};
    const saved = { log: console.log, info: console.info, warn: console.warn, debug: console.debug };
    console.log = console.info = console.warn = console.debug = () => {};
    return () => Object.assign(console, saved);
}

function expectationMatch(expect, passed, failureClass, counts) {
    const reasons = [];
    if (!!expect.pass !== passed) reasons.push(`expected objective ${expect.pass ? 'pass' : 'fail'}, got ${passed ? 'pass' : 'fail'}`);
    if (!passed && expect.failure_class && expect.failure_class !== failureClass)
        reasons.push(`expected failure class ${expect.failure_class}, got ${failureClass}`);
    if (expect.min_guard_blocks && counts.guard < expect.min_guard_blocks)
        reasons.push(`expected >= ${expect.min_guard_blocks} guard block(s), got ${counts.guard}`);
    return reasons;
}

// Runs one scenario with a fresh world + agent. `faults` injects simulated failures for tests.
export async function runScenario(scenario, { faults = {}, timeoutMs = 15000, quiet = true, scriptOverride = null, botOverrides = null } = {}) {
    if (!evalEnabled()) throw new Error('bob-eval harness needs BOB_EVAL=1 (run.js sets it for its own process)');
    const world = new FakeWorld();
    scenario.setup?.(world);
    const bot = createFakeBot(world, { position: scenario.start.position, inventory: scenario.start.inventory });
    if (botOverrides) Object.assign(bot, botOverrides);
    const agent = createHarnessAgent({ bot, script: scriptOverride || scenario.script });

    const events = [];
    const removeCollector = evalAddCollector(e => { if (e.ctx?.scenario === scenario.id) events.push(e); });
    evalSetContext({ scenario: scenario.id });
    evalRecord(agent, 'scenario_start', { scenario: scenario.id, goal: scenario.goal });
    const restoreSims = installSimCommands({ faults });
    const restoreConsole = quietConsole(quiet);
    let error = null;
    try {
        error = await driveSelfPrompt(agent, scenario.goal, timeoutMs);
    } catch (err) {
        error = `harness exception: ${err?.message || err}`;
    } finally {
        restoreConsole();
        restoreSims();
    }
    const objective = verifyObjective(scenario.checks, { bot, world });
    evalRecord(agent, 'objective_check', { scenario: scenario.id, passed: objective.passed,
        checks: objective.results.map(r => ({ desc: r.desc, actual: r.actual, passed: r.passed })) });
    evalSetContext(null);
    removeCollector();

    const scored = events.filter(e => !agent.prompter.exhaustedTurns.has(e.turn_id));
    const incidents = collectIncidents(scored);
    const trace_summary = summarizeTrace(scored);
    let failure_class = classifyFailure(objective.passed, incidents, trace_summary);
    if (error && !objective.passed && !failure_class) failure_class = 'action';
    const incident_counts = countByClass(incidents);
    const expected = scenario.expect || { pass: true };
    const mismatch_reasons = expectationMatch(expected, objective.passed, failure_class, incident_counts);
    return {
        id: scenario.id, title: scenario.title, goal: scenario.goal,
        passed: objective.passed, failure_class, expected, matched_expectation: mismatch_reasons.length === 0, mismatch_reasons,
        checks: objective.results, incidents, incident_counts, trace_summary, error,
        final_state: { position: { ...bot.entity.position }, inventory: bot.inventory.snapshot() },
        model_calls: agent.prompter.calls,
        trace_file: evalTraceInfo()?.file || null,
        _events: scored,
    };
}

export async function runAll({ only = null, faults = {}, quiet = true, timeoutMs } = {}) {
    if (!evalEnabled()) throw new Error('bob-eval harness needs BOB_EVAL=1');
    loadMcDataOffline(MC_VERSION);
    const savedSettings = { ...settings };
    setSettings({ ...savedSettings, ...HARNESS_SETTINGS });
    const scenarios = [];
    try {
        for (const s of SCENARIOS) {
            if (only && !only.includes(s.id)) continue;
            scenarios.push(await runScenario(s, { faults: faults[s.id] || {}, quiet, timeoutMs }));
        }
    } finally {
        setSettings(savedSettings);
    }
    const info = evalTraceInfo();
    const report = {
        run_id: info?.runId || null,
        generated_at: new Date().toISOString(),
        mode: 'offline (mock LLM + fake world)',
        node: process.version,
        trace_file: info?.file || null,
        scenarios: scenarios.map(({ _events, ...rest }) => rest),
        summary: {
            total: scenarios.length,
            passed: scenarios.filter(s => s.passed).length,
            matched: scenarios.filter(s => s.matched_expectation).length,
            failure_classes: Object.fromEntries(scenarios.filter(s => s.failure_class).map(s => [s.id, s.failure_class])),
        },
    };
    return { report, events: Object.fromEntries(scenarios.map(s => [s.id, s._events])) };
}

export { evalResetForTests };

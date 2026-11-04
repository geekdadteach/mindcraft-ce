// [bob-eval] Failure classification from the correlated trace of one scenario.
// Classes: model/prompt, parser, guard, action, objective.
export const FAILURE_CLASSES = ['model/prompt', 'parser', 'guard', 'action', 'objective'];

// Same spirit as the failure text real skills write to bot.output ("Could not find...", "You do not have
// the resources...", "Path not found"); ActionManager still reports success for these, which is exactly why
// objectives are verified against world state.
export const ACTION_FAILURE_RE = /(could not|couldn't|cannot|can't|not found|no path|failed|unable|do not have|don't have|not simulated|!!Code threw exception)/i;

export function collectIncidents(events) {
    const incidents = [];
    // Turns in which an action really started (ActionManager -> TaskLifecycle task.started).
    const ranAction = new Set(events.filter(e => e.type === 'task_event' && e.event?.type === 'task.started').map(e => e.turn_id));
    const add = (cls, e, note) => incidents.push({ class: cls, turn_id: e.turn_id, seq: e.seq, type: e.type, note: String(note ?? '').slice(0, 200) });
    const guarded = new Set(events.filter(e => e.type === 'command_guard').map(e => e.turn_id));
    const parseFailed = new Set(events.filter(e => e.type === 'command_parse' && e.ok === false).map(e => e.turn_id));
    const parsedOk = new Set(events.filter(e => e.type === 'command_parse' && e.ok).map(e => e.turn_id));
    for (const e of events) {
        if (e.type === 'llm_response' && (e.empty || e.model_error)) add('model/prompt', e, e.empty ? 'empty reply' : 'model error reply');
        if (e.type === 'parsed_command' && e.command && e.exists === false) add('parser', e, `unknown command ${e.command}`);
        if (e.type === 'command_parse' && e.ok === false) add('parser', e, e.error);
        // Parsed fine but rejected before any guard ran (wrong argument count): still a parser-layer problem.
        if (e.type === 'execute_result' && parsedOk.has(e.turn_id) && !guarded.has(e.turn_id) && !parseFailed.has(e.turn_id))
            add('parser', e, String(e.result ?? 'arguments rejected'));
        if (e.type === 'repeat_guard' && e.blocked) add('guard', e, `RepeatGuard: ${e.note}`);
        if (e.type === 'command_guard' && e.blocked) add('guard', e, `command guard: ${e.note}`);
        if (e.type === 'task_event') {
            const ev = e.event || {};
            if (ev.type === 'task.uncertain') add('action', e, `task uncertain: ${ev.reason}`);
            if (ev.type === 'task.finished' && ev.state !== 'succeeded') add('action', e, `task ${ev.state}: ${ev.reason || ''}`);
        }
        if (e.type === 'execute_result' && e.action && ranAction.has(e.turn_id) && typeof e.result === 'string' && ACTION_FAILURE_RE.test(e.result))
            add('action', e, e.result.replace(/\s+/g, ' '));
    }
    return incidents;
}

export function summarizeTrace(events) {
    const turns = new Set(events.filter(e => e.type === 'turn_start').map(e => e.turn_id));
    // A command counts as executed only when it passed parsing and every guard and reached perform().
    const executed = events.filter(e => e.type === 'command_guard' && !e.blocked);
    const noCommandReplies = events.filter(e => e.type === 'parsed_command' && !e.command).length;
    const taskStates = events.filter(e => e.type === 'task_event' && e.event?.type === 'task.finished').map(e => e.event.state);
    return { turns: turns.size, executed: executed.length, no_command_replies: noCommandReplies, task_states: taskStates };
}

// Primary class when the objective failed: the earliest layer that explains it, by priority.
export function classifyFailure(objectivePassed, incidents, summary) {
    if (objectivePassed) return null;
    const has = c => incidents.some(i => i.class === c);
    if (has('action')) return 'action';
    if (has('guard')) return 'guard';
    if (summary.executed === 0) return has('parser') ? 'parser' : 'model/prompt';
    // Commands ran and nothing reported a failure, yet the world check failed: the success signals
    // (task.finished=succeeded, action output) disagree with the world, or the plan stopped short.
    return 'objective';
}

export function countByClass(incidents) {
    const out = Object.fromEntries(FAILURE_CLASSES.map(c => [c, 0]));
    for (const i of incidents) out[i.class] = (out[i.class] || 0) + 1;
    return out;
}

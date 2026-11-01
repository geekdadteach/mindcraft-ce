// [ai-player] 2026-11-01 - autonomy: self-prompting must never stay off (BOB_AUTONOMY=0 opts out).
//
// A stop by the MODEL (its own !stfu / !endGoal during a self-prompt or system turn) is ignored while autonomy
// is on, so it never reaches STOPPED at all. A stop by a PLAYER is a short pause, not a permanent stop: it
// holds for BOB_PLAYER_STOP_SEC (default 30 s), during which the idle watchdog, the night release(), the
// death/respawn handlers and the boot path may not resume him. Once the pause is over he resumes as soon as
// he is idle and not in a conversation or a night hold. A player's new !goal resumes him immediately.
//
// A saved STOPPED state with no stopped_by (a legacy save) counts as a model stop, so it is restarted.
// Survival modes (eat, flee, getFood, bed/shelter) run whatever the self-prompt state is - this module never
// gates them.
//
// Leaf module on purpose: no imports, so agent.js, self_prompter.js, modes.js and commands/actions.js can all
// use it without a cycle.

// How long he may sit idle before the watchdog starts the default goal (a model or legacy stop).
export const AUTONOMY_IDLE_RESTART_MS = 120000;

// How long a player's stop holds before autonomy resumes.
export const DEFAULT_PLAYER_STOP_SEC = 30;

// The goal used when there is no saved self-prompt to resume.
export const DEFAULT_SURVIVAL_GOAL = 'Stay alive and keep improving your homestead: keep food and health up, keep your bed and shelter safe, and finish what you started.';

export function autonomyEnabled(env = process.env) {
    return env?.BOB_AUTONOMY !== '0';
}

// BOB_PLAYER_STOP_SEC in ms; a bad or negative value falls back to the 30 s default.
export function playerStopMs(env = process.env) {
    const n = Number(env?.BOB_PLAYER_STOP_SEC);
    return Number.isFinite(n) && n >= 0 ? n * 1000 : DEFAULT_PLAYER_STOP_SEC * 1000;
}

// True when this command came from the model's own self-prompt or system turn (set by agent.js around
// executeCommand). Used by !stfu / !endGoal to ignore a model stop.
export function isModelTurn(agent) {
    return agent?._commandSelfPrompt === true;
}

// The model's own stop commands are ignored while autonomy is on. With BOB_AUTONOMY=0 the old behaviour
// returns: the model may stop him (and that stop is recorded as 'model').
export function modelStopIgnored(agent, { env = process.env } = {}) {
    return autonomyEnabled(env) && isModelTurn(agent);
}

// Who asked for the stop, for self_prompter.stopped_by.
export function stopSource(agent) {
    return isModelTurn(agent) ? 'model' : 'player';
}

// True while a player's stop is still holding him (autonomy on and the pause has not elapsed yet).
export function playerStopHolding({ stopped_by, stopped_at, now = Date.now(), env = process.env } = {}) {
    if (!autonomyEnabled(env)) return false;
    if (stopped_by !== 'player') return false;
    return now - Number(stopped_at || 0) < playerStopMs(env);
}

// The single rule the watchdog, release(), releaseNightHold(), the death/respawn handlers and the boot path
// all share: may autonomy be resumed right now?
export function canAutoRestart({ state, stopped_by, stopped_at, now = Date.now(), env = process.env } = {}) {
    if (!autonomyEnabled(env)) return false;
    if (state !== 0) return false; // STOPPED
    if (stopped_by !== 'player') return true; // a model stop or a legacy save
    return now - Number(stopped_at || 0) >= playerStopMs(env);
}

// An independent gameplay guard, not a Brain queue client.
// One repeated failing objective pauses; it never stops the bot.

import { coordCellLabel, SIGNATURE_CELL_SIZE } from './bob_nav_memory.js';

function normalize(value) {
    return String(value ?? '')
        .trim().toLowerCase().replace(/\s+/g, ' ')
        .slice(0, 160);
}

function coarsenTarget(target) {
    const text = String(target ?? '');
    const nums = text.match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 3) {
        return coordCellLabel(
            Number(nums[0]),
            Number(nums[1]),
            Number(nums[2]),
            SIGNATURE_CELL_SIZE
        );
    }
    return normalize(target);
}

export function goalFailureSignature(action, target, error) {
    const text = normalize(error);
    let reason;

    if (/no[\s_-]*path|nopath|unreachable/.test(text))
        reason = 'no_path';
    else if (/timed?\s*out|timeout|took to long/.test(text))
        reason = 'timeout';
    else if (/could not find|couldn't find|not found|no target|nothing nearby|no .+ nearby/.test(text))
        reason = 'no_target';
    else
        reason = text.replace(/-?\d+(?:\.\d+)?/g, '#');

    const targetKey = reason === 'no_path'
        ? coarsenTarget(target)
        : normalize(target);

    return `${normalize(action)}|${targetKey}|${reason}`;
}

export class GoalFailureCircuit {
    constructor({
        now = Date.now,
        windowMs = 30 * 60_000,
        minGapMs = 15_000,
        threshold = 3
    } = {}) {
        this.now = now;
        this.windowMs = windowMs;
        this.minGapMs = minGapMs;
        this.threshold = threshold;
        this.goal = '';
        this.failures = new Map();
        this.tripped = null;
        this.blockedGoals = new Map();
        this.alternativeIndex = 0;
    }

    reset(goal) {
        this.goal = normalize(goal);
        this.failures.clear();
        this.tripped = null;
    }

    // Same objective (night/mode restart) keeps the failure window.
    // A different objective starts a new count.
    continueGoal(goal) {
        const next = normalize(goal);
        if (next === this.goal)
            return false;
        this.reset(goal);
        return true;
    }


    // Select a different, useful objective without stopping autonomy.
    // Only tasks that have not recently failed are eligible.
    nextAutonomousGoal() {
        if (!this.tripped)
            return null;

        const now = this.now();
        const cooldown = 30 * 60_000;

        this.blockedGoals.set(this.goal, now + cooldown);

        for (const [goal, until] of this.blockedGoals) {
            if (until <= now)
                this.blockedGoals.delete(goal);
        }

        const alternatives = [
            'Prioritize survival: inspect food, health, and safety. If hungry, obtain and eat food. If endangered, seek shelter. Do not pursue optional work before stabilizing.',
            'Choose an achievable new outdoor activity such as gathering food, exploring a safe route, farming, or collecting needed materials. Your claim is property, not a movement boundary.',
            'Explore a previously unvisited safe surface area outside your claim and outside protected zones. Begin with a nearby reachable location, stay out of hazards, and record useful discoveries.',
            'Check your supplies and choose a different resource or craft using what you already own. Avoid targets and routes that recently failed.',
            'Choose a useful independent project: organize your own inventory, improve a safe location, or visit a new natural area. Never modify protected builds or other players property.'
        ];

        for (let offset = 0; offset < alternatives.length; offset++) {
            const index = (
                this.alternativeIndex + offset
            ) % alternatives.length;

            const candidate = alternatives[index];
            const key = normalize(candidate);

            if (key === this.goal ||
                this.blockedGoals.has(key))
                continue;

            this.alternativeIndex = (
                index + 1
            ) % alternatives.length;

            return candidate;
        }

        // Every fallback has failed recently.
        // The caller performs a bounded recovery backoff.
        return null;
    }

    success(action, target) {
        const prefix = `${normalize(action)}|${normalize(target)}|`;
        for (const key of this.failures.keys()) {
            if (key.startsWith(prefix))
                this.failures.delete(key);
        }
    }

    record(action, target, error) {
        if (!this.goal || this.tripped)
            return this.tripped;

        const now = this.now();
        const signature = goalFailureSignature(
            action, target, error
        );

        // Bound history and expire old failures.
        for (const [key, times] of this.failures) {
            const recent = times.filter(
                at => now >= at && now - at < this.windowMs
            );
            if (!recent.length)
                this.failures.delete(key);
            else
                this.failures.set(key, recent);
        }

        let times = this.failures.get(signature) || [];

        // A command may generate multiple error callbacks.
        // Do not count them as separate objective attempts.
        if (times.length &&
            now - times[times.length - 1] < this.minGapMs)
            return null;

        times.push(now);
        this.failures.set(signature, times);

        while (this.failures.size > 64)
            this.failures.delete(
                this.failures.keys().next().value
            );

        if (times.length >= this.threshold) {
            this.tripped = Object.freeze({
                goal: this.goal,
                signature,
                count: times.length
            });
        }

        return this.tripped;
    }
}

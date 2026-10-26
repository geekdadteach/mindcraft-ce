// An independent gameplay guard, not a Brain queue client.
// One repeated failing objective pauses; it never stops the bot.

function normalize(value) {
    return String(value ?? '')
        .trim().toLowerCase().replace(/\s+/g, ' ')
        .slice(0, 160);
}

export function goalFailureSignature(action, target, error) {
    const text = normalize(error);
    let reason;

    if (/no[\s_-]*path|nopath/.test(text))
        reason = 'no_path';
    else if (/timed?\s*out|timeout|took to long/.test(text))
        reason = 'timeout';
    else if (/could not find|couldn't find|not found|no target|nothing nearby|no .+ nearby/.test(text))
        reason = 'no_target';
    else
        reason = text.replace(/-?\d+(?:\.\d+)?/g, '#');

    return `${normalize(action)}|${normalize(target)}|${reason}`;
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
            'Inspect your inventory and health, then choose and complete a useful safe task at your own homestead. Avoid repeating unavailable animal or berry searches unless urgently needed for survival.',
            'Inspect your own shelter and lighting. Choose one small safe improvement using materials you already own. Do not alter protected areas or other players builds.',
            'Survey the homestead plateau for safely accessible resources. Choose a practical small task, avoiding the previously unsuccessful search.',
            'Review your equipment and supplies. Choose and complete one useful maintenance or organization task at your homestead.',
            'Inspect your surroundings and decide on a different achievable homestead improvement. Preserve your shelter and stay away from other players property.'
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

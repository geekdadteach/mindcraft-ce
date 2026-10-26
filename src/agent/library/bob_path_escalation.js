// Only distinct, identified navigation targets count.
// Ordinary no-path events remain local until escalation.
export function pathTargetKey(goal) {
    if (!goal || typeof goal !== 'object')
        return null;

    const x = Number(goal.x);
    const y = Number(goal.y);
    const z = Number(goal.z);

    if ([x, y, z].every(Number.isFinite)) {
        return [
            Math.round(x),
            Math.round(y),
            Math.round(z)
        ].join(',');
    }

    const entityId = goal.entity?.id;

    if (typeof entityId === 'number' &&
        Number.isSafeInteger(entityId)) {
        return `entity:${entityId}`;
    }

    return null;
}

export class DistinctPathFailures {
    constructor({
        now = Date.now,
        windowMs = 5 * 60_000,
        requiredTargets = 2
    } = {}) {
        this.now = now;
        this.windowMs = windowMs;
        this.requiredTargets = requiredTargets;
        this.failures = new Map();
    }

    record(goal, reason) {
        const target = pathTargetKey(goal);

        if (!target)
            return {
                escalate: false,
                reason: 'unidentified_target'
            };

        const now = this.now();
        const kind = String(reason || 'unknown');
        const targets = this.failures.get(kind) || new Map();

        for (const [key, at] of targets) {
            if (now - at >= this.windowMs ||
                now < at)
                targets.delete(key);
        }

        if (targets.has(target)) {
            return {
                escalate: false,
                reason: 'same_target',
                distinctTargets: targets.size
            };
        }

        targets.set(target, now);
        this.failures.set(kind, targets);

        while (this.failures.size > 16)
            this.failures.delete(
                this.failures.keys().next().value
            );

        if (targets.size < this.requiredTargets) {
            return {
                escalate: false,
                reason: 'insufficient_distinct_targets',
                distinctTargets: targets.size
            };
        }

        // A completed episode is consumed.
        // Brain's separate 30-minute fingerprint guard
        // prevents another identical analysis job.
        this.failures.delete(kind);

        return {
            escalate: true,
            reason: 'distinct_targets_confirmed',
            distinctTargets: targets.size
        };
    }
}

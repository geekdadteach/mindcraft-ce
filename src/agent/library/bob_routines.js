// Hybrid execution layer: AltoClef-style task dependencies, using Bob's own skills.
// Deliberately tiny whitelist for the first rollout. No Java/Fabric/Baritone runtime.
export const ROUTINES = Object.freeze({
    oak_log: Object.freeze({ kind: 'gather', block: 'oak_log' }),
    oak_planks: Object.freeze({
        kind: 'craft', output: 4, ingredients: Object.freeze({ oak_log: 1 })
    }),
    stick: Object.freeze({
        kind: 'craft', output: 4, ingredients: Object.freeze({ oak_planks: 2 })
    }),
    crafting_table: Object.freeze({
        kind: 'craft', output: 1, ingredients: Object.freeze({ oak_planks: 4 })
    })
});

const MAX_REQUEST = 64;
const MAX_STEPS = 12;
const MAX_DEPTH = 6;

function countOf(inventory, name) {
    const count = Number(inventory()?.[name] ?? 0);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/**
 * Acquire a small, whitelisted item target with deterministic dependencies.
 * The adapter talks to Bob's EXISTING Mineflayer skills and returns live counts.
 * Success is based only on observed inventory, never on a skill's claimed result.
 * No model calls, chat commands, persistence, or movement engine are added here.
 */
export async function obtainWithRoutines({
    item, quantity, inventory, gather, craft,
    interrupted = () => false, event = () => {}
}) {
    if (!Object.hasOwn(ROUTINES, item))
        return { ok: false, reason: 'unsupported_item', item, quantity, steps: 0 };
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_REQUEST)
        return { ok: false, reason: 'invalid_quantity', item, quantity, steps: 0 };
    if (typeof inventory !== 'function' ||
        typeof gather !== 'function' || typeof craft !== 'function')
        return { ok: false, reason: 'invalid_adapter', item, quantity, steps: 0 };

    let steps = 0;
    const trace = (type, target, before, after, needed) => {
        try { event({ type, target, before, after, needed }); }
        catch { /* telemetry cannot interfere with gameplay */ }
    };
    const check = () => {
        if (interrupted()) throw new Error('interrupted');
        if (steps >= MAX_STEPS) throw new Error('step_limit');
    };
    const ensure = async (target, required, depth) => {
        if (depth > MAX_DEPTH) throw new Error('depth_limit');
        check();
        const recipe = ROUTINES[target];
        if (!recipe) throw new Error('missing_recipe:' + target);
        let before = countOf(inventory, target);
        if (before >= required) return;
        const missing = required - before;

        if (recipe.kind === 'gather') {
            steps++;
            await gather(recipe.block, missing);
            checkAfterStep();
            const after = countOf(inventory, target);
            trace('gather', target, before, after, required);
            if (after < required) throw new Error('gather_shortfall:' + target);
            return;
        }

        const runs = Math.ceil(missing / recipe.output);
        for (const [ingredient, perRun] of Object.entries(recipe.ingredients))
            await ensure(ingredient, runs * perRun, depth + 1);
        check();
        before = countOf(inventory, target);
        if (before >= required) return; // another action or crafting side-effect satisfied it
        steps++;
        await craft(target, runs);
        checkAfterStep();
        const after = countOf(inventory, target);
        trace('craft', target, before, after, required);
        if (after < required) throw new Error('craft_shortfall:' + target);
    };
    const checkAfterStep = () => {
        if (interrupted()) throw new Error('interrupted');
    };

    try {
        await ensure(item, quantity, 0);
        const observed = countOf(inventory, item);
        return { ok: observed >= quantity, reason: observed >= quantity ? 'verified' : 'unverified',
            item, quantity, observed, steps };
    } catch (error) {
        return { ok: false, reason: String(error?.message || error).slice(0, 120),
            item, quantity, observed: countOf(inventory, item), steps };
    }
}

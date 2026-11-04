// [bob-eval] Simulated command effects for the fake world.
// The REAL command objects from src/agent/commands are used (parsing, arg validation, name-fix, guards,
// runCommandPerform receipts, ActionManager + TaskLifecycle). Only each command's `perform` body is swapped,
// for the duration of one harness run, for a deterministic world effect that goes through
// agent.actions.runAction exactly like runAsAction() does. Real skills/pathfinding need a server: use the
// staging procedure in README.md for those.
import { actionsList } from '../../src/agent/commands/actions.js';
import { queryList } from '../../src/agent/commands/queries.js';

const log = (bot, msg) => { bot.output += msg + '\n'; };   // same as skills.log
const LOGS = /_log$/;

const RECIPES = {
    crafting_table: { needs: { planks: 4 }, out: 1 },
    stick: { needs: { planks: 2 }, out: 4 },
    wooden_pickaxe: { needs: { planks: 3, stick: 2 }, out: 1, table: true },
};

function planksOf(inv) { return inv.items().filter(i => /_planks$/.test(i.name)); }
function takePlanks(inv, n) {
    for (const it of planksOf(inv)) { const k = Math.min(n, it.count); inv.remove(it.name, k); n -= k; if (!n) break; }
}

function moveNextTo(bot, x, y, z) { bot.teleport(x + 1, bot.world.groundY + 1, z); }

const sims = {
    async collectBlocks(agent, opts, type, num) {
        const { bot } = agent;
        const found = bot.world.findBlocks(n => n === type, bot.entity.position, 32).slice(0, num);
        if (!found.length) return log(bot, `Could not find any ${type} within 32 blocks.`);
        for (const b of found) {
            bot.world.setBlock(b.x, b.y, b.z, 'air');
            bot.inventory.add(type === 'stone' ? 'cobblestone' : type, 1);
            moveNextTo(bot, b.x, b.y, b.z);
        }
        log(bot, found.length < num ? `Collected ${found.length} ${type}, could not find more.` : `Collected ${found.length} ${type}.`);
    },
    async gatherWood(agent, opts, num) {
        const { bot } = agent;
        const found = bot.world.findBlocks(n => LOGS.test(n), bot.entity.position, 32).slice(0, num);
        if (!found.length) return log(bot, 'Could not find any logs within 32 blocks.');
        for (const b of found) { bot.world.setBlock(b.x, b.y, b.z, 'air'); bot.inventory.add(b.name, 1); moveNextTo(bot, b.x, b.y, b.z); }
        log(bot, `Collected ${found.length} logs.`);
    },
    async goToCoordinates(agent, opts, x, y, z, closeness) {
        const { bot } = agent;
        if (opts.faults?.goToCoordinates === 'claim_success_no_move') return log(bot, `You have reached ${x}, ${y}, ${z}.`);
        if (!bot.world.isReachable(x, y, z)) return log(bot, `Path not found: could not reach ${x}, ${y}, ${z}.`);
        bot.teleport(x, y, z);
        log(bot, `You have reached ${x}, ${y}, ${z}.`);
    },
    async craftRecipe(agent, opts, name, num) {
        const { bot } = agent, inv = bot.inventory;
        for (let i = 0; i < num; i++) {
            if (/_planks$/.test(name)) {
                const log_ = name.replace(/_planks$/, '_log');
                if (!inv.remove(log_, 1)) return log(bot, `You do not have the resources to craft ${name}. It requires: 1 ${log_}.`);
                inv.add(name, 4);
                continue;
            }
            const r = RECIPES[name];
            if (!r) return log(bot, `Could not find a recipe for ${name}.`);
            if (r.table && !inv.count('crafting_table')) return log(bot, `Crafting ${name} requires a crafting table.`);
            const havePlanks = planksOf(inv).reduce((a, i) => a + i.count, 0);
            if (havePlanks < (r.needs.planks || 0) || inv.count('stick') < (r.needs.stick || 0))
                return log(bot, `You do not have the resources to craft ${name}. It requires: ${JSON.stringify(r.needs)}.`);
            takePlanks(inv, r.needs.planks || 0);
            if (r.needs.stick) inv.remove('stick', r.needs.stick);
            inv.add(name, r.out);
        }
        log(bot, `Successfully crafted ${name}, you now have ${inv.count(name)} ${name}.`);
    },
    // Starter-shelter step: walls at feet + head level on the 4 sides, then a roof block over the head.
    async continueHomestead(agent, opts) {
        const { bot } = agent, w = bot.world;
        const p = bot.entity.position, x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        const plan = [];
        for (const dy of [0, 1]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) plan.push([x + dx, y + dy, z + dz]);
        plan.push([x, y + 2, z]);
        const missing = plan.filter(([a, b, c]) => !w.isSolid(a, b, c));
        if (!missing.length) return log(bot, 'Starter shelter is complete around you.');
        if (opts.faults?.continueHomestead === 'noop') return log(bot, `Placing ${Math.min(8, missing.length)} starter-shelter block(s) at your chosen site.`);
        let placed = 0;
        for (const [a, b, c] of missing.slice(0, 8)) {
            const mat = planksOf(bot.inventory)[0]?.name || (bot.inventory.count('cobblestone') ? 'cobblestone' : null);
            if (!mat) break;
            bot.inventory.remove(mat, 1);
            w.setBlock(a, b, c, mat);
            placed++;
        }
        log(bot, placed ? `Placed ${placed} starter-shelter block(s).` : 'Gather more building supplies (planks or cobblestone).');
    },
};

const queries = {
    inventory: agent => 'INVENTORY: ' + JSON.stringify(agent.bot.inventory.snapshot()),
    stats: agent => {
        const p = agent.bot.entity.position;
        return `STATS\n- Position: x: ${p.x}, y: ${p.y}, z: ${p.z}\n- Health: ${agent.bot.health} / 20\n- Hunger: ${agent.bot.food} / 20`;
    },
};

// Swap every action/query perform for a simulated one. Returns restore().
export function installSimCommands(opts = {}) {
    const saved = [];
    for (const cmd of actionsList) {
        saved.push([cmd, cmd.perform]);
        const label = cmd.name.substring(1);
        const sim = sims[label];
        cmd.perform = async (agent, ...args) => {
            const r = await agent.actions.runAction(`action:${label}`, async () => {
                if (sim) await sim(agent, opts, ...args);
                else log(agent.bot, `${cmd.name} is not simulated in the offline harness; nothing happened.`);
            }, { timeout: -1 });
            if (r.interrupted && !r.timedout) return;
            return r.message;
        };
    }
    for (const q of queryList) {
        saved.push([q, q.perform]);
        const label = q.name.substring(1);
        q.perform = async (agent) => (queries[label] ? queries[label](agent) : `${q.name} is not simulated in the offline harness.`);
    }
    return () => { for (const [cmd, perform] of saved) cmd.perform = perform; };
}

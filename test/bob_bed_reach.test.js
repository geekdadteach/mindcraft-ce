// [ai-player] 2026-11-01 (item 1) - a bed Bob is below must be reachable: goToBed paths to a standable
// tile next to the bed (climbing out of a hole) and only sleeps within 2 blocks, retrying the walk once.
// Live night 1: the red_bed at -1144 68 752 was 3 blocks above Bob in a hole and sleep logged "too far".
import test from 'node:test';
import assert from 'node:assert/strict';
import mcDataLoader from 'minecraft-data';
import { goToBed } from '../src/agent/library/skills.js';

const registry = mcDataLoader('1.21.1');

const v = (x, y, z) => ({
    x, y, z,
    distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); },
    clone() { return v(this.x, this.y, this.z); },
    floored() { return v(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); },
    offset(dx, dy, dz) { return v(this.x + dx, this.y + dy, this.z + dz); },
});

// A bot 3 blocks BELOW the bed, as in the live report. `walks` is where the bot ends after each
// pathfinder.goto call; `sleepFails` is how many times sleep throws "the bed is too far".
function mkBedBot({ bedPos = v(0, 68, 0), start = v(0, 65, 0), walks = [], sleepFails = 0 } = {}) {
    const bed = { name: 'red_bed', boundingBox: 'block', position: bedPos };
    const state = { goals: [], movements: [], sleeps: 0, position: start };
    let walkIndex = 0, failLeft = sleepFails;
    const bot = {
        output: '',
        registry,
        isSleeping: false,
        entity: { position: state.position, height: 1.62 },
        modes: { pause() {} },
        findBlocks: () => [bedPos],
        blockAt: (p) => (p && p.x === bedPos.x && p.y === bedPos.y && p.z === bedPos.z ? bed : null),
        pathfinder: {
            setMovements(m) { state.movements.push(m); },
            async goto(goal) {
                state.goals.push(goal);
                const next = walks[Math.min(walkIndex, walks.length - 1)];
                walkIndex++;
                if (next) { state.position = next; bot.entity.position = next; }
            },
        },
        async sleep(b) {
            state.sleeps++;
            if (failLeft > 0) { failLeft--; throw new Error('the bed is too far'); }
            if (bot.entity.position.distanceTo(b.position) > 2) throw new Error('the bed is too far');
        },
    };
    return { bot, state };
}

test('a bed 3 blocks below is reached: path to a standable tile, sleep only within reach', async () => {
    const { bot, state } = mkBedBot({ walks: [v(1, 68, 0)] }); // climbs out and stands next to the bed
    const ok = await goToBed(bot);
    assert.equal(ok, true, 'he slept');
    assert.equal(state.goals.length, 1, 'one walk');
    assert.equal(state.goals[0].constructor.name, 'GoalNear', 'the walk targets a nearby tile');
    assert.equal(state.goals[0].rangeSq, 1, 'GoalNear(bed, 1): a tile right next to the bed');
    assert.equal(state.movements[0].canDig, true, 'digging is allowed to climb out of the hole');
    assert.equal(state.movements[0].allow1by1towers, true, 'a 1x1 tower is allowed');
    assert.equal(state.sleeps, 1, 'sleep is called once, and only when within reach');
});

test('"the bed is too far" retries the walk once, then succeeds', async () => {
    const { bot, state } = mkBedBot({ walks: [v(1, 68, 0)], sleepFails: 1 });
    const ok = await goToBed(bot);
    assert.equal(ok, true, 'the retry slept');
    assert.equal(state.sleeps, 2, 'sleep was attempted twice');
});

test('a bed he can never reach returns false and never sleeps', async () => {
    const { bot, state } = mkBedBot({ walks: [v(0, 65, 0)] }); // the walk never moves him
    const ok = await goToBed(bot);
    assert.equal(ok, false, 'he did not sleep');
    assert.equal(state.sleeps, 0, 'sleep is never called out of reach');
    assert.equal(state.goals.length, 2, 'the walk is retried once');
});

test('goToBed with no bed returns false', async () => {
    const bot = { output: '', registry, modes: { pause() {} }, findBlocks: () => [], blockAt: () => null };
    assert.equal(await goToBed(bot), false);
});

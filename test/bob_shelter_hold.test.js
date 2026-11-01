// [ai-player] Fix 1e round 2: shelter stay-in hold, food carve-out and lifecycle cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { emptyHome, setActiveHome } from '../src/agent/library/bob_home.js';
import {
    clearShelter, dimensionChanged, hasEdibleFood, markSheltered,
    shelterMovements, shelterReason, shouldLeaveEarlyForFood,
} from '../src/agent/library/night_shelter.js';

const at = (x, y, z) => ({ x, y, z, distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z) });

test('the food carve-out ends the shelter early only when starving with nothing edible', () => {
    const foods = { bread: {}, spider_eye: {}, cooked_beef: {} };
    const bot = (food, items) => ({ food, registry: { foodsByName: foods }, inventory: { items: () => items } });
    clearShelter();
    assert.equal(shouldLeaveEarlyForFood(bot(6, [])), false, 'not sheltered: no carve-out');
    markSheltered({ day: 1, placed: [], dug: [] });
    try {
        assert.equal(shouldLeaveEarlyForFood(bot(6, [])), true, 'food 6, nothing edible: leave early');
        assert.equal(shouldLeaveEarlyForFood(bot(6, [{ name: 'bread' }])), false, 'food in inventory: eat, stay');
        assert.equal(shouldLeaveEarlyForFood(bot(7, [])), false, 'food above 6: stay');
        assert.equal(hasEdibleFood(bot(20, [{ name: 'iron_sword' }])), false);
        assert.equal(hasEdibleFood(bot(20, [{ name: 'spider_eye' }])), true);
    } finally { clearShelter(); }
});

test('shelterMovements forbids digging while sheltered', () => {
    clearShelter();
    assert.equal(shelterMovements({ canDig: true }).canDig, true, 'not sheltered: unchanged');
    markSheltered({ day: 1, placed: [], dug: [] });
    try {
        assert.equal(shelterMovements({ canDig: true }).canDig, false, 'sheltered: digging is off');
    } finally { clearShelter(); }
});

test('dimensionChanged reports a shelter built in another dimension', () => {
    clearShelter();
    markSheltered({ day: 1, dimension: 'minecraft:overworld', placed: [], dug: [] });
    try {
        assert.equal(dimensionChanged({ game: { dimension: 'minecraft:overworld' } }), false);
        assert.equal(dimensionChanged({ game: { dimension: 'minecraft:the_nether' } }), true);
    } finally { clearShelter(); }
});

test('the hold skips cowardice and ranged_threat, and agent clears the shelter on death/spawn', () => {
    const modes = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    assert.match(modes, /sealed in, do not flee/, 'cowardice is skipped');
    assert.match(modes, /sealed in, do not take cover/, 'ranged_threat is skipped');
    assert.match(modes, /shelter: leaving early for food/, 'the carve-out logs the required line');
    assert.match(modes, /shouldLeaveEarlyForFood/, 'the carve-out is wired');
    const agent = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    assert.match(agent, /on\('death'[\s\S]{0,140}clearShelter\(this\.bot\)/, 'death clears the shelter');
    assert.match(agent, /on\('spawn'[\s\S]{0,140}clearShelter\(this\.bot\)/, 'spawn clears the shelter');
    assert.match(agent, /releaseNightHold\('death'\)/, 'death drops the night hold right away');
    assert.doesNotMatch(agent, /dawnExit/, 'the agent never runs the dawn pack-up');
});

test('a starving Bob does not start or re-shelter while he has nothing to eat', () => {
    setActiveHome(emptyHome());
    const hostile = { z: { name: 'zombie', type: 'mob', position: at(4, 64, 0) } };
    const starving = { entity: { position: at(0, 64, 0) }, time: { timeOfDay: 18000 }, health: 20, food: 4, entities: hostile, registry: { foodsByName: {} }, inventory: { items: () => [] } };
    assert.equal(shelterReason(starving), null, 'starving with nothing to eat: no shelter');
    const fed = { ...starving, registry: { foodsByName: { bread: {} } }, inventory: { items: () => [{ name: 'bread' }] } };
    assert.equal(shelterReason(fed), 'hostiles', 'with food in hand he may shelter');
    const src = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    assert.match(src, /this\.shelterLeftForFood = true/, 'leaveForFood sets the guard');
    assert.match(src, /if \(this\.shelterLeftForFood\) return;/, 'tryEmergencyShelter refuses while set');
    assert.match(src, /shelterLeftForFood && \(agent\.bot\.food > 6/, 'the guard clears at food > 6');
});

test('the hunger mode eats while sheltered, and only then stops hunting/getFood', () => {
    const modes = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    assert.match(modes, /await survival\.eatBest\(bot\)/, 'sheltered eating uses eatBest');
    assert.match(modes, /await survival\.cookOrEat\(bot\)/, 'unsheltered eating still cooks');
    const eat = modes.indexOf('survival.eatBest(bot)');
    const ret = modes.indexOf('below both eat branches');
    const oldFood = modes.indexOf('hungry and no food');
    // [ai-player] 2026-11-01: the "he has nothing edible" trip (item 2) sits above the food > 14 return, so it
    // is now the first getFood call. It only fires when he holds no edible item at all, so eating from the
    // inventory (the branch above it) still wins.
    const newTrip = modes.indexOf('no food, food/health below target');
    assert.ok(eat > 0 && newTrip > eat, 'the eat branch comes before the new food trip');
    assert.ok(ret > newTrip, 'the sheltered return comes after it');
    assert.ok(oldFood > ret, 'the old food <= 12 getFood is still below the sheltered return');
    assert.match(modes, /!edibleFoods\(bot, bot\.food <= 6\)\.length && \(bot\.food < 18 \|\| bot\.health < 20\)/,
        'the new trip only runs with nothing edible and food < 18 or health < 20');
    assert.match(modes, /shelter\.clearShelter\(agent\.bot\)/, 'the dimension-change path restores canDig');
});


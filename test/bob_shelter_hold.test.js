// [ai-player] Fix 1e round 2: shelter stay-in hold, food carve-out and lifecycle cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    clearShelter, dimensionChanged, hasEdibleFood, markSheltered,
    shelterMovements, shouldLeaveEarlyForFood,
} from '../src/agent/library/night_shelter.js';

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
    assert.match(agent, /on\('death'[\s\S]{0,140}clearShelter\(\)/, 'death clears the shelter');
    assert.match(agent, /on\('spawn'[\s\S]{0,140}clearShelter\(\)/, 'spawn clears the shelter');
    assert.doesNotMatch(agent, /dawnExit/, 'the agent never runs the dawn pack-up');
});

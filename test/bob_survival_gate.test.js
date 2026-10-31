import test from 'node:test';
import assert from 'node:assert/strict';
import {
    criticalSurvivalGuard,
    isGuardBlockResult,
    recallBedHint,
} from '../src/agent/library/bob_survival_gate.js';
import { Failures } from '../src/agent/library/failures.js';
import { SelfPrompter } from '../src/agent/self_prompter.js';

test('critical health forbids optional mining and building', () => {
    const bot = { health: 1, food: 0 };
    assert.match(criticalSurvivalGuard(bot, '!collectBlocks'), /CRITICAL/);
    assert.match(criticalSurvivalGuard(bot, '!collectBlocks', true, { args: ['coal_ore', 8] }), /CRITICAL/);
    assert.match(criticalSurvivalGuard(bot, '!goToCoordinates'), /CRITICAL/);
    assert.match(criticalSurvivalGuard(bot, '!placeHere', true, { args: ['dirt'] }), /CRITICAL/);
    assert.equal(criticalSurvivalGuard(bot, '!getFood'), null);
    assert.equal(criticalSurvivalGuard(bot, '!goToBed'), null);
});

test('low health plus a food action is allowed', () => {
    const bot = { health: 2, food: 1, inventory: { items: () => [] } };
    assert.equal(criticalSurvivalGuard(bot, '!getFood'), null);
    assert.equal(criticalSurvivalGuard(bot, '!consume', true, { args: ['bread'] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!eat'), null);
    assert.equal(criticalSurvivalGuard(bot, '!searchForEntity', true, { args: ['sheep'] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!searchForEntity', true, { args: ['cow'] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!searchForBlock', true, { args: ['wheat'] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!attack', true, { args: ['cow'] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!collectBlocks', true, { args: ['sweet_berries'] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!viewChest'), null);
    assert.equal(criticalSurvivalGuard(bot, '!takeFromChest', true, { args: ['bread', 8] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!moveAway', true, { args: [8] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!goToRememberedPlace', true, { args: ['bed'] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!goToCoordinates', true, {
        args: [-1144, 68, 752],
        bed: { x: -1144, y: 68, z: 752 },
    }), null);
});

test('has-food leads to an eat suggestion instead of a bare refusal', () => {
    const bot = {
        health: 2,
        food: 2,
        inventory: { items: () => [{ name: 'bread', count: 2 }] },
    };
    const mine = criticalSurvivalGuard(bot, '!collectBlocks', true, { args: ['coal_ore'] });
    assert.match(mine, /CRITICAL SURVIVAL/);
    assert.match(mine, /!consume\("bread"\)/);
    assert.match(mine, /Eat now/);
    const hunt = criticalSurvivalGuard(bot, '!searchForEntity', true, { args: ['sheep'] });
    assert.match(hunt, /!consume\("bread"\)/);
    assert.equal(criticalSurvivalGuard(bot, '!consume', true, { args: ['bread'] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!getFood'), null);
    assert.equal(criticalSurvivalGuard(bot, '!moveAway', true, { args: [6] }), null);
    assert.equal(criticalSurvivalGuard(bot, '!attack', true, { args: ['zombie'] }), null);
});

test('healthy bot can roam, and player-directed actions are not overridden here', () => {
    assert.equal(criticalSurvivalGuard({ health: 20, food: 19 }, '!collectBlocks'), null);
    assert.equal(criticalSurvivalGuard({ health: 1, food: 0 }, '!collectBlocks', false), null);
});

test('guard and survival blocks are not recorded as goal failures', () => {
    const survival = 'CRITICAL SURVIVAL: health=2/20, food=1/20. Optional action blocked. Prioritize !getFood.';
    const eat = 'CRITICAL SURVIVAL: health=2/20, food=2/20. You have bread in your inventory. Eat now with !consume("bread") before doing anything else.';
    const stuck = '!searchForEntity("sheep") is blocked for about 2 more min: you got stuck doing it at 1 2 3. Pick a different task or place.';
    assert.equal(isGuardBlockResult(survival), true);
    assert.equal(isGuardBlockResult(eat), true);
    assert.equal(isGuardBlockResult(stuck), true);
    assert.equal(isGuardBlockResult('Could not find any sheep nearby'), false);

    const recorded = [];
    const failures = Object.create(Failures.prototype);
    failures.agent = {
        bot: { entity: { position: { x: -1135, y: 67, z: 754 } } },
        self_prompter: { noteFailure() { throw new Error('goal circuit should not see guard blocks'); } },
    };
    failures.record = (...args) => { recorded.push(args); return null; };
    failures.success = () => { recorded.push('success'); };
    failures.observeCommand('!searchForEntity("sheep")', survival);
    failures.observeCommand('!collectBlocks("coal_ore")', eat);
    failures.observeCommand('!searchForEntity("sheep")', stuck);
    assert.deepEqual(recorded, []);

    const prompter = new SelfPrompter({});
    prompter.state = 1;
    let circuit = 0;
    prompter.goalCircuit = { record() { circuit += 1; return { tripped: true }; } };
    assert.equal(prompter.noteFailure('!searchForEntity', 'sheep', survival), null);
    assert.equal(circuit, 0);
});

test('recallBedHint reads memory only and does not use the abandoned hilltop', () => {
    assert.equal(recallBedHint({}), null);
    const agent = {
        memory_bank: { recallPlace: (n) => n === 'bed' ? [-1144, 68, 752] : null },
    };
    assert.deepEqual(recallBedHint(agent), { x: -1144, y: 68, z: 752 });
});

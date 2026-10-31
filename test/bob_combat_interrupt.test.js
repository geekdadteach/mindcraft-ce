// [ai-player] Fix 1 — combat interrupt (1a), neutral-mob filter (1c), unarmed disengage (1d).
import test from 'node:test';
import assert from 'node:assert/strict';
import { defendSelf } from '../src/agent/library/skills.js';
import { selfDefenseTarget, hasMeleeWeapon } from '../src/agent/library/survival.js';
import { isAggressiveHostile, NEUTRAL_MOBS, NEUTRAL_AGGRO_MS } from '../src/utils/mcdata.js';

const at = (x, y, z) => ({ x, y, z, distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z) });
const mob = (name, pos, type = 'mob') => ({ name, type, position: pos });

function fakeBot({ health = 20, items = [{ name: 'iron_sword', attackDamage: 6 }], entities = [] } = {}) {
    return {
        output: '',
        health,
        interrupt_code: false,
        _actionGen: 1,
        entity: { position: at(0, 64, 0) },
        inventory: { items: () => items },
        modes: { pause() {} },
        equip: async () => {},
        pathfinder: { setMovements() {}, goto: async () => {} },
        pvp: { attacks: 0, stops: 0, attack() { this.attacks++; }, stop() { this.stops++; } },
        nearestEntity: (pred) => entities.find(pred),
    };
}

test('defendSelf stops within 600 ms of an interrupt and does not attack again', async () => {
    const zombie = mob('zombie', at(1, 64, 0)); // inside 2 blocks: melee only, no pathfinder chase
    const bot = fakeBot({ entities: [zombie] });
    let interruptAt = 0;
    const timer = setTimeout(() => { interruptAt = Date.now(); bot.interrupt_code = true; }, 250);
    const started = Date.now();
    const res = await defendSelf(bot);
    const done = Date.now();
    clearTimeout(timer);
    assert.equal(res, false, 'an interrupted defence returns false');
    assert.equal(bot.pvp.attacks, 1, 'it attacked once, then stopped instead of attacking again');
    assert.ok(bot.pvp.stops >= 1, 'pvp.stop() is called on exit');
    assert.ok(done - interruptAt <= 600, `resolved ${done - interruptAt} ms after the interrupt`);
    assert.ok(done - started < 5000, 'it did not hang');
});

test('self_defense ignores an unprovoked enderman but fights it after it hurts Bob', () => {
    const enderman = mob('enderman', at(2, 64, 0));
    const bot = fakeBot({ entities: [enderman] });
    assert.equal(selfDefenseTarget(bot), null, 'an unprovoked enderman is not a target');
    enderman._lastDamagedBot = Date.now();
    assert.equal(selfDefenseTarget(bot), enderman, 'an enderman that just hit Bob is a target');
    enderman._lastDamagedBot = Date.now() - (NEUTRAL_AGGRO_MS + 1000);
    assert.equal(selfDefenseTarget(bot), null, 'the aggro window expires');
});

test('self_defense does not engage unarmed at low health, but does when armed or healthy', () => {
    const zombie = mob('zombie', at(2, 64, 0));
    assert.equal(selfDefenseTarget(fakeBot({ health: 8, items: [], entities: [zombie] })), null, 'unarmed at 8 health: do not melee');
    assert.equal(selfDefenseTarget(fakeBot({ health: 8, items: [{ name: 'stone_sword' }], entities: [zombie] })), zombie, 'armed at 8 health: fight');
    assert.equal(selfDefenseTarget(fakeBot({ health: 20, items: [], entities: [zombie] })), zombie, 'unarmed at 20 health: fight');
    assert.equal(hasMeleeWeapon({ inventory: { items: () => [{ name: 'wooden_pickaxe' }] } }), false, 'a pickaxe is not a melee weapon');
    assert.equal(hasMeleeWeapon({ inventory: { items: () => [{ name: 'stone_axe' }] } }), true);
});

test('isAggressiveHostile keeps normal hostiles and only aggros neutral mobs after damage', () => {
    assert.equal(isAggressiveHostile(mob('zombie', at(0, 0, 0))), true);
    assert.equal(isAggressiveHostile(mob('creeper', at(0, 0, 0))), true);
    for (const name of NEUTRAL_MOBS) {
        assert.equal(isAggressiveHostile(mob(name, at(0, 0, 0))), false, `${name} is neutral`);
    }
    const wolf = mob('wolf', at(0, 0, 0));
    wolf._lastDamagedBot = Date.now();
    assert.equal(isAggressiveHostile(wolf), true, 'a provoked wolf is hostile');
    assert.equal(isAggressiveHostile(mob('iron_golem', at(0, 0, 0))), false, 'an iron golem is never hostile');
});

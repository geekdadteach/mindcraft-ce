// [ai-player] Fix 4 - chest deposit verification and auto-junk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { windowItemCount, junkPolicy, autoJunkEnabled } from '../src/agent/library/skills.js';

test('windowItemCount reads the open window, so a real deposit counts as moved', () => {
    const botInv = [{ name: 'clay_ball', count: 40 }];
    const windowItems = [{ name: 'clay_ball', count: 40 }];
    const container = { items: () => windowItems };
    const bot = { inventory: { items: () => botInv } };
    const before = windowItemCount(container, bot, 'clay_ball');
    assert.equal(before, 40);
    windowItems[0].count = 10; // deposit moved 30; the window updated, bot.inventory did not
    const after = windowItemCount(container, bot, 'clay_ball');
    assert.equal(before - after, 30, 'the move is seen from the window');
    assert.equal(bot.inventory.items()[0].count, 40, 'bot.inventory was NOT reconciled (the old bug)');
});

test('junkPolicy drops junk only when slots are low, keeping essentials', () => {
    const bot = { registry: { foodsByName: { bread: {} } } };
    const inv = [{ name: 'clay_ball', count: 40 }, { name: 'string', count: 20 }, { name: 'big_dripleaf', count: 11 }, { name: 'chest', count: 6 }, { name: 'wooden_pickaxe', count: 1 }, { name: 'bread', count: 3 }, { name: 'oak_log', count: 12 }];
    assert.deepEqual(junkPolicy(bot, inv, { freeSlots: 5 }), [], 'room to spare');
    const plan = junkPolicy(bot, inv, { freeSlots: 2 });
    assert.deepEqual(plan.map(p => p.name).sort(), ['big_dripleaf', 'chest', 'clay_ball', 'string']);
    assert.equal(plan.find(p => p.name === 'clay_ball').count, 8);
    assert.equal(plan.find(p => p.name === 'string').count, 4);
    assert.equal(plan.find(p => p.name === 'chest').count, 5);
});

test('auto-junk is ON by default and the deposit path uses the window count', () => {
    assert.equal(autoJunkEnabled({}), true);
    assert.equal(autoJunkEnabled({ BOB_AUTO_JUNK: '0' }), false);
    const src = fs.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    assert.match(src, /const before = windowItemCount\(container, bot, itemName\)/);
    const harness = fs.readFileSync(new URL('../src/agent/library/bob_eval_harness.js', import.meta.url), 'utf8');
    assert.match(harness, /result_text_failure: \/not confirmed\/i\.test/);
});

test('auto-junk is wired into an idle daytime mode away from the house', () => {
    const modes = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    assert.match(modes, /name: 'auto_junk'/, 'the mode exists');
    assert.match(modes, /survival\.autoJunk\(bot\)/, 'it calls autoJunk');
    assert.match(modes, /junkAllowedHere/, 'it checks the house/protected area');
    assert.match(modes, /protectedAreaAt/, 'protected areas are honoured');
});

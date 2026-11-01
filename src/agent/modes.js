import { getActiveHome, isVerifiedHome } from './library/bob_home.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import * as nav from './library/ai_player_nav.js';
import * as survival from './library/survival.js';
import { recordSleptBed } from './library/protected_area.js';

// [ai-player] spectators (e.g. Randy via /bobwatch) are invisible observers: never stare at, avoid or react to them
function isSpectator(bot, entity) {
    if (!entity || entity.type !== 'player') return false;
    const p = Object.values(bot.players || {}).find(pl => pl.entity === entity || pl.username === entity.username);
    return p?.gamemode === 3;
}

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            if (blockAbove.name === 'water') {
                // does not call execute so does not interrupt other actions
                if (!bot.pathfinder.goal) {
                    bot.setControlState('jump', true);
                }
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    });
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                say(agent, 'I\'m dying!');
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                });
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        update: async function (agent) {
            // pr20-reconciled-20261027: unstuck's own recovery action (moveAway/nudge/escalation) must not count as
            // being stuck, or the mode interrupts itself and re-escalates.
            if (agent.actions.currentActionLabel === 'mode:unstuck') {
                this.prev_location = null; this.stuck_time = 0; this.last_time = Date.now(); return;
            }
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            // [ai-player] Fighting or fleeing in place is not being stuck: interrupting combat got Bob shot (10:44 Oct 20).
            if (/^mode:(self_defense|self_preservation|cowardice|hunting|ranged_threat)$/.test(agent.actions.currentActionLabel || '')) {
                this.prev_location = null; this.stuck_time = 0; this.last_time = Date.now(); return;
            }
            const cur_dig_block = bot.targetDigBlock;
            // [ai-player] Mining in place is not being stuck: digging a block (bot.dig or pathfinder
            // tunnelling/pillaring) or an inventory change since the last tick counts as progress.
            const inv_count = bot.inventory.items().reduce((sum, item) => sum + item.count, 0);
            const inv_changed = this.prev_inv_count != null && inv_count !== this.prev_inv_count;
            this.prev_inv_count = inv_count;
            const pf_working = !!(bot.pathfinder?.isMining?.() || bot.pathfinder?.isBuilding?.());
            if (cur_dig_block || pf_working || inv_changed) {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
                this.last_time = Date.now();
                return;
            }
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            let max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            // [ai-player] collectBlocks also spends time planning tunnels to buried blocks: allow 40 s.
            if (agent.actions.currentActionLabel === 'action:collectBlocks') max_stuck_time = this.max_stuck_time * 2;
            if (this.stuck_time > max_stuck_time) {
                const p = bot.entity.position.floored();
                try {
                    const around = [[0,-1,0],[0,2,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[1,1,0],[-1,1,0],[0,1,1],[0,1,-1]]
                        .map(([dx,dy,dz]) => bot.blockAt(p.offset(dx,dy,dz))?.name?.replace('minecraft:','') ?? '?').join(',');
                    console.log(`[ai-player] unstuck: triggered at ${p} after ${Math.round(this.stuck_time)}s action=${agent.actions.currentActionLabel} goal=${bot.pathfinder?.goal?.constructor?.name ?? 'none'} moving=${bot.pathfinder?.isMoving?.()} around(below,above2,+x,-x,+z,-z,+x1,-x1,+z1,-z1)=${around}`);
                } catch (e) {}
                say(agent, 'I\'m stuck!');
                this.stuck_time = 0;
                // [ai-player] Escalate instead of nudging again when the nudge already failed twice within 3 blocks of here
                // in the last 5 min (Oct 20: 89 triggers in 3 h, mostly in the tunnels under the house, 79 never freed).
                const now = Date.now();
                const cmd = agent.last_command_key || agent.actions.currentActionLabel;
                this.fails = (this.fails || []).filter(f => now - f.t < 5 * 60e3);
                const near = this.fails.filter(f => f.pos.distanceTo(p) <= 3);
                try { agent.failures?.record(cmd || 'action', 'stuck', p, `no movement for ${Math.round(max_stuck_time)}s`); } catch (_) {}
                // [ai-player] item 3: underground, one failed nudge here is enough: climb out instead of nudging again
                if (near.length >= (nav.isUnderground(bot) ? 1 : 2)) {
                    this.fails = this.fails.filter(f => f.pos.distanceTo(p) > 3);
                    execute(this, agent, async () => {
                        await escapeStuck(agent, p, [cmd, ...near.map(f => f.cmd)]);
                    }, -1, 130000);
                    this.last_time = Date.now();
                    return;
                }
                execute(this, agent, async () => {
                    // [ai-player] never kill the process when stuck: try moveAway for 10s,
                    // then stop pathing, nudge (jump + a few random steps), and carry on.
                    const before = bot.entity.position.clone();
                    const freed = await Promise.race([
                        skills.moveAway(bot, 5).then(() => bot.entity.position.distanceTo(before) >= 3).catch(() => false), // [ai-player] really moved
                        new Promise(r => setTimeout(() => r(false), 10000)),
                    ]);
                    if (freed) {
                        console.log('[ai-player] unstuck: freed by moveAway');
                        say(agent, 'I\'m free.');
                        return;
                    }
                    console.log('[ai-player] unstuck: could not free in 10s; stopping action/pathfinder, nudging, continuing (no restart)');
                    this.fails.push({ pos: p, t: Date.now(), cmd });
                    try { bot.pathfinder.stop(); } catch (e) {}
                    try { bot.pathfinder.setGoal(null); } catch (e) {}
                    try { bot.clearControlStates(); } catch (e) {}
                    agent.actions.cancelResume();
                    // [ai-player] at 4 HP or less no jump-nudges (one bad step kills him); wait and let the escalation handle it
                    if (bot.health <= 4) {
                        console.log(`[ai-player] unstuck: health ${Math.round(bot.health)} <= 4, skipping jump-nudge; waiting`);
                        await new Promise(r => setTimeout(r, 3000));
                        return;
                    }
                    for (let i = 0; i < 3; i++) {
                        try {
                            await bot.look(Math.random() * Math.PI * 2, 0, true);
                            bot.setControlState('jump', true);
                            bot.setControlState('forward', true);
                            await new Promise(r => setTimeout(r, 700));
                            bot.clearControlStates();
                        } catch (e) { try { bot.clearControlStates(); } catch (e2) {} }
                    }
                    console.log('[ai-player] unstuck: nudge done; continuing');
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        // [ai-player] Oct 20: 6 of 8 deaths were skeleton arrows (self_defense chased them through caves). Skeletons and
        // other ranged mobs that can see Bob: fight only with health >= 14, a sword and a short clear path, else take
        // cover out of their line of sight (or back away). Creepers within 6 blocks: walk away, never melee them.
        name: 'ranged_threat',
        description: 'Take cover from skeletons and other ranged mobs that can see you; move away from creepers. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        next_check: 0,
        update: async function (agent) {
            const bot = agent.bot;
            const now = Date.now();
            if (now < this.next_check) return;
            this.next_check = now + 700;
            const creeper = survival.creeperClose(bot, 6);
            if (creeper) {
                console.log(`[ai-player] threat: creeper ${Math.round(creeper.position.distanceTo(bot.entity.position))}m away; moving off`);
                execute(this, agent, async () => {
                    await survival.gotoQuick(bot, new pf.goals.GoalInvert(new pf.goals.GoalFollow(creeper, 10)), 5000);
                }, -1, 15000);
                return;
            }
            const mobs = survival.rangedThreats(bot, 16);
            if (!mobs.length) return;
            const seen = survival.exposedTo(bot, mobs);
            if (!seen.length) return;
            say(agent, `Taking cover from ${seen[0].name}!`);
            execute(this, agent, async () => {
                const how = await survival.handleRanged(agent, seen);
                bot.modes.behavior_log += `[threat] ${seen.map(m => m.name).join(', ')} could see you; you ${how === 'fought' ? 'fought it' : how === 'cover' ? 'took cover behind blocks' : 'backed away'}.\n`;
                // daylight + underground: leave the caves (that is where the skeletons are)
                if (how !== 'fought' && !nav.isNightTime(bot) && nav.isUnderground(bot) && agent.escape?.up) {
                    await agent.escape.up(agent, { reason: 'skeletons', maxMs: 45000 });
                }
            }, -1, 70000);
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            // [ai-player] melee threats only: ranged mobs further than 3 blocks and creepers belong to ranged_threat
            // (chasing skeletons into caves got Bob shot), so self_defense does not chase them.
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity) && entity.name !== 'creeper' &&
                !(survival.RANGED_MOBS.includes(entity.name) && entity.position.distanceTo(agent.bot.entity.position) > 3), 8);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Fighting ${enemy.name}!`);
                execute(this, agent, async () => {
                    await skills.defendSelf(agent.bot, 8);
                });
            }
        }
    },
    {
        // [ai-player] Oct 20: Bob sat at 1 HP / 0 food for hours with no food while the model mined coal. Runs after
        // self_defense (earlier modes win), before everything else. Eats if auto-eat hasn't within 15 s; at food <= 6
        // with nothing to eat it goes and gets food.
        name: 'hunger',
        description: 'Eat when hungry; when food is low and there is no food, go get some (hunt animals, berries, crops). Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        hungry_since: 0,
        next_try: 0,
        next_stock: 0,
        update: async function (agent) {
            const bot = agent.bot;
            if (bot.food == null) return;
            if (bot.autoEat?.isEating) return;
            if (/^mode:(self_preservation|self_defense|cowardice|ranged_threat|night)$/.test(agent.actions.currentActionLabel || '')) return;
            const now = Date.now();
            const stock = survival.foodStock(bot);
            // [ai-player] keep a small food stock: in daylight, when an animal is close, hunt it (every 10 min at most)
            if (bot.food > 14) {
                this.hungry_since = 0;
                if (stock < 2 && now > this.next_stock && !nav.isNightTime(bot) && bot.health >= 10 &&
                    world.getNearestEntityWhere(bot, e => survival.FOOD_ANIMALS.includes(e.name) && mc.isHuntable(e), 16)) {
                    this.next_stock = now + 10 * 60e3;
                    execute(this, agent, async () => {
                        const r = await survival.huntAnimal(agent, 16);
                        if (r.ok) { await survival.cookRaw(bot); skills.log(bot, `Hunted a ${r.animal} for your food stock.`); }
                    }, -1, 90000);
                }
                return;
            }
            if (edibleFoods(bot, bot.food <= 6).length) {
                if (!this.hungry_since) this.hungry_since = now;
                if (now - this.hungry_since < 15000) return; // auto-eat normally handles this
                this.hungry_since = now;
                execute(this, agent, async () => { await survival.cookOrEat(bot); });
                return;
            }
            this.hungry_since = 0;
            // [ai-player] no food at food <= 12 (was <= 6: he only started looking when already starving)
            if (bot.food > 12 || now < this.next_try) return;
            this.next_try = now + 120000;
            execute(this, agent, async () => {
                const got = await survival.getFood(agent, { escapeUp: agent.escape?.up, reason: 'hungry and no food' });
                if (!got) this.next_try = Date.now() + 180000;
            }, -1, 150000);
        }
    },
    {
        // [ai-player] Oct 20: Bob ignored "sleep at night" in his self-prompt and looped in the cave. At night: stop the
        // self-prompt task, go home through the verified front door if one exists, sleep in the house bed, and keep
        // self-prompting paused until morning. If the bed can't be used, stay inside idle (lower modes are held off)
        // and retry the bed every ~2 min. Once per night; a failed trip home is retried after ~2 min.
        // Listed after self_defense and hunger, so those still win.
        name: 'night',
        // pr20-reconciled-20261027: off by default so night does not pause autonomy or force Bob home.
        // Opt in with BOB_NIGHT_HOME=1 (read at start). Implementation below is kept unchanged.
        description: 'At night go home and sleep in the bed (only when BOB_NIGHT_HOME=1). Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        holding: false,
        done_day: null,
        next_try: 0,
        tries: 0,
        paused_sp: false,
        boot_checked: false,
        far_logged: null,
        max_action_ms: 180000,
        home_at_night: nightHomeEnabled(),
        release: function (agent, why) {
            const sp = agent.self_prompter;
            const resume = (this.paused_sp || !this.boot_checked) && sp.isPaused() && !convoManager.inConversation();
            if (this.holding || resume) console.log(`[ai-player] night: ${why}; ${resume ? 'resuming self-prompting' : 'self-prompting unchanged'}`);
            this.holding = false; this.paused_sp = false; this.tries = 0;
            if (resume) sp.start();
        },
        pauseSelfPrompt: function (agent) {
            const sp = agent.self_prompter;
            if (sp.isActive()) { sp.setPromptPaused(sp.prompt); sp.stopLoop(); this.paused_sp = true; }
        },
        update: async function (agent) {
            if (!this.home_at_night) { // pr20-reconciled-20261027: independent exploration; release any hold/pause once
                if (this.holding || this.paused_sp || !this.boot_checked) this.release(agent, 'night-home off (independent exploration)');
                this.boot_checked = true;
                return;
            }
            if (!isVerifiedHome(getActiveHome())) {
                if (this.holding || this.paused_sp || !this.boot_checked) this.release(agent, 'night-home has no verified house');
                this.boot_checked = true;
                return;
            }
            const bot = agent.bot;
            if (!nav.isNightTime(bot)) {
                if (this.holding || this.paused_sp || !this.boot_checked) this.release(agent, 'morning');
                this.boot_checked = true;
                return;
            }
            if (!this.boot_checked) { this.boot_checked = true; if (agent.self_prompter.isPaused() && !convoManager.inConversation()) this.paused_sp = true; }
            if (convoManager.inConversation()) return;
            if (/^mode:(self_preservation|self_defense|cowardice|hunger|unstuck|ranged_threat)$/.test(agent.actions.currentActionLabel || '')) return;
            const now = Date.now();
            const day = bot.time?.day;
            if (this.holding) {
                this.pauseSelfPrompt(agent); // a chat may have restarted it
                if (bot.isSleeping) return;
                if (now < this.next_try) return;
                if (!agent.isIdle()) return;
            } else {
                if (this.done_day === day || now < this.next_try) return;
                if (nav.homeDistance(bot) > 160) {
                    if (this.far_logged !== day) console.log(`[ai-player] night: ${Math.round(nav.homeDistance(bot))} blocks from home, too far to go back tonight`);
                    this.far_logged = day;
                    return;
                }
            }
            this.next_try = now + 120000;
            this.tries++;
            this.pauseSelfPrompt(agent);
            const from = bot.entity.position.floored();
            console.log(`[ai-player] night: going home to sleep from ${from} (try ${this.tries}, time=${bot.time.timeOfDay}, label=${agent.actions.currentActionLabel || '-'})`);
            execute(this, agent, async () => {
                // [ai-player] item 4: climb out if underground, then walk the recorded route home and through the door
                const inside = agent.home ? await agent.home.walk({ inside: true, maxMs: 150000 }) : await nav.goHomeInside(bot);
                if (!inside) {
                    const at = bot.entity.position.floored();
                    console.log(`[ai-player] night: could not get inside the house (now at ${at}); retry in ~2 min`);
                    if (!this.holding && this.paused_sp && agent.self_prompter.isPaused()) { this.paused_sp = false; agent.self_prompter.start(); }
                    return;
                }
                this.holding = true; this.done_day = day;
                const bed = nav.findHomeBed(bot);
                if (!bed) { const h = getActiveHome(); console.log(`[ai-player] night: inside, but no bed found near ${h.bed?.x} ${h.bed?.y} ${h.bed?.z}; staying inside`); return; }
                if (bot.entity.position.distanceTo(bed.position.offset(0.5, 0, 0.5)) > 2)
                    await nav.gotoWithin(bot, new pf.goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1), 20000, nav.walkMovements(bot));
                try {
                    await bot.sleep(bed);
                    recordSleptBed(bed.position); // [ai-player] protect the bed he actually slept in
                    console.log(`[ai-player] night: in bed at ${bed.position} (${bed.name})`);
                    skills.log(bot, 'You are in bed for the night.');
                } catch (e) {
                    console.log(`[ai-player] night: can't sleep yet (${e.message}); staying inside, retry in ~2 min`);
                }
            });
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item', 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player' && !isSpectator(agent.bot, entity), this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity(e => !isSpectator(agent.bot, e));
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport. Locked off on NewEarth.',
        interrupts: [],
        // [ai-player] stuck-home-20261026: cheat is locked off. Nothing (profile, !setMode, setOn, loadJson,
        // generated code) can turn it on; skills' /tp, /setblock paths stay dead.
        get on() { return false; },
        set on(v) { if (v) console.log('[ai-player] cheat mode: refused to turn on (locked off)'); },
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

// [ai-player] ---- unstuck escalation and hunger helpers ----
function houseEntranceNow() {
    const h = getActiveHome();
    return isVerifiedHome(h) ? h.entrance : null;
}
// pr20-reconciled-20261027: navigation priority (no extra controller; these are the existing pieces):
//  1. danger: self_preservation / self_defense / cowardice / ranged_threat / hunger modes interrupt anything;
//  2. normal movement: mineflayer-pathfinder toward the objective the model chose (skills.goToPosition etc.);
//  3. one bounded recovery: unstuck (moveAway 10 s + nudge), then one escalation (escape.up climb, 60 s);
//  4. repeated failure: failures.record + escape.js route blacklist + stuck_guard blocks the same commands near the
//     spot, and a system note tells the model to choose a different task or place;
//  5. home only by choice (model command) or operator (bob-m4-ctl home / tphome). Automatic home paths are opt-in:
//     stuck-home auto teleport (auto / BOB_STUCK_HOME_AUTO), night-home (BOB_NIGHT_HOME), unstuck walk-home (BOB_UNSTUCK_HOME).
// pr20-reconciled-20261027: opt-in switches for the home-bound behaviours (default off = independent player).
export function nightHomeEnabled(env = process.env) { return env.BOB_NIGHT_HOME === '1'; }
export function unstuckWalkHomeEnabled(env = process.env) { return env.BOB_UNSTUCK_HOME === '1'; }
const UNSTUCK_WALK_HOME = unstuckWalkHomeEnabled();
const STUCK_BLOCK_MS = 5 * 60e3;
// never dig through anything that looks built (house, chests, beds, doors) while escaping
const KEEP_BLOCKS = /planks|_log$|_wood$|door|stairs|slab|glass|carpet|_bed$|chest|furnace|crafting_table|fence|torch|wool|banner|lantern/;

async function escapeStuck(agent, spot, cmds) {
    // [ai-player] item 3: escalation = climb a staircase out of the cave (escape.js), then (near home, on the surface)
    // a progress-checked walk to the entrance. Failed routes are blacklisted for 10 min; the model gets a short note.
    const bot = agent.bot;
    try { bot.pathfinder.stop(); } catch (e) {}
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
    agent.actions.cancelResume();
    cmds = [...new Set(cmds.filter(c => c && c.startsWith('!')))];
    agent.stuck_guard = { pos: spot.clone(), until: Date.now() + STUCK_BLOCK_MS, cmds };
    const me = bot.entity.position;
    const door = houseEntranceNow();
    const home_d = door ? Math.hypot(me.x - door.x, me.z - door.z) : Infinity;
    const under = nav.isUnderground(bot);
    console.log(`[ai-player] unstuck: escalating at ${spot} (underground=${under}, health=${Math.round(bot.health)}); blocking ${cmds.join(' ') || '-'} near there for ${STUCK_BLOCK_MS / 60e3} min`);
    let where = null, failed = [];
    if (under && agent.escape?.up) {
        const r = await agent.escape.up(agent, { reason: 'stuck', maxMs: 60000 });
        if (r.ok) where = 'open sky (dug a staircase up)'; else failed.push(`climbing out (${r.why})`);
    }
    // pr20-reconciled-20261027: escalation no longer walks Bob home unless BOB_UNSTUCK_HOME=1.
    // Walk-home also requires a verified house; the retired hilltop is never a fallback.
    if (UNSTUCK_WALK_HOME && !where && home_d < 64 && !nav.isUnderground(bot) && agent.escape?.gotoChecked) {
        if (agent.home?.walkHome) { const ok = await agent.home.walkHome(agent, { inside: false, maxMs: 60000 }); if (ok) where = 'the house entrance'; else failed.push('walking the home route'); }
        else if (await agent.escape.gotoChecked(agent, new pf.goals.GoalNear(door.x, door.y, door.z, 1), { ms: 40000, label: 'stuck->entrance', movements: nav.walkMovements(bot) })) where = 'the house entrance';
        else failed.push('walking to the house entrance');
    }
    const at = bot.entity.position.floored();
    console.log(`[ai-player] unstuck: escalation ${where ? 'reached ' + where : 'failed (' + failed.join('; ') + ')'}; now at ${at}`);
    const note = `[stuck] You got stuck at ${spot.x} ${spot.y} ${spot.z}${cmds.length ? ' doing ' + cmds.join(', ') : ''}. ${where ? 'You got out to ' + where : failed.length ? 'Getting out failed: ' + failed.join('; ') : 'You are on the surface; walk to a different, open area'} (now at ${at.x} ${at.y} ${at.z}). Those commands are blocked near there for ${STUCK_BLOCK_MS / 60e3} minutes; choose a different task or a different reachable place and do not retry the same route${bot.food <= 12 ? ', and get food first (!getFood)' : ''}.`;
    bot.modes.behavior_log += note + '\n';
    try { await agent.history.add('system', note); } catch (e) {}
}

const edibleFoods = survival.edibleFoods;

// [ai-player] food helpers moved to library/survival.js (item 2)

async function execute(mode, agent, func, timeout=-1, max_ms=null) {
    if (agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    // [ai-player] A mode action may not block forever. While a mode is active no other mode (not even unstuck) runs
    // and the self-prompt loop cannot restart, so a pathfinder goto that never resolves (e.g. self_preservation's
    // moveAway(20) when boxed in at low health, 22:08 EDT) wedged Bob. After MODE_ACTION_MAX_MS: stop the action
    // (interrupt + pathfinder stop; ActionManager abandons it after 10 s more) and clear mode.active.
    const MODE_ACTION_MAX_MS = max_ms || mode.max_action_ms || 60000;
    let mode_timer = null;
    let mode_timed_out = false;
    const run = agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
    }, { timeout });
    const guard = new Promise(r => { mode_timer = setTimeout(() => { mode_timed_out = true; r(null); }, MODE_ACTION_MAX_MS); });
    let code_return = await Promise.race([run, guard]);
    clearTimeout(mode_timer);
    if (mode_timed_out) {
        console.warn(`[ai-player] mode ${mode.name} action ran over ${MODE_ACTION_MAX_MS / 1000}s; stopping it so modes and self-prompting can continue`);
        try { agent.bot.pathfinder.stop(); } catch (_) {}
        await agent.actions.stop();
        code_return = { success: false, message: `mode ${mode.name} timed out`, interrupted: true, timedout: true };
    }
    mode.active = false;
    console.log(`Mode ${mode.name} finished executing, code_return: ${code_return.message}`);

    let should_reprompt = 
        !mode.holding && // [ai-player] night hold: do not ask the model what to do next
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(role, `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}.
        Your behavior log: ${logs}\nRespond accordingly.`);
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        if (mode_name === 'cheat' && on) { console.log('[ai-player] cheat mode: setOn refused (locked off)'); return false; } // stuck-home-20261026
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent?.stuckHome?.holding) return; // [ai-player] stuck-home-20261026: stand still during the /home warmup
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        for (let mode of modes_list) {
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active || mode.holding) break; // [ai-player] night hold keeps idle modes from walking Bob out
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
    console.log(`[ai-player] cheat mode: locked off (isOn=${agent.bot.modes.isOn('cheat')})`); // stuck-home-20261026
}

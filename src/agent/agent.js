import { HomeRegistry, getActiveHome, isVerifiedHome } from './library/bob_home.js';
import { HomesteadTracker } from './library/bob_homestead.js';
import { botGetBlock } from './library/vec3_util.js';
import { History } from './history.js';
import { Coder } from './coder.js';
import { codeLaneInfo } from './library/bob_eval_harness.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes, releaseNightHold } from './modes.js';
import { initBot, stampLikelyAttacker } from '../utils/mcdata.js';
import { clearShelter, installShelterMovementGuard } from './library/night_shelter.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { LongMemory } from './library/long_memory.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import { isModelErrorReply } from '../utils/model_errors.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { installNoGoZoneGuard } from './library/no_go_zones.js';
import { installProtectedAreaGuard } from './library/protected_area.js';
import { RepeatGuard } from './library/repeat_guard.js';
import Vec3 from 'vec3';
import { installPhysicsGuard, memStatus, heapGuard } from './library/stability.js';
import { escapeUp, gotoChecked } from './library/escape.js';
import { HomeRoutes } from './library/home_route.js';
import { installResetRecovery } from './library/reset_recovery.js'; // [ai-player] reset-recovery-20261026
import { installChatGuard, stripCommandPrefix, confirmSetHome } from './library/chat_guard.js'; // [ai-player] stuck-home-20261026
import { installStuckHome } from './library/stuck_home.js'; // [ai-player] stuck-home-20261026
import { Failures } from './library/failures.js';
import { attachBobBrain } from './library/bob_brain.js';
import { attachBobEvalHarness, harnessOf } from './library/bob_eval_harness.js';

// [ai-player] read-only: doors, gates and pressure plates around the verified front door, for the log
function frontDoorState(bot) {
    const home = getActiveHome();
    if (!isVerifiedHome(home) || !home.door) return '';
    const out = [];
    for (let x = home.door.x - 2; x <= home.door.x + 2; x++) for (let y = home.door.y; y <= home.door.y + 1; y++) for (let z = home.door.z - 2; z <= home.door.z + 2; z++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b || !/_door$|_gate$|pressure_plate/.test(b.name)) continue;
        const p = b.getProperties();
        out.push(`${b.name}@${x},${y},${z}` + ['facing', 'half', 'hinge', 'open', 'powered'].filter(k => p[k] != null).map(k => ` ${k}=${p[k]}`).join(''));
    }
    return out.join('; ');
}

// [ai-player] Public chat gate: Bob only talks in chat when answering a player who spoke to him.
const ADDRESSED_WINDOW_MS = 5 * 60_000;   // a reply may take a while (75 s model spacing)
const CONVO_FOLLOWUP_MS = 2 * 60_000;     // after Bob replied, that player's next lines count as addressed
// [ai-player] Essentials and other plugin notices, e.g. "Set fly mode enabled for MineBobNE." (Oct 20, server agent)
const SYSTEM_LINE = /^(set (fly|flight|god|walk|speed|fly speed|walk speed)[ a-z]* (mode|speed)? ?(enabled|disabled|to)|set fly mode|fly mode|flight (enabled|disabled)|god mode (enabled|disabled)|is now afk|is no longer afk|teleporting\.\.\.|your game ?mode has been|\[(essentials|server|grim|newearth)[^\]]*\])/i;

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        // [ai-player] Fix 6: code lane startup log (CODER_MODE / coding_enabled / selected lane).
        try {
            const lane = codeLaneInfo({ coderMode: process.env.BOB_CODER_MODE, codingEnabled: settings.allow_insecure_coding !== false });
            console.log('[ai-player] code lane: ' + lane.reason);
        } catch (_) {}
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();
        // [ai-player] lessons / places / saved skills (bots/<name>/*.json); never fatal
        try { this.longMemory = new LongMemory(this); } catch (e) { console.warn('[ai-player] long-memory disabled:', e.message); this.longMemory = null; }
        try { this.homeState = new HomeRegistry(this); } catch (e) { console.warn('[ai-player] verified-home disabled:', e.message); this.homeState = null; }
        try { this.homestead = new HomesteadTracker(this); } catch (e) { console.warn('[ai-player] homestead tracker disabled:', e.message); this.homestead = null; }
        try { this.failures = new Failures(this); } catch (e) { console.warn('[ai-player] failures disabled:', e.message); this.failures = null; } // item 5

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        // Only recent interrupted/uncertain outcomes are injected into the next Andy goal turn.
        this._recentTaskEvents = [];
        this._taskEventSerial = 0;
        this.bot.on('bob_task_event', event => {
            if (!['task.cancel_requested', 'task.uncertain', 'task.finished'].includes(event?.type)) return;
            if (event.type === 'task.finished' && event.state === 'succeeded') return;
            const serial = ++this._taskEventSerial;
            this._recentTaskEvents.push({
                serial, type: event.type, label: String(event.label || '').slice(0, 80),
                taskId: String(event.taskId || '').slice(0, 80),
                reason: String(event.reason || '').slice(0, 110),
                state: String(event.state || '').slice(0, 30)
            });
            if (this._recentTaskEvents.length > 12) this._recentTaskEvents.splice(0, this._recentTaskEvents.length - 12);
        });
        try { attachBobEvalHarness(this); } catch (err) { console.warn(`[bob-eval] disabled: ${err?.message || err}`); }
        try { attachBobBrain(this); } catch (err) { console.warn(`[bob-brain] disabled: ${err?.message || err}`); }
        installPhysicsGuard(this.bot); // [ai-player] stability.js: clamp runaway velocity (hang/OOM fix)
        this.escape = { up: escapeUp, gotoChecked }; // [ai-player] item 3: staircase escape + checked routes
        try { this.home = new HomeRoutes(this); } catch (e) { console.warn('[ai-player] home-route disabled:', e.message); this.home = null; } // item 4
        if (this.home) { // [ai-player] stuck-home-20261026: every walk home (night, unstuck walkHome) feeds the stuck-home counter
            const walk = this.home.walk.bind(this.home);
            this.home.walk = async (opts) => {
                this.stuckHome?.markHomeGoal();
                const ok = await walk(opts);
                try { this.stuckHome?.reportHomeAttempt(!!ok, 'home-route')?.catch?.(() => {}); } catch (_) {}
                return ok;
            };
        }

        // [ai-player] Watchdog heartbeat to the parent (agent_process.js). If the event loop hangs or the
        // server connection goes silent (no packets) the parent kills and restarts this process.
        this._lastPacketAt = 0;
        this._spawned = false;
        try { this.bot._client.on('packet', () => { this._lastPacketAt = Date.now(); }); } catch (_) {}
        if (typeof process.send === 'function' && !this._heartbeatTimer) {
            let beats = 0;
            const beat = () => {
                try { process.send({ type: 'ai-player-heartbeat', at: Date.now(), spawned: this._spawned, lastPacketAt: this._lastPacketAt }); } catch (_) {}
                // [ai-player] read-only status line once a minute (position / health / food) for monitoring.
                try {
                    const ds = this._spawned ? frontDoorState(this.bot) : '';
                    if (ds && ds !== this._lastDoorState) { this._lastDoorState = ds; console.log(`[ai-player] door-state ${ds}`); }
                } catch (_) {}
                if (this._spawned && (beats++ % 6) === 0) {
                    try {
                        const p = this.bot.entity?.position;
                        console.log(`[ai-player] status pos=${p ? `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})` : '?'} health=${Math.round(this.bot.health ?? -1)} food=${Math.round(this.bot.food ?? -1)} action=${this.actions?.currentActionLabel || '-'} time=${this.bot.time?.timeOfDay ?? '?'} ${memStatus(this)}${this.bobBrain?.statusSuffix?.() || ''}`);
                    } catch (_) {}
                }
                try { heapGuard(this); } catch (_) {}
            };
            this._heartbeatTimer = setInterval(beat, 10_000);
            beat();
        }
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            installChatGuard(this.bot); // [ai-player] stuck-home-20261026: no outgoing line may start with '/'
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this._spawned = true;
                this.clearBotLogs();
                installNoGoZoneGuard(this);
                installProtectedAreaGuard(this);
                try { installShelterMovementGuard(); } catch (e) { console.warn('[ai-player] shelter movement guard skipped:', e.message); }
                try { installResetRecovery(this); } catch (e) { console.warn('[ai-player] reset-recovery disabled:', e.message); } // reset-recovery-20261026
                try { installChatGuard(this.bot); installStuckHome(this); } catch (e) { console.warn('[ai-player] stuck-home disabled:', e.message); } // stuck-home-20261026
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        if (this.longMemory && !this._placeTimer) {
            this._placeTimer = setInterval(() => {
                this.longMemory?.observe();
                try {
                    const inv = {};
                    for (const it of this.bot?.inventory?.items?.() || []) inv[it.name] = (inv[it.name] || 0) + it.count;
                    const origin = this.bot?.entity?.position;
                    const getBlock = botGetBlock(this.bot);
                    this.homestead?.observe({
                        getBlock,
                        inventory: inv,
                        position: origin,
                        home: this.homeState?.snapshot?.(),
                    });
                    if (origin && this.homeState && !this.homeState.hasHome()) {
                        const hs = this.homestead?.snapshot?.() || {};
                        this.homeState.observeWorld(getBlock, origin, {
                            site: hs.site, placed: hs.placed || [], requireOwned: true,
                        });
                    }
                    void this.maybeSetEssentialsHome();
                } catch (_) {}
            }, 30000);
            if (!this._homeTimer) this._homeTimer = setInterval(() => { try { this.home?.tick(); } catch (_) {} }, 2000); // [ai-player] item 4 breadcrumbs
            setTimeout(() => this.longMemory?.observe(), 5000);
        }
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message, is_whisper = false) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;
                // [ai-player] server/plugin system lines (Essentials fly/god/afk/teleport notices etc.) are not players talking
                if (SYSTEM_LINE.test(message) || !username || /^(server|console|essentials)$/i.test(username)) {
                    console.log(`[ai-player] ignored system line from ${username || '-'}: ${String(message).slice(0, 80)}`);
                    return;
                }

                this.shut_up = false;
                this._noteAddressed(username, message, is_whisper);

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', (username, message) => respondFunc(username, message, true));
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        // [ai-player] backport of 26f72b6 for auto-eat 3.3.6: merge into the defaults instead of
        // replacing them (replacing dropped eatingTimeout/offhand/equipOldItem), and make sure it's on.
        Object.assign(this.bot.autoEat.options, {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        });
        this.bot.autoEat.enable();

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            // [ai-player] No auto-greeting on join (family server chat filter + kids).
            // Stay quiet until a player talks to the bot.
            console.log(`[ai-player] Spawned as ${this.name}; no init_message, skipping auto greeting.`);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        // [ai-player] Fix 1b: clear the goal too. stop() alone can leave a pending goal that the
        // next physics tick resumes, so an interrupted bot kept walking back into the fight.
        try { this.bot.pathfinder.setGoal(null); } catch (e) { /* pathfinder not ready */ }
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                this.longMemory?.observeCommand(message, execute_res);
                this.failures?.observeCommand(message, execute_res);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            const ev = harnessOf(this);
            ev.noteTurnStart(this, { source, self_prompt, iteration: i });
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);
            const v2Turn = this._bobV2PromptToken;
            this._bobV2PromptToken = null;

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                ev.noteTurnEnd({ reason: 'empty_response' });
                break; // empty response ends loop
            }
            if (isModelErrorReply(res)) {
                // [ai-player] API placeholder: not added to history, never sent to chat.
                console.warn(`[ai-player] model error reply ${JSON.stringify(res.trim())}; not chatted, not stored in history.`);
                this.last_reply_was_model_error = true;
                ev.noteTurnEnd({ reason: 'model_error' });
                break;
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                ev.noteHistoryAppend({ role: 'assistant', kind: 'command_reply', chars: String(res).length });
                ev.noteParse({ has_command: true, command_name, exists: commandExists(command_name) });
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    ev.noteHistoryAppend({ role: 'system', kind: 'unknown_command', chars: String(command_name).length });
                    ev.noteTurnEnd({ reason: 'unknown_command' });
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) {
                    ev.noteGuard({ kind: 'dropped_by_interrupt', blocked: true });
                    ev.noteTurnEnd({ reason: 'dropped_by_interrupt' });
                    break;
                }
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                // [ai-player] Command text never goes to chat (show_command_syntax ignored). Only the plain
                // talk before the command is sent, and only when answering a player (gate in routeResponse).
                {
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    console.log(`[ai-player] command not chatted: ${res.slice(0, 200)}`);
                    if (pre_message.length > 0)
                        this.routeResponse(source, pre_message, { talk: true });
                }

                // [ai-player] Do not run the same command (or a goToCoordinates within 3 blocks of the same
                // target) a 3rd time within 2 minutes, nor !stop twice in a row; tell the model instead.
                this._repeatGuard = this._repeatGuard || new RepeatGuard();
                const repeat_note = this._repeatGuard.check(res);
                if (repeat_note) {
                    ev.noteGuard({ kind: 'repeat', blocked: true, note: repeat_note });
                    this.history.add('system', repeat_note);
                    ev.noteHistoryAppend({ role: 'system', kind: 'repeat_guard', chars: String(repeat_note).length });
                    ev.noteTurnEnd({ reason: 'repeat_guard' });
                    continue;
                }

                this._bobV2ClaimAdvice = v2Turn;
                let execute_res;
                try {
                    execute_res = await executeCommand(this, res);
                } finally {
                    this._bobV2ClaimAdvice = false;
                }

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                this.longMemory?.observeCommand(res, execute_res);
                this.failures?.observeCommand(res, execute_res);
                used_command = true;

                if (execute_res) {
                    this.history.add('system', execute_res);
                    ev.noteHistoryAppend({ role: 'system', kind: 'command_result', chars: String(execute_res).length });
                    ev.noteGoalCheck(this);
                    ev.noteTurnEnd({ reason: 'command_returned' });
                } else {
                    ev.noteGoalCheck(this);
                    ev.noteTurnEnd({ reason: 'command_undefined' });
                    break;
                }
            }
            else { // conversation response
                this.history.add(this.name, res);
                ev.noteHistoryAppend({ role: 'assistant', kind: 'conversation', chars: String(res).length });
                ev.noteParse({ has_command: false, exists: false });
                ev.noteTurnEnd({ reason: 'conversation' });
                this.routeResponse(source, res, { talk: true });
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    // [ai-player] Remember players who actually spoke to Bob (whisper, his name in the line, or a follow-up
    // shortly after Bob replied to them). Only those players get chat replies.
    _noteAddressed(username, message, is_whisper) {
        this._addressedAt = this._addressedAt || {};
        this._repliedAt = this._repliedAt || {};
        const now = Date.now();
        const text = String(message || '').toLowerCase();
        const name = String(this.name || '').toLowerCase();
        const addressed = is_whisper
            || /\bbob\b/.test(text)
            || (name && text.includes(name))
            || (this._repliedAt[username] && now - this._repliedAt[username] < CONVO_FOLLOWUP_MS);
        if (addressed) this._addressedAt[username] = now;
        console.log(`[ai-player] player message from ${username} addressed_to_bob=${!!addressed}${is_whisper ? ' (whisper)' : ''}`);
    }

    _wasAddressedBy(username) {
        const at = this._addressedAt?.[username];
        return !!at && Date.now() - at < ADDRESSED_WINDOW_MS;
    }

    async routeResponse(to_player, message, opts = {}) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // [ai-player] Public chat only for plain talk answering a player who spoke to Bob.
            // Self-prompted turns, command output and system text stay in the console/log.
            const is_player = !self_prompt && to_player !== 'system' && to_player !== this.name && !convoManager.isOtherAgent(to_player);
            if (!opts.talk || !is_player || !this._wasAddressedBy(to_player)) {
                const why = !opts.talk ? 'system/command text' : (!is_player ? 'self-prompt' : `${to_player} did not speak to Bob`);
                console.log(`[ai-player] chat suppressed (${why}): ${String(message).slice(0, 200)}`);
                return;
            }
            this._repliedAt = this._repliedAt || {};
            this._repliedAt[to_player] = Date.now();
            this.openChat(message, { reply_to: to_player });
        }
    }

    async openChat(message, opts = {}) {
        // [ai-player] Never post command text, and only post when routeResponse cleared it as a reply to a player.
        message = String(message ?? '');
        const cmd_in_msg = containsCommand(message);
        if (cmd_in_msg) message = message.substring(0, message.indexOf(cmd_in_msg));
        message = message.replace(/![a-zA-Z_]+(\([^)]*\))?/g, '').trim();
        message = stripCommandPrefix(message); // [ai-player] stuck-home-20261026: LLM text is never a server command
        if (!opts.reply_to) {
            if (message) console.log(`[ai-player] chat suppressed (not a player reply): ${message.slice(0, 200)}`);
            return;
        }
        if (!message) {
            console.log('[ai-player] chat suppressed (command only, no plain talk)');
            return;
        }
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = stripCommandPrefix(message.replaceAll('\n', ' ')); // [ai-player] stuck-home-20261026 (also after translation)

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            // [ai-player] GriefPrevention spam filter: never repeat a chat line Bob sent in the last 15 min.
            const norm = message.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            this._recentChats = (this._recentChats || []).filter(c => Date.now() - c.at < 15 * 60_000);
            if (this._recentChats.some(c => c.norm === norm)) {
                console.log(`[ai-player] chat suppressed (repeat of a recent line): ${message.slice(0, 200)}`);
                return;
            }
            this._recentChats.push({ norm, at: Date.now() });
            if (this._recentChats.length > 20) this._recentChats.shift();
            if (settings.chat_ingame) {
                console.log(`[ai-player] ingame-chat: ${message.slice(0, 200)}`);
                this.bot.chat(message);
            }
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
                // [ai-player] Fix 1c: stamp the nearest mob so a neutral mob that actually hit Bob
                // counts as hostile for a few seconds (mc.isAggressiveHostile).
                try { stampLikelyAttacker(this.bot); } catch (e) { /* best-effort */ }
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            clearShelter(this.bot); // [ai-player] Fix 1e round 2: disconnect ends the shelter
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        // [ai-player] log death / respawn positions (to check the bed respawn point).
        this.bot.on('death', () => {
            clearShelter(this.bot); // [ai-player] Fix 1e round 2: a death ends the shelter (no pack-up, no error)
            releaseNightHold('death'); // [ai-player] Fix 1e round 3: drop the night hold right away
            const p = this.bot.entity?.position;
            console.log(`[ai-player] died at ${p ? `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})` : '?'}`);
        });
        this.bot.on('spawn', () => {
            clearShelter(this.bot); // [ai-player] Fix 1e round 2: spawn also fires at first login; a null shelter is a no-op
            releaseNightHold('respawn'); // [ai-player] Fix 1e round 3: drop the night hold right away
            setTimeout(() => {
                const p = this.bot.entity?.position;
                console.log(`[ai-player] spawn event at ${p ? `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})` : '?'}`);
            }, 1500);
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            clearShelter(this.bot); // [ai-player] Fix 1e round 2: kicked ends the shelter
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                this.longMemory?.observeDeath(message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                // [ai-player] always yield to timers/IO: when update() took >= 300 ms this loop used to continue on
                // microtasks only, which can starve heartbeat, physics and network timers.
                await new Promise((resolve) => setTimeout(resolve, Math.max(remaining, 25)));
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }

    // Essentials /home house is still the retired hilltop until Bob stands at a verified
    // entrance and we send the fixed /sethome house. Never send /home house before that.
    // Do not set essentialsSet until the server confirms the home; no reply or an error
    // means it is not set. Do not round-trip /home house (that can still land at the hilltop).
    async maybeSetEssentialsHome() {
        try {
            if (this._sethomeBusy) return false;
            const home = this.homeState?.snapshot?.();
            if (!isVerifiedHome(home) || home.essentialsSet) return false;
            const p = this.bot?.entity?.position;
            const e = home.entrance;
            if (!p || !e) return false;
            if (Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z) > 2) return false;
            this._sethomeBusy = true;
            try {
                const result = await confirmSetHome(this.bot);
                if (!result.ok) {
                    console.log(`[ai-player] /sethome house not confirmed (${result.why}); Essentials /home house stays unset`);
                    return false;
                }
                this.homeState.markEssentialsSet(true);
                console.log('[ai-player] /sethome house confirmed at the verified entrance; Essentials /home house must not stay at the retired hilltop');
                return true;
            } finally {
                this._sethomeBusy = false;
            }
        } catch (e) {
            console.log(`[ai-player] sethome skipped (${e.message})`);
            return false;
        }
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        console.log(`[ai-player] cleanKill (not chatted): ${code > 1 ? 'Restarting.' : 'Exiting.'} ${msg}`);
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}

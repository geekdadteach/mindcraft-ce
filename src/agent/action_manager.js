import { noteRuntimeFinish, noteRuntimeStart } from './library/bob_brain_v2.js';
import { TaskLifecycle } from './library/bob_task_lifecycle.js';

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        this.abandoned = 0; // actions that ignored stop() for 10 s
        this.currentTask = null;
        this._startQueue = Promise.resolve();
        this.lifecycle = new TaskLifecycle({ emit: event => {
            try { this.agent?.bot?.emit('bob_task_event', event); } catch (_) {}
            console.log('[ai-player] task-event ' + JSON.stringify(event));
        }});
    }

    // [ai-player] One action at a time: every action gets a generation number on the bot. Long-running skill
    // loops (attack, defend, avoid, pickup, collect, stay) compare it and quit when a newer action started,
    // so an abandoned action cannot keep driving pvp/pathfinder/collectblock in the background.
    _releaseBotPlugins(bot) {
        try { bot.pvp?.stop(); } catch (e) {}
        try { bot.pathfinder.stop(); } catch (e) {}
        try { bot.pathfinder.setGoal(null); } catch (e) {}
        try { bot.stopDigging(); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
        try {
            // a collectBlock task that never finishes leaves cancelTask() waiters (and their listeners) behind
            if (bot.collectBlock?.targets && !bot.collectBlock.targets.empty) {
                bot.collectBlock.targets.clear();
                bot.emit('collectBlock_finished');
            }
        } catch (e) {}
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop() {
        if (!this.executing) return;
        const task = this.currentTask;
        this.lifecycle.requestCancel(task, 'preempted');
        const started = Date.now();
        while (this.executing && this.currentTask === task) {
            this.agent.requestInterrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
            if (this.executing && this.currentTask === task && Date.now() - started > 10000) {
                this.abandoned++;
                console.warn('[ai-player] action refused cancellation after 10s; marking uncertain (abandoned=' + this.abandoned + ')');
                this.lifecycle.abandon(task, 'cancel_timeout');
                this.agent.bot._actionGen = (this.agent.bot._actionGen || 0) + 1;
                this._releaseBotPlugins(this.agent.bot);
                this.cancelResume();
                this.executing = false;
                this.currentTask = null;
                this.currentActionLabel = '';
                this.currentActionFn = null;
                break;
            }
        }
    }

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let timer = null;
        let runtimeReceipt = null;
        let task = null;
        const staleReturn = () => ({
            success: false,
            message: 'Previous action settled after cancellation; ignored.',
            interrupted: true, timedout: false
        });
        try {
            if (this.last_action_time > 0) {
                const diff = Date.now() - this.last_action_time;
                this.recent_action_counter = diff < 20 ? this.recent_action_counter + 1 : 0;
                if (this.recent_action_counter > 3) this.cancelResume();
                if (this.recent_action_counter > 5) {
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return {success:false, message:'Infinite action loop detected, shutting down.',interrupted:false,timedout:false};
                }
            }
            this.last_action_time = Date.now();

            // Serialize *starts* only. Do not hold this queue across the running action.
            const previousStart = this._startQueue;
            let releaseStart;
            this._startQueue = new Promise(resolve => { releaseStart = resolve; });
            try {
                await previousStart;
                await this.stop();
                this.agent.clearBotLogs();
                task = this.lifecycle.begin(actionLabel);
                this.currentTask = task;
                this.executing = true;
                this.timedout = false;
                this.agent.bot._actionGen = (this.agent.bot._actionGen || 0) + 1;
                this.currentActionLabel = actionLabel;
                this.currentActionFn = actionFn;
                if (timeout > 0) timer = this._startTimeout(timeout, task);
                runtimeReceipt = noteRuntimeStart(this.agent, actionLabel);
            } finally {
                releaseStart();
            }
            await actionFn();
            clearTimeout(timer);
            if (this.currentTask !== task) {
                this.lifecycle.settle(task, {success:false, interrupted:true});
                noteRuntimeFinish(this.agent, runtimeReceipt, {success:false, interrupted:true, timedout:false, threw:false});
                return staleReturn();
            }
            const cancelled = task.state === 'cancel_requested' || !!this.agent.bot.interrupt_code;
            const timedout = this.timedout;
            this.lifecycle.settle(task, {success:!cancelled && !timedout, interrupted:cancelled, timedout});
            this.executing = false;
            this.currentTask = null;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            const output = cancelled && !timedout ? '' : this.getBotOutputSummary();
            this.agent.clearBotLogs();
            noteRuntimeFinish(this.agent, runtimeReceipt, {
                success:!cancelled && !timedout, interrupted:cancelled, timedout, threw:false
            });
            if (!cancelled && !timedout) this.agent.bot.emit('idle');
            return {success:!cancelled && !timedout, message:output, interrupted:cancelled, timedout};
        } catch (err) {
            clearTimeout(timer);
            if (task && this.currentTask !== task) {
                this.lifecycle.settle(task, {success:false, interrupted:true, error:err});
                noteRuntimeFinish(this.agent, runtimeReceipt, {success:false, interrupted:true, timedout:false, threw:true});
                return staleReturn();
            }
            const interrupted = !!(task?.state === 'cancel_requested' || this.agent.bot?.interrupt_code);
            if (task) this.lifecycle.settle(task, {success:false, interrupted, error:err});
            if (task && this.currentTask === task) {
                this.executing = false;
                this.currentTask = null;
                this.currentActionLabel = '';
                this.currentActionFn = null;
            }
            this.cancelResume();
            console.error('Code execution triggered catch:', err);
            const message = (interrupted ? '' : this.getBotOutputSummary()) +
                '!!Code threw exception!!\nError: ' + String(err) +
                '\nStack trace:\n' + String(err?.stack || '') + '\n';
            noteRuntimeFinish(this.agent, runtimeReceipt, {
                success:false, interrupted, timedout:!!this.timedout, threw:true
            });
            if (task) this.agent.clearBotLogs();
            if (!interrupted && task) this.agent.bot.emit('idle');
            return {success:false, message, interrupted, timedout:!!this.timedout};
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(timeoutMinutes = 10, task = null) {
        return setTimeout(async () => {
            if (!task || this.currentTask !== task) return;
            console.warn('Code execution timed out after ' + timeoutMinutes + ' minutes; cancelling task');
            this.timedout = true;
            this.lifecycle.requestCancel(task, 'action_timeout');
            this.agent.history.add('system', 'Code execution timed out; requesting cancellation.');
            await this.stop();
        }, timeoutMinutes * 60 * 1000);
    }
}
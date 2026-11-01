import { writeFile, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import { Vec3 } from 'vec3';
import {ESLint} from "eslint";
import { LongMemory } from './library/long_memory.js';
import settings from './settings.js';
import { codeLaneInfo, harnessOf } from './library/bob_eval_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Coder {
    constructor(agent) {
        this.agent = agent;
        this.file_counter = 0;
        this.fp = '/bots/'+agent.name+'/action-code/';
        this.code_template = '';
        this.code_lint_template = '';
        this.ready = null;
        mkdirSync('.' + this.fp, { recursive: true });
    }

    async _loadTemplates() {
        [this.code_template, this.code_lint_template] = await Promise.all([
            readFile(path.join(__dirname, '../../bots/execTemplate.js'), 'utf8'),
            readFile(path.join(__dirname, '../../bots/lintTemplate.js'), 'utf8')
        ]);
    }

    async _ensureReady() {
        if (!this.ready)
            this.ready = this._loadTemplates();
        await this.ready;
    }

    // [ai-player] Fix 6: the code lane log + the harness lane record (once per agent).
    logLaneOnce() {
        if (this._laneLogged) return;
        this._laneLogged = true;
        const info = { coderMode: process.env.BOB_CODER_MODE, codingEnabled: settings.allow_insecure_coding !== false };
        const lane = codeLaneInfo(info);
        console.log('[ai-player] code lane: ' + lane.reason);
        try { harnessOf(this.agent).noteLaneSelection(info); } catch (_) {}
    }

    async generateCode(agent_history) {
        await this._ensureReady();
        this.logLaneOnce();
        this.agent.bot.modes.pause('unstuck');
        lockdown();
        let messages = agent_history.getHistory(); 
        messages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let no_code_failures = 0;
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (this.agent.bot.interrupt_code)
                return null;
            const messages_copy = JSON.parse(JSON.stringify(messages));
            let res = await this.agent.prompter.promptCoding(messages_copy);
            if (this.agent.bot.interrupt_code)
                return null;
            let contains_code = res.indexOf('```') !== -1;
            if (!contains_code) {
                if (res.indexOf('!newAction') !== -1) {
                    messages.push({
                        role: 'assistant', 
                        content: res.substring(0, res.indexOf('!newAction'))
                    });
                    continue;
                }
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system', 
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'}
                );
                console.warn("No code block generated. Trying again.");
                no_code_failures++;
                continue;
            }
            const code = res.substring(res.indexOf('```')+3, res.lastIndexOf('```'));
            const result = await this._stageCode(code);
            const executionModule = result.func;
            const lintResult = await this._lintCode(result.src_lint_copy);
            if (lintResult) {
                const message = 'Error: Code lint error:'+'\n'+lintResult+'\nPlease try again.';
                console.warn("Linting error:"+'\n'+lintResult+'\n');
                messages.push({ role: 'system', content: message });
                continue;
            }
            if (!executionModule) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }

            try {
                console.log('Executing code...');
                const bot = this.agent.bot;
                const snap = () => ({ inv: world.getInventoryCounts(bot), pos: bot.entity?.position?.clone?.() });
                let before = null; try { before = snap(); } catch (_) {}
                await executionModule.main(this.agent.bot);

                const code_output = this.agent.actions.getBotOutputSummary();
                // [ai-player] Voyager-style skill library: keep verified code only (deterministic critic)
                try {
                    const lm = this.agent.longMemory;
                    if (lm && before && !this.agent.bot.interrupt_code) {
                        lm.noteSkillUses(result.code_processed || '');
                        const task = LongMemory.taskFromHistory(messages);
                        const v = lm.verify(before, snap(), code_output);
                        console.log(`[ai-player] skill critic: ${v.ok ? 'success' : 'not saved'} (${v.why}) task="${task.slice(0, 80)}"`);
                        if (v.ok && task) await lm.saveSkill(task, result.code_processed, v.why);
                    }
                } catch (e) { console.warn('[ai-player] skill save skipped:', e.message); }
                const summary = "Agent wrote this code: \n```" + this._sanitizeCode(code) + "```\nCode Output:\n" + code_output;
                return summary;
            } catch (e) {
                if (this.agent.bot.interrupt_code)
                    return null;
                console.warn('Generated code threw error: ' + e.toString());
                console.warn('trying again...');

                const code_output = this.agent.actions.getBotOutputSummary();

                messages.push({ role: 'assistant', content: res });
                messages.push({
                    role: 'system',
                    content: `Code Output:\n${code_output}\nCODE EXECUTION THREW ERROR: ${e.toString()}\n Please try again:`
                });
            }
        }
        return `Code generation failed after ${MAX_ATTEMPTS} attempts.`;
    }
    
    async _lintCode(code) {
        let result = '#### CODE ERROR INFO ###\n';
        const codeNoComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const skillRegex = /((?:skills|world)\.(.*?))\(/g;
        const usedSkills = [];
        let match;
        while ((match = skillRegex.exec(codeNoComments)) !== null) {
            usedSkills.push(match[1]);
        }
        const allDocs = await this.agent.prompter.skill_libary.getAllSkillDocs();
        const knownSkills = new Set(allDocs.map(doc => doc.split('\n')[0]));
        const missingSkills = usedSkills.filter(skill => !knownSkills.has(skill));
        if (missingSkills.length > 0) {
            result += 'These functions do not exist:\n';
            result += missingSkills.join('\n');
            console.log(result);
            return result;
        }

        const eslint = new ESLint();
        const results = await eslint.lintText(code);
        const codeLines = code.split('\n');
        const exceptions = results.map(r => r.messages).flat();

        if (exceptions.length > 0) {
            exceptions.forEach((exc, index) => {
                if (exc.line && exc.column ) {
                    const errorLine = codeLines[exc.line - 1]?.trim() || 'Unable to retrieve error line content';
                    result += `#ERROR ${index + 1}\n`;
                    result += `Message: ${exc.message}\n`;
                    result += `Location: Line ${exc.line}, Column ${exc.column}\n`;
                    result += `Related Code Line: ${errorLine}\n`;
                }
            });
            result += 'The code contains exceptions and cannot continue execution.';
        } else {
            return null;
        }

        return result;
    }

    async _stageCode(code) {
        await this._ensureReady();
        code = this._sanitizeCode(code);
        let src = '';
        code = code.replaceAll('console.log(', 'log(bot,');
        code = code.replaceAll('log("', 'log(bot,"');

        console.log(`Generated code: """${code}"""`);

        code = code.replaceAll(';\n', '; if(bot.interrupt_code) {log(bot, "Code interrupted.");return;}\n');
        for (let line of code.split('\n')) {
            src += `    ${line}\n`;
        }
        const code_processed = code;
        let src_lint_copy = this.code_lint_template.replace('/* CODE HERE */', src).replace('const log = skills.log;', 'const log = skills.log;\nconst learned = {};');
        src = this.code_template.replace('/* CODE HERE */', src);

        let filename = this.file_counter + '.js';
        this.file_counter++;
        
        let write_result = await this._writeFilePromise('.' + this.fp + filename, src);
        const base_endowments = { skills, log: skills.log, world, Vec3 };
        let learned = {};
        try { if (this.agent.longMemory) learned = this.agent.longMemory.compileLearned(makeCompartment, base_endowments); } catch (e) { console.warn('[ai-player] learned skills unavailable:', e.message); }
        const compartment = makeCompartment({
            ...base_endowments,
            learned,
        });
        const mainFn = compartment.evaluate(src);
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy, code_processed };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js'];
        for (let r of remove_strs) {
            if (code.startsWith(r)) {
                code = code.slice(r.length);
                return code;
            }
        }
        return code;
    }

    _writeFilePromise(filename, src) {
        return new Promise((resolve, reject) => {
            writeFile(filename, src, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}

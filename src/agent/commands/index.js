import { getBlockId, getItemId } from "../../utils/mcdata.js";
import { criticalSurvivalGuard } from '../library/bob_survival_gate.js';
import { actionsList } from './actions.js';
import { queryList } from './queries.js';
import { correctName } from '../library/long_memory.js';
import { runCommandPerform } from '../library/bob_brain_v2.js';

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList);
const commandMap = {};
for (let command of commandList) {
    commandMap[command.name] = command;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        delete commandMap[command_name];
        delete commandList.find(command => command.name === command_name);
    }
}

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;

export function containsCommand(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch)
        return "!" + commandMatch[1];
    return null;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error('Unknown endpoint type:', endpointType)
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (!commandMatch) return `Command is incorrectly formatted`;

    const commandName = "!"+commandMatch[1];

    let args;
    if (commandMatch[2]) args = commandMatch[2].match(argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    const params = commandParams(command);
    const paramNames = commandParamNames(command);
    
    if (args.length !== params.length)
        return `Command ${command.name} was given ${args.length} args, but requires ${params.length} args.`;

    
    for (let i = 0; i < args.length; i++) {
        const param = params[i];
        //Remove any extra characters
        let arg = args[i].trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            arg = arg.substring(1, arg.length-1);
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if(arg === null || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    return `Error: Param '${paramNames[i]}' must be an element of ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
                    //Alternatively arg could be set to the nearest value in the domain.
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) return  `Invalid block type: ${arg}.`
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) return `Invalid item type: ${arg}.`
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) return  `Invalid block or item type: ${arg}.`
        }
        args[i] = arg;
    }
    
    return { commandName, args };
}

export function truncCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch) {
        return message.substring(0, commandMatch.index + commandMatch[0].length);
    }
    return message;
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function numParams(command) {
    return commandParams(command).length;
}

// [ai-player] stuck-guard (set by the unstuck escalation in modes.js): don't let the model repeat a command near the spot
// it just got stuck at. collect-guard: when self-prompting and Bob already has 16+ of what a !collectBlocks would give
// (Oct 20: !collectBlocks("coal_ore") over and over with 37 coal), answer with a short note instead of running it.
const commandKey = (parsed) => `${parsed.commandName}(${(parsed.args || []).map(a => JSON.stringify(a)).join(',')})`;
function aiPlayerGuard(agent, parsed) {
    try {
        const key = commandKey(parsed);
        const safety = criticalSurvivalGuard(agent.bot, parsed.commandName, !!agent.self_prompter?._selfPromptIteration);
        if (safety && isAction(parsed.commandName)) {
            console.log('[ai-player] survival-guard: blocked ' + key);
            return safety;
        }
        const g = agent.stuck_guard, me = agent.bot?.entity?.position;
        if (g && Date.now() < g.until && me && g.cmds.includes(key) && me.distanceTo(g.pos) < 32) {
            const mins = Math.max(1, Math.ceil((g.until - Date.now()) / 60e3));
            console.log(`[ai-player] stuck-guard: blocked ${key} (stuck at ${g.pos} recently)`);
            return `${key} is blocked for about ${mins} more min: you got stuck doing it at ${g.pos.x} ${g.pos.y} ${g.pos.z}. Pick a different task or place.`;
        }
        // [ai-player] item 5: the same action failed twice here in the last 15 min -> refuse it with the reason
        if (!/^!(stop|stfu|stay|goToBed|endGoal|restart|clearChat)$/.test(parsed.commandName)) {
            const f = agent.failures?.blocking(parsed.commandName, parsed.args?.[0] ?? '', me);
            if (f && isAction(parsed.commandName)) {
                console.log(`[ai-player] failure-guard: blocked ${key} (failed x${f.count} near ${f.x} ${f.y} ${f.z}: ${f.error})`);
                return `${key} failed ${f.count} times near ${f.x} ${f.y} ${f.z} recently (${f.error}). Do not repeat it here: choose a different task, target or place.`;
            }
        }
        agent.last_command_key = key;
        if (parsed.commandName === '!collectBlocks' && agent.self_prompter?.isActive?.()) {
            const type = String(parsed.args?.[0] || '');
            const base = type.replace(/^deepslate_/, '').replace(/_ore$/, '');
            const names = [...new Set([type, base, `raw_${base}`, ...(type === 'stone' ? ['cobblestone'] : []), ...(base === 'lapis' ? ['lapis_lazuli'] : [])])];
            const counts = {};
            for (const i of agent.bot.inventory.items()) counts[i.name] = (counts[i.name] || 0) + i.count;
            const item = names.sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0];
            if ((counts[item] || 0) >= 16) {
                console.log(`[ai-player] collect-guard: skipped ${key}, already have ${counts[item]} ${item}`);
                return `You already have ${counts[item]} ${item}, which is plenty; no need to collect ${type} now. Use it or do something else (food, crafting, farming).`;
            }
        }
    } catch (e) { console.warn(`[ai-player] command guard failed: ${e.message}`); }
    return null;
}

export async function executeCommand(agent, message) {
    let parsed = parseCommandMessage(message);
    // [ai-player] fix common name mistakes ('log' -> nearest log type, 'iron_ore' smelt -> raw_iron, plurals)
    let name_note = '';
    try {
        const bad = typeof parsed === 'string' && parsed.match(/^Invalid (block|item|block or item) type: (\w+)\.?$/);
        if (bad) {
            const fixed = correctName(agent, containsCommand(message), bad[2], bad[1] === 'block' ? 'block' : bad[1] === 'item' ? 'item' : 'any');
            if (fixed && fixed !== bad[2]) {
                const reparsed = parseCommandMessage(message.replace(new RegExp(`(["']?)\\b${bad[2]}\\b\\1`), `"${fixed}"`));
                if (typeof reparsed !== 'string') { parsed = reparsed; name_note = `(Note: "${bad[2]}" is not a valid name; used "${fixed}".) `; }
            }
        } else if (typeof parsed !== 'string' && parsed.commandName === '!smeltItem' && /_ore$/.test(parsed.args?.[0] || '')) {
            const fixed = correctName(agent, '!smeltItem', parsed.args[0], 'item');
            if (fixed && fixed !== parsed.args[0]) { name_note = `(Note: smelt raw items, not ore blocks; used "${fixed}" instead of "${parsed.args[0]}".) `; parsed.args[0] = fixed; }
        }
        if (name_note) console.log(`[ai-player] name-fix: ${name_note}`);
    } catch (e) { console.warn(`[ai-player] name-fix failed: ${e.message}`); }
    if (name_note && typeof parsed !== 'string') {
        const blocked = aiPlayerGuard(agent, parsed);
        if (blocked) return name_note + blocked;
        const res = await executeCommand._run(agent, parsed);
        return name_note + (res ?? '');
    }
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);
        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        if (numArgs !== numParams(command))
            return `Command ${command.name} was given ${numArgs} args, but requires ${numParams(command)} args.`;
        else {
            const blocked = aiPlayerGuard(agent, parsed);
            if (blocked) return blocked;
            return await performParsed(agent, parsed);
        }
    }
}

function performParsed(agent, parsed) {
    const command = getCommand(parsed.commandName);
    return runCommandPerform(
        agent,
        { commandName: parsed.commandName, action: isAction(parsed.commandName) },
        () => command.perform(agent, ...parsed.args)
    );
}

executeCommand._run = async (agent, parsed) => {
    const command = getCommand(parsed.commandName);
    const numArgs = parsed.args ? parsed.args.length : 0;
    if (numArgs !== numParams(command))
        return `Command ${command.name} was given ${numArgs} args, but requires ${numParams(command)} args.`;
    return await performParsed(agent, parsed);
};

export function getCommandDocs(agent) {
    const typeTranslations = {
        //This was added to keep the prompt the same as before type checks were implemented.
        //If the language model is giving invalid inputs changing this might help.
        'float':             'number',
        'int':               'number',
        'BlockName':         'string',
        'ItemName':          'string',
        'BlockOrItemName':   'string',
        'boolean':           'bool'
    }
    let docs = `\n*COMMAND DOCS\n You can use the following commands to perform actions and get information about the world. 
    Use the commands with the syntax: !commandName or !commandName("arg1", 1.2, ...) if the command takes arguments.\n
    Do not use codeblocks. Use double quotes for strings. Only use one command in each response, trailing commands and comments will be ignored.\n`;
    for (let command of commandList) {
        if (agent.blocked_actions.includes(command.name)) {
            continue;
        }
        docs += command.name + ': ' + command.description + '\n';
        if (command.params) {
            docs += 'Params:\n';
            for (let param in command.params) {
                docs += `${param}: (${typeTranslations[command.params[param].type]??command.params[param].type}) ${command.params[param].description}\n`;
            }
        }
    }
    return docs + '*\n';
}

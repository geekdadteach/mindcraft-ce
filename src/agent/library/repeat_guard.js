// [ai-player] Repeat-command guard for model-issued commands.
// Blocks a command when the same command with the same (or, for coordinates, nearly the same) arguments
// already ran twice in the last 2 minutes, and blocks !stop right after a !stop. The model gets a short
// system note instead, so it picks something else. Player-forced commands are not checked.
import { parseCommandMessage } from '../commands/index.js';

const WINDOW_MS = 2 * 60 * 1000;
const MAX_SIMILAR = 2;        // the 3rd similar command within the window is blocked
const NEAR_BLOCKS = 3;        // coordinate targets within 3 blocks count as the same
export const REPEAT_NOTE = 'You already did that; pick a different task such as getting food or gathering resources.';

function coordsOf(args) {
    if (!Array.isArray(args) || args.length < 3) return null;
    const [x, y, z] = args;
    return [x, y, z].every(v => typeof v === 'number' && Number.isFinite(v)) ? [x, y, z] : null;
}

function similar(a, b) {
    if (a.name !== b.name) return false;
    const ca = coordsOf(a.args), cb = coordsOf(b.args);
    if (ca && cb) {
        const d = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
        return d <= NEAR_BLOCKS;
    }
    return JSON.stringify(a.args || []) === JSON.stringify(b.args || []);
}

export class RepeatGuard {
    constructor() {
        this.recent = [];   // { name, args, t } of executed model commands
    }

    // Returns null when the command may run, otherwise the note to give the model.
    check(message, now = Date.now()) {
        let parsed = null;
        try { parsed = parseCommandMessage(message); } catch (e) { return null; }
        if (!parsed || typeof parsed === 'string') return null;   // malformed: let executeCommand report it
        const cmd = { name: parsed.commandName, args: parsed.args || [], t: now };
        this.recent = this.recent.filter(c => now - c.t < WINDOW_MS);
        const last = this.recent[this.recent.length - 1];
        let reason = null;
        if (cmd.name === '!stop' && last && last.name === '!stop') {
            reason = '!stop twice in a row';
        } else {
            const n = this.recent.filter(c => similar(c, cmd)).length;
            if (n >= MAX_SIMILAR) reason = `${n + 1}x within 2 min`;
        }
        if (reason) {
            console.log(`[ai-player] repeat-guard: blocked ${cmd.name}(${cmd.args.join(', ')}) (${reason})`);
            return REPEAT_NOTE;
        }
        this.recent.push(cmd);
        return null;
    }
}

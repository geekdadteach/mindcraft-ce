// [ai-player] stuck-home-20261026: outgoing chat may never be a server command.
// Andy's replies reach bot.chat() (agent.openChat) and mineflayer turns any chat line, or any 256-char chunk of
// a long line, that starts with '/' into a chat_command packet. This guard sits on bot._client.chat (below the
// splitter) and on bot.chat, and drops every outgoing line that starts with '/'. The ONLY command that can
// still be sent is the fixed '/home house' string, and only through sendFixedHomeCommand() (code, never the LLM).
// Side effects: mindcraft's login '/skin clear' and bot.whisper() ('/tell ...') are dropped too (both unused here).
export const HOME_CMD = '/home house';
const raws = new WeakMap();

export function isSlashCommand(msg) {
    return /^[\s\u00a0\u200b-\u200f\u2060\ufeff]*\//.test(String(msg ?? ''));
}
// LLM text -> safe chat text (leading slashes/blank removed)
export function stripCommandPrefix(msg) {
    let s = String(msg ?? '');
    while (isSlashCommand(s)) s = s.replace(/^[\s\u00a0\u200b-\u200f\u2060\ufeff]*\/+/, '');
    return s.trim();
}

export function installChatGuard(bot, log = (m) => console.log(`[ai-player] ${m}`)) {
    if (!bot || raws.has(bot)) return raws.has(bot);
    const client = bot._client;
    if (!client || typeof client.chat !== 'function') return false;
    const rawClientChat = client.chat.bind(client);
    raws.set(bot, rawClientChat);
    client.chat = (message, ...rest) => {
        if (isSlashCommand(message)) { log(`chat-guard: blocked outgoing command line: ${String(message).slice(0, 80)}`); return; }
        return rawClientChat(message, ...rest);
    };
    if (typeof bot.chat === 'function') {
        const rawBotChat = bot.chat.bind(bot);
        bot.chat = (message) => {
            if (isSlashCommand(message)) { log(`chat-guard: blocked outgoing command: ${String(message).slice(0, 80)}`); return; }
            return rawBotChat(message);
        };
    }
    log('chat-guard: armed (outgoing lines starting with "/" are dropped; only the fixed stuck-home command is allowed)');
    return true;
}
export function chatGuardArmed(bot) { return raws.has(bot); }

// The one command code may send. No arguments: the string is fixed.
export function sendFixedHomeCommand(bot) {
    const raw = raws.get(bot);
    if (!raw) throw new Error('chat guard not installed');
    raw(HOME_CMD);
    return HOME_CMD;
}

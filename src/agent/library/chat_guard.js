// [ai-player] stuck-home-20261026: outgoing chat may never be a server command.
// Andy's replies reach bot.chat() (agent.openChat) and mineflayer turns any chat line, or any 256-char chunk of
// a long line, that starts with '/' into a chat_command packet. This guard sits on bot._client.chat (below the
// splitter) and on bot.chat, and drops every outgoing line that starts with '/'. The ONLY commands that can
// still be sent are the fixed '/home house', '/sethome house', and '/claimslist' strings, and only through
// sendFixedHomeCommand() / sendFixedSetHomeCommand() / sendFixedClaimsListCommand() (code, never the LLM).
// /claimslist is for the GriefPrevention helper only.
// Side effects: mindcraft's login '/skin clear' and bot.whisper() ('/tell ...') are dropped too (both unused here).
export const HOME_CMD = '/home house';
export const SET_HOME_CMD = '/sethome house';
export const CLAIMS_LIST_CMD = '/claimslist';
const ALLOWED_CMDS = new Set([HOME_CMD, SET_HOME_CMD, CLAIMS_LIST_CMD]);
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
    log('chat-guard: armed (outgoing lines starting with "/" are dropped; only the fixed /home house, /sethome house, and /claimslist commands are allowed)');
    return true;
}
export function chatGuardArmed(bot) { return raws.has(bot); }

function sendFixedCommand(bot, cmd) {
    const raw = raws.get(bot);
    if (!raw) throw new Error('chat guard not installed');
    if (!ALLOWED_CMDS.has(cmd)) throw new Error('command not on the chat-guard allowlist');
    raw(cmd);
    return cmd;
}

// The only commands code may send. No arguments: the strings are fixed.
export function sendFixedHomeCommand(bot) { return sendFixedCommand(bot, HOME_CMD); }
export function sendFixedSetHomeCommand(bot) { return sendFixedCommand(bot, SET_HOME_CMD); }
export function sendFixedClaimsListCommand(bot) { return sendFixedCommand(bot, CLAIMS_LIST_CMD); }

// Essentials typically replies "Home set." / "Home house set to current location." Treat no reply
// or an error as not set. Do not round-trip /home house: that can still teleport to the hilltop.
export const SET_HOME_OK_RE = /\bhome set\b|\bset(?:ting)? (?:your )?home\b|\bhomeset\b/i;
export const SET_HOME_FAIL_RE = /permission|unknown (or incomplete )?command|cannot set|not allowed|error|cooldown|max(imum)? (number of )?homes|cancelled|denied/i;

// Player chat must never confirm /sethome or fake a /claimslist line.
// Strict: system lines (GP `world: x…`, claim-block headers, Essentials "Home set.") have no
// sender. Do not treat every `word: text` line as chat — that is how GP prints claims.
const MC_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function knownPlayerNames(bot) {
    const names = new Set();
    const players = bot?.players;
    if (players && typeof players === 'object') {
        for (const [key, p] of Object.entries(players)) {
            if (key) names.add(String(key));
            const username = p?.username || p?.name;
            if (username) names.add(String(username));
        }
    }
    if (bot?.username) names.add(String(bot.username));
    return names;
}

function isKnownPlayerName(name, bot) {
    if (!MC_NAME_RE.test(name)) return false;
    const lower = name.toLowerCase();
    for (const n of knownPlayerNames(bot)) {
        if (String(n).toLowerCase() === lower) return true;
    }
    return false;
}

export function isPlayerChatLine(message, position, jsonMsg, sender, bot) {
    if (sender != null && String(sender).length > 0) return true;
    if (position === 'chat') return true;
    const s = String(message || '').trim();
    if (!s) return false;
    // Vanilla `<Name> message`. GP / Essentials system lines do not use this.
    if (/^<[A-Za-z0-9_]{3,16}>\s/.test(s) || /^<[^>\n]+>\s/.test(s)) return true;
    // LuckPerms / similar: `[Member] Steve: …` — never a GP claimslist line.
    if (/^\[[^\]]+\]\s+[A-Za-z0-9_]{3,16}:\s/.test(s)) return true;
    // `Name: message` only when Name is an online/known player. "world: x-1208…" is GP, not Steve.
    const named = /^([A-Za-z0-9_]{3,16}):\s/.exec(s);
    if (named && named[1].toLowerCase() !== 'world' && isKnownPlayerName(named[1], bot)) return true;
    return false;
}

export async function confirmSetHome(bot, {
    send = sendFixedSetHomeCommand,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs = 4000,
    now = Date.now,
} = {}) {
    const lines = [];
    const onMsg = (message, position, jsonMsg, sender) => {
        if (isPlayerChatLine(message, position, jsonMsg, sender, bot)) return;
        const s = String(message || '');
        if (s) lines.push(s);
    };
    bot?.on?.('messagestr', onMsg);
    try {
        send(bot);
        const started = now();
        while (now() - started < timeoutMs) {
            await wait(100);
            const text = lines.join('\n');
            if (SET_HOME_FAIL_RE.test(text)) return { ok: false, why: 'server error', lines };
            if (SET_HOME_OK_RE.test(text)) return { ok: true, why: 'server confirmed', lines };
        }
        return { ok: false, why: 'no reply', lines };
    } finally {
        try { bot?.removeListener?.('messagestr', onMsg); } catch (_) {}
    }
}

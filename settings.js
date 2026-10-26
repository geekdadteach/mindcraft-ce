// [ai-player] Bob mode switch (2026-10-21). Mode comes from $BOB_MODE if set, else from the persistent file
// /home/dad/ai-player/run/bob-mode.env (BOB_MODE=lite|normal, written by ~/ai-player/bin/bob-mode.sh). Anything other
// than "lite" (missing file, typo) = normal = the setup below, unchanged.
// LITE: profile ./profiles/andy-api-lite.json (thinking: Andy-4.2 on LM Studio 192.168.1.144 (Wi-Fi, default since
// 2026-10-25), then .143 (same Mac, Ethernet) if .144 does not connect, then Andy API fallback; embeddings: LM Studio
// .144 -> .143, word-overlap if both
// fail), no vision. Coding is allowed in BOTH modes (2026-10-26): LITE no longer sets allow_insecure_coding=false
// or blocks "!newAction"; code goes to the profile's code_model (chat model if the profile has none).
// Lite uses only LM Studio (:1234) on the living-room Mac, never its Ollama (:11434).
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { bobRuntimePath } from './src/utils/bob_runtime_paths.js';
const BOB_MODE_FILE = process.env.BOB_MODE_FILE || bobRuntimePath('run', 'bob-mode.env');
function readBobMode() {
    let m = process.env.BOB_MODE;
    if (!m) {
        try {
            const r = readFileSync(BOB_MODE_FILE, 'utf8').match(/^\s*BOB_MODE\s*=\s*["']?([A-Za-z]+)/m);
            if (r) m = r[1];
        } catch (e) { /* no file: normal */ }
    }
    return String(m || 'normal').trim().toLowerCase() === 'lite' ? 'lite' : 'normal';
}
export const bob_mode = readBobMode();

const settings = {
    "minecraft_version": "1.21.6", // or specific version like "1.21.6"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 25599, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8081, // [ai-player] moved from 8080 for UniFi 2026-10-19
    "auto_open_ui": false, // opens UI in browser on startup
    
    "base_profile": "survival", // survival, assistant, creative, or god_mode
    "profiles": [
        "./profiles/andy-api.json", // [ai-player] Andy API trial (andy/auto)
        // "./andy.json", // cloud andy/auto - not used
        // "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.json", // Supports up to 75 messages!

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": true, // load memory from previous session
    "init_message": "", // [ai-player] empty: no greeting/spam on join (family server)
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": true, // [ai-player] approved by Randy 2026-10-19 15:47; // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": true, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": 10, // [ai-player] was -1; // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 3, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 12, // [ai-player] was 8 for the 8K LM Studio context; 16K since 10:42 Oct 20 (upstream default 15, kept lower for latency)
    "num_examples": 1, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": false, // [ai-player] off: avoid auto chat spam on family server
    "chat_bot_messages": false, // publicly chat messages to other bots

    "spawn_timeout": 60, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.
  
    "log_all_prompts": false, // log ALL prompts to file

}

// [ai-player] apply Bob mode (see top of file)
settings.bob_mode = bob_mode;
if (bob_mode === 'lite') {
    settings.profiles = ["./profiles/andy-api-lite.json"];
    // [ai-player] 2026-10-26: coding stays on in LITE (no allow_insecure_coding=false, no "!newAction" block).
    settings.allow_vision = false;
}
// Only the real Bob process (node main.js) logs the mode and records it for bob-mode.sh status.
if (/(^|[\/\\])main\.js$/.test(process.argv[1] || '')) {
    console.log(`[ai-player] Bob mode: ${bob_mode} profiles=${JSON.stringify(settings.profiles)} allow_insecure_coding=${settings.allow_insecure_coding} allow_vision=${settings.allow_vision} blocked_actions=${JSON.stringify(settings.blocked_actions)}`);
    try {
        const f = process.env.BOB_MODE_ACTIVE_FILE || bobRuntimePath('run', 'bob-mode.active');
        writeFileSync(f + '.tmp', JSON.stringify({ mode: bob_mode, pid: process.pid, started: new Date().toISOString(), profiles: settings.profiles }) + '\n');
        renameSync(f + '.tmp', f);
    } catch (e) { console.warn('[ai-player] could not write bob-mode.active:', e?.message || e); }
}

export default settings;

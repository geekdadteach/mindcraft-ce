import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { createControlRelay, loadControlSecret } from './bobbot_control.js';
import { readFileSync, watchFile, unwatchFile, openSync, readSync, closeSync, fstatSync } from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

// Initialize the server


// [ai-player] READ-ONLY live agent log panel (tails mindcraft.log; no command execution)
const AGENT_LOG_PATH = '/home/dad/ai-player/logs/mindcraft.log';
const AGENT_LOG_MAX = 500;
const agentLogBuffer = [];
let agentLogWatchStarted = false;
let agentLogFd = -1;
let agentLogOffset = 0;

function agentLogIsSensitive(line) {
    const l = String(line).toLowerCase();
    // Never show secrets or auth material in the read-only UI log
    if (l.includes('token') || l.includes('access') || l.includes('saves.json')) return true;
    if (l.includes('authorization') || l.includes('bearer')) return true;
    // generic API key material
    if (l.includes('api_key') || l.includes('apikey') || (l.includes('key') && (l.includes('andy') || l.includes('bearer') || l.includes('auth')))) return true;
    if (l.includes('"key"') || l.includes("'key'") || l.includes(' api key') || l.includes('apikey=')) return true;
    // bare word key as field assignment
    if (/(^|[^a-z])key([^a-z]|$)/i.test(String(line)) && /(andy|bearer|auth|api|secret|password)/i.test(String(line))) return true;
    return false;
}

function agentLogPush(line) {
    const cleaned = String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
    if (!cleaned.trim()) return;
    if (agentLogIsSensitive(cleaned)) return;
    agentLogBuffer.push(cleaned);
    while (agentLogBuffer.length > AGENT_LOG_MAX) agentLogBuffer.shift();
    if (io) io.emit('agent-log', cleaned);
}

function agentLogReadNew() {
    try {
        if (agentLogFd < 0) {
            try { agentLogFd = openSync(AGENT_LOG_PATH, 'r'); } catch { return; }
            // Start near end so we don't dump megabytes on first connect; keep last ~64KB
            const st = fstatSync(agentLogFd);
            agentLogOffset = Math.max(0, st.size - 65536);
        }
        const st = fstatSync(agentLogFd);
        if (st.size < agentLogOffset) {
            // truncated/rotated
            agentLogOffset = 0;
        }
        if (st.size === agentLogOffset) return;
        const len = st.size - agentLogOffset;
        const buf = Buffer.alloc(len);
        readSync(agentLogFd, buf, 0, len, agentLogOffset);
        agentLogOffset = st.size;
        const text = buf.toString('utf8');
        const parts = text.split('\n');
        // If file didn't end with newline, last part is incomplete — keep for next read by rewinding
        // Simple approach: only emit complete lines; if no trailing newline, put last chunk back
        let lines = parts;
        if (!text.endsWith('\n') && parts.length) {
            const incomplete = parts.pop();
            agentLogOffset -= Buffer.byteLength(incomplete, 'utf8');
            lines = parts;
        }
        for (const line of lines) agentLogPush(line);
    } catch (e) {
        // ignore transient read errors
    }
}

function startAgentLogWatch() {
    if (agentLogWatchStarted) return;
    agentLogWatchStarted = true;
    // Seed buffer once
    agentLogReadNew();
    watchFile(AGENT_LOG_PATH, { interval: 1000 }, () => agentLogReadNew());
}

export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);
    // No BobBot control is possible without a configured private secret.
    // Existing web/agent Socket.IO events are unchanged for compatibility.
    const bobbotControl = createControlRelay(agent_connections, {
        secret: loadControlSecret(),
    });

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        bobbotControl.attachClient(socket);
        bobbotControl.attachAgent(socket);
        console.log('Client connected');

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in settings_spec)) {
                    delete settings[key];
                }
            }
            if (settings.profile?.name) {
                if (settings.profile.name in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                curAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', () => {
            if (agent_connections[curAgentName]) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            if (!agent_connections[agentName].socket) { console.warn(`[ai-player] chat-message: ${agentName} socket null (restarting?)`); return; }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            agent_connections[agentName].socket.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName, settings) => {
            const agent = agent_connections[agentName];
            if (agent) {
                agent.setSettings(settings);
                if (agent.socket) agent.socket.emit('restart-agent');
                else console.warn(`[ai-player] set-agent-settings: ${agentName} socket null (restarting?)`);
            }
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            const conn = agent_connections[agentName];
            if (!conn || !conn.socket) { console.warn(`[ai-player] restart-agent: ${agentName} not connected`); return; }
            conn.socket.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentName, data) => {
			if (!agent_connections[agentName] || !agent_connections[agentName].socket) {
				console.warn(`[ai-player] Agent ${agentName} not connected (offline/restarting), dropping send-message.`);
				return
			}
			try {
				agent_connections[agentName].socket.emit('send-message', data)
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });

        // [ai-player] read-only log panel: send buffer then stream new lines
        socket.on('subscribe-agent-log', () => {
            startAgentLogWatch();
            socket.emit('agent-log-history', agentLogBuffer.slice());
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    // [ai-player] Loopback only by default. For LAN access for Randy (ufw allows 8081, settings.mindserver_port),
    // set MINDCRAFT_BIND_HOST=0.0.0.0 in the systemd unit/env.
    const host = process.env.MINDCRAFT_BIND_HOST || "127.0.0.1";
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
        startAgentLogWatch();
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName, 
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
function addListener(listener_socket) {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            const states = {};
            for (let agentName in agent_connections) {
                let agent = agent_connections[agentName];
                if (agent.in_game) {
                    try {
                        const state = await new Promise((resolve) => {
                            agent.socket.emit('get-full-state', (s) => resolve(s));
                        });
                        states[agentName] = state;
                    } catch (e) {
                        states[agentName] = { error: String(e) };
                    }
                }
            }
            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;
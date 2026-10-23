// Optional, authenticated BobBot control endpoint. Legacy web UI is untouched.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

const ALLOWED_COMMANDS = new Set([
    '!stop', '!stay', '!stats', '!inventory',
    '!goToCoordinates', '!goToPlayer', '!followPlayer',
    '!goToRememberedPlace', '!goToBed',
    '!goal', '!endGoal', '!getFood', '!collectBlocks',
    '!craftRecipe', '!equip', '!searchForBlock',
]);

export function loadControlSecret(env = process.env) {
    const file = env.MINDCRAFT_BOBBOT_TOKEN_FILE;
    if (!file) return null; // Feature disabled unless explicitly configured.
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('MINDCRAFT_BOBBOT_TOKEN_FILE must be a regular file, not a symlink');
    }
    if ((info.mode & 0o077) !== 0) {
        throw new Error('MINDCRAFT_BOBBOT_TOKEN_FILE must be private (mode 600)');
    }
    const secret = readFileSync(file, 'utf8').trim();
    if (secret.length < 32) {
        throw new Error('MINDCRAFT_BOBBOT_TOKEN_FILE secret must be at least 32 characters');
    }
    return secret;
}

export function isBobbotAuthorized(socket, secret) {
    if (!secret || typeof socket?.handshake?.auth?.bobbot_token !== 'string') return false;
    const supplied = Buffer.from(socket.handshake.auth.bobbot_token, 'utf8');
    const expected = Buffer.from(secret, 'utf8');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function validateControlRequest(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'bad_request';
    if (typeof data.agent !== 'string' || !/^[a-zA-Z0-9_]{3,16}$/.test(data.agent))
        return 'bad_agent';
    if (!['command', 'pause', 'resume', 'stop'].includes(data.action)) return 'bad_action';
    if (data.action === 'command') {
        if (typeof data.command !== 'string' || data.command.length < 2
                || data.command.length > 450 || /[\n\r]/.test(data.command))
            return 'bad_command';
        const name = data.command.match(/^(![a-zA-Z][a-zA-Z0-9]*)/);
        if (!name || !ALLOWED_COMMANDS.has(name[1])) return 'command_not_permitted';
        const suffix = data.command.slice(name[1].length);
        if (suffix !== '' && !(suffix.startsWith('(') && suffix.endsWith(')')))
            return 'bad_command';
        if (suffix.includes('!') || suffix.includes(';')) return 'bad_command';
    }
    return null;
}

export function createControlRelay(agentConnections, { secret }) {
    const pending = new Map();

    function attachClient(socket) {
        socket.on('bobbot-control', (data, ack) => {
            if (typeof ack !== 'function') return;
            if (!isBobbotAuthorized(socket, secret)) {
                ack({ ok: false, status: 'rejected', error: 'not_authorized' });
                return;
            }
            const invalid = validateControlRequest(data);
            if (invalid) {
                ack({ ok: false, status: 'rejected', error: invalid });
                return;
            }
            const agent = agentConnections[data.agent];
            if (!agent?.socket || !agent.in_game) {
                ack({ ok: false, status: 'rejected', error: 'agent_offline' });
                return;
            }
            const id = randomUUID();
            const record = { client: socket, agentSocket: agent.socket };
            const expiry = setTimeout(() => pending.delete(id), 600_000);
            expiry.unref?.();
            pending.set(id, { ...record, expiry });
            agent.socket.timeout(10_000).emit(
                'bobbot-control',
                { id, action: data.action, command: data.command },
                (error, response) => {
                    if (error || !response?.ok) {
                        clearTimeout(expiry);
                        pending.delete(id);
                        ack({
                            ok: false, status: 'rejected',
                            error: error ? 'agent_ack_timeout' : (response?.error || 'agent_rejected'),
                        });
                    } else {
                        ack({ ok: true, status: response.status || 'accepted', id });
                    }
                }
            );
        });
    }

    function attachAgent(socket) {
        socket.on('bobbot-control-result', (result) => {
            if (!result || typeof result.id !== 'string') return;
            const entry = pending.get(result.id);
            if (!entry || entry.agentSocket !== socket) return;
            clearTimeout(entry.expiry);
            pending.delete(result.id);
            entry.client.emit('bobbot-result', {
                id: result.id,
                ok: result.ok === true,
                status: result.ok ? 'completed' : 'failed',
                detail: String(result.detail || '').slice(0, 700),
            });
        });
    }

    return { attachClient, attachAgent, pending };
}

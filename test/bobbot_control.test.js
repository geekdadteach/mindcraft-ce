import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    createControlRelay, isBobbotAuthorized,
    loadControlSecret, validateControlRequest
} from '../src/mindcraft/bobbot_control.js';

class FakeSocket extends EventEmitter {
    constructor(token = null) {
        super();
        this.handshake = { auth: { bobbot_token: token } };
    }
    timeout() { return this; }
}

test('disabled-by-default control and constant-time token gate', () => {
    const socket = new FakeSocket('secret');
    assert.equal(isBobbotAuthorized(socket, null), false);
    assert.equal(isBobbotAuthorized(socket, 'secret'), true);
    assert.equal(isBobbotAuthorized(socket, 'other'), false);
});

test('reject invalid agent/action/commands', () => {
    assert.equal(validateControlRequest(null), 'bad_request');
    assert.equal(validateControlRequest({ agent: 'Bob', action: 'shutdown' }), 'bad_action');
    assert.equal(validateControlRequest({
        agent: 'Bob', action: 'command', command: '!newAction("shell")'
    }), 'command_not_permitted');
    assert.equal(validateControlRequest({
        agent: 'Bob', action: 'command', command: '!goToCoordinates(1, 70, 2, 2)'
    }), null);
    assert.equal(validateControlRequest({ agent: 'Bob', action: 'pause' }), null);
});

test('secret file requires restrictive permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-control-'));
    const secretFile = join(dir, 'secret');
    try {
        writeFileSync(secretFile, 'random-secret-with-minimum-32-bytes');
        chmodSync(secretFile, 0o644);
        assert.throws(() => loadControlSecret({
            MINDCRAFT_BOBBOT_TOKEN_FILE: secretFile
        }), /private/);
        chmodSync(secretFile, 0o600);
        assert.equal(loadControlSecret({
            MINDCRAFT_BOBBOT_TOKEN_FILE: secretFile
        }), 'random-secret-with-minimum-32-bytes');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('authenticated relay receives agent receipt and eventual completion', async () => {
    const client = new FakeSocket('valid-token');
    const agentSocket = new FakeSocket();
    const agents = { Bob: { socket: agentSocket, in_game: true } };
    const relay = createControlRelay(agents, { secret: 'valid-token' });
    relay.attachClient(client);
    relay.attachAgent(agentSocket);
    const outcomes = [];
    client.on('bobbot-result', result => outcomes.push(result));
    agentSocket.on('bobbot-control', (request, ack) => {
        // socket.timeout().emit callbacks receive (error, response).
        ack(null, { ok: true, status: 'accepted' });
        queueMicrotask(() => agentSocket.emit('bobbot-control-result', {
            id: request.id, ok: true, detail: 'Bob paused.'
        }));
    });
    const receipt = await new Promise(resolve => {
        client.emit('bobbot-control', { agent: 'Bob', action: 'pause' }, resolve);
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(receipt.ok, true);
    assert.equal(receipt.status, 'accepted');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].id, receipt.id);
    assert.equal(outcomes[0].status, 'completed');
    assert.equal(relay.pending.size, 0);
});

test('an unauthenticated connection cannot control agent', async () => {
    const socket = new FakeSocket('wrong');
    const relay = createControlRelay(
        { Bob: { in_game: true, socket: new FakeSocket() } },
        { secret: 'correct' }
    );
    relay.attachClient(socket);
    const ack = await new Promise(resolve => {
        socket.emit('bobbot-control', { agent: 'Bob', action: 'stop' }, resolve);
    });
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'not_authorized');
});

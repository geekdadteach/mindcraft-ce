// Internal Mindcraft agent control endpoint: bypasses chat filters deliberately.
// Server only sends these events on authenticated BobBot control requests.
import { executeCommand } from './commands/index.js';

export function attachBobbotAgentControl(socket, getAgent) {
    socket.on('bobbot-control', (request, acknowledge) => {
        if (typeof acknowledge !== 'function') return;
        const id = request?.id;
        const action = request?.action;
        const agent = getAgent();
        if (!agent || typeof id !== 'string' || !['pause', 'resume', 'stop', 'command'].includes(action)) {
            acknowledge({ ok: false, error: 'bad_request' });
            return;
        }
        if (action === 'command' && typeof request.command !== 'string') {
            acknowledge({ ok: false, error: 'bad_command' });
            return;
        }
        // Receipt only. A separate result event reports execution result.
        acknowledge({ ok: true, status: 'accepted' });
        const perform = async () => {
            if (action === 'pause') {
                await agent.self_prompter.pause();
                return 'Autonomous prompting paused; current action stopped.';
            }
            if (action === 'resume') {
                if (!agent.self_prompter.isPaused())
                    throw new Error('Bob is not paused; nothing resumed');
                if (!agent.self_prompter.prompt)
                    throw new Error('No saved goal available to resume');
                agent.self_prompter.start();
                return 'Autonomous prompting resumed.';
            }
            if (action === 'stop') {
                await agent.actions.stop();
                return 'Current action stopped; autonomous prompting may remain active.';
            }
            // Execute native registered commands directly, not as in-game chat.
            const value = await executeCommand(agent, request.command);
            return typeof value === 'string' ? value : 'Command handler returned.';
        };
        Promise.resolve()
            .then(perform)
            .then((detail) => {
                socket.emit('bobbot-control-result', { id, ok: true, detail });
            })
            .catch((error) => {
                socket.emit('bobbot-control-result', {
                    id, ok: false, detail: String(error?.message || error).slice(0, 500),
                });
            });
    });
}

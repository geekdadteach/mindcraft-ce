import settings from '../settings.js';
import prismarineViewer from 'prismarine-viewer';
const mineflayerViewer = prismarineViewer.mineflayer;

// Opt-in only; browser viewer costs CPU and may bind a network port.
// Keep path drawing bounded to prevent long-running bots accumulating points.
export function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view) return;
    try {
        mineflayerViewer(bot, { port: 3000 + count_id, firstPerson: true });
        const points = [];
        const moved = () => {
            const pos = bot.entity?.position;
            if (!pos) return;
            if (points.length && points[points.length - 1].distanceTo(pos) < 2) return;
            points.push(pos.clone());
            if (points.length > 150) points.shift();
            try { if (bot.viewer?.drawLine) bot.viewer.drawLine('recent-path', points); } catch (_) {}
        };
        bot.on('move', moved);
        bot.once('end', () => { bot.removeListener('move', moved); points.length = 0; });
        console.log('[ai-player] viewer: enabled at port ' + (3000 + count_id) + ' with recent-path overlay');
    } catch (error) {
        console.warn('[ai-player] viewer: unavailable: ' + error.message);
    }
}

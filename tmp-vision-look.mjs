// One-off: make MineBobNE run a look command internally via MindServer (no game chat; the
// forced-command reply is suppressed by the chat gate). Usage: node tmp-vision-look.mjs '!lookAtPosition(-820, 124, 566)'
import { io } from 'socket.io-client';
const cmd = process.argv[2];
if (!/^!lookAt(Position|Player)\(/.test(cmd || '')) { console.error('only !lookAtPosition/!lookAtPlayer allowed'); process.exit(2); }
const s = io('http://127.0.0.1:8081');
s.on('connect', () => { s.emit('send-message', 'MineBobNE', { from: 'ai-player-vision-test', message: cmd }); setTimeout(() => { s.close(); process.exit(0); }, 1500); });
setTimeout(() => process.exit(1), 10000);

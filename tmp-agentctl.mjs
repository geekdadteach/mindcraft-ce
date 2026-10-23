import { io } from 'socket.io-client';
const [ev] = process.argv.slice(2);
const s = io('http://127.0.0.1:8081');
s.on('connect', () => { s.emit(ev, 'MineBobNE'); setTimeout(() => { s.close(); process.exit(0); }, 1500); });
setTimeout(() => process.exit(1), 10000);

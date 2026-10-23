import { io } from 'socket.io-client';
const msg = process.argv[2]; const wait = +(process.argv[3]||2500);
const s = io('http://127.0.0.1:8081', { transports: ['websocket'] });
await new Promise((res,rej)=>{ s.on('connect',res); s.on('connect_error',rej); setTimeout(()=>rej(new Error('t')),8000); });
s.on('bot-output', (a,m)=>console.log('BOT_OUT', String(m).slice(0,900)));
s.emit('send-message', 'MineBobNE', { from: 'ADMIN', message: msg });
await new Promise(r=>setTimeout(r,wait));
s.close(); process.exit(0);

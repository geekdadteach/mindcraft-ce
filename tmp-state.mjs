// read-only: listen for one MindServer state-update and print Bob's gameplay state (no commands sent)
import { io } from 'socket.io-client';
const s = io('http://127.0.0.1:8081');
const t = setTimeout(() => { console.log('NO_STATE'); process.exit(1); }, 15000);
s.on('connect', () => s.emit('listen-to-agents'));
s.on('state-update', (states) => {
  const b = states?.MineBobNE; if (!b) return;
  const g = b.gameplay || {}; const inv = b.inventory || {};
  console.log(JSON.stringify({ position: g.position, health: g.health, hunger: g.hunger, timeLabel: g.timeLabel, biome: g.biome,
    action: b.action, nearby: b.nearby, inventory: inv.counts || inv }));
  clearTimeout(t); s.close(); process.exit(0);
});

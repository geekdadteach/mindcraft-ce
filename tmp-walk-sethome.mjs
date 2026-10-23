import minecraftData from 'minecraft-data';
import { createBot } from 'mineflayer';
import { Vec3 } from 'vec3';
import fs from 'fs';

const OUT = '/home/dad/ai-player/tmp/walk-sethome-results.json';
const R = { chat: [], kicks: [], steps: [] };
const log = (s) => { console.log(s); R.steps.push(s); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function wrapTickEnd(bot) {
  const MOVEMENT = new Set(['position', 'position_look', 'look', 'flying']);
  const write = bot._client.write.bind(bot._client);
  let hasTickEnd = null;
  bot._client.write = function (name, data) {
    const result = write(name, data);
    if (MOVEMENT.has(name)) {
      try {
        if (hasTickEnd === null) {
          const md = minecraftData(bot._client.version || bot.version);
          hasTickEnd = !!(md?.protocol?.play?.toServer?.types?.packet_tick_end);
        }
        if (hasTickEnd) write('tick_end', {});
      } catch { hasTickEnd = false; }
    }
    return result;
  };
}
function pos(bot) {
  const p = bot.entity.position;
  return { x:+p.x.toFixed(2), y:+p.y.toFixed(2), z:+p.z.toFixed(2) };
}
function below(bot) {
  const p = bot.entity.position;
  const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y)-1, Math.floor(p.z)));
  return b?.name || 'null';
}
function distMarket(bot) {
  const p = bot.entity.position;
  return Math.hypot(p.x - (-572), p.z - 480);
}

async function walkWest(bot, minDistFromMarket, timeoutMs=180000) {
  const t0 = Date.now();
  // face -X (west): yaw = pi/2 in MC? atan2(-dx,-dz): dx=-1,dz=0 => atan2(1,0)=pi/2
  await bot.look(Math.PI/2, 0, true);
  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);
  while (Date.now() - t0 < timeoutMs) {
    await sleep(300);
    if (!bot.entity) break;
    const d = distMarket(bot);
    if (d >= minDistFromMarket) break;
    // occasional jump
    if ((Date.now()-t0) % 4000 < 350) {
      bot.setControlState('jump', true);
      await sleep(200);
      bot.setControlState('jump', false);
    }
    // re-look west
    if ((Date.now()-t0) % 8000 < 350) await bot.look(Math.PI/2, 0, true);
  }
  bot.clearControlStates();
  log(`after_walk ${JSON.stringify(pos(bot))} below=${below(bot)} dist_market=${distMarket(bot).toFixed(1)}`);
}

const bot = createBot({
  host:'127.0.0.1', port:25599, username:'MineBobNE',
  auth:'offline', version:'1.21.6', hideErrors:false, checkTimeoutInterval:60000,
});
wrapTickEnd(bot);
bot.on('kicked', r => { R.kicks.push(typeof r==='string'?r:JSON.stringify(r)); log('KICKED '+R.kicks.at(-1)); });
bot.on('message', m => { try { const t=m.toString(); R.chat.push(t); log('CHAT: '+t); } catch {} });
bot.on('error', e => { if (!/PartialRead|Unexpected buffer/i.test(String(e))) log('ERR '+e); });

await new Promise((res,rej) => {
  const t=setTimeout(()=>rej(new Error('spawn timeout')),90000);
  bot.once('spawn',()=>{clearTimeout(t);res();});
  bot.once('kicked',r=>{clearTimeout(t);rej(new Error('kicked '+JSON.stringify(r)));});
});
await sleep(3000);
log('spawn '+JSON.stringify(pos(bot))+' below='+below(bot)+' dist_market='+distMarket(bot).toFixed(1));

await walkWest(bot, 160, 200000);

R.pre_sethome = { ...pos(bot), below: below(bot), dist_market: +distMarket(bot).toFixed(1) };
const far = distMarket(bot) >= 150;
R.far_enough = far;

if (far) {
  let n = R.chat.length;
  bot.chat('/sethome test');
  log('CMD /sethome test');
  await sleep(4000);
  R.sethome_replies = R.chat.slice(n);
  await sleep(18000);
  // walk ~10 blocks south
  await bot.look(0, 0, true); // south-ish
  bot.setControlState('forward', true);
  const s0 = bot.entity.position.clone();
  for (let i=0;i<40;i++) {
    await sleep(250);
    if (bot.entity.position.distanceTo(s0) >= 10) break;
  }
  bot.clearControlStates();
  log('walked10 '+JSON.stringify(pos(bot)));
  n = R.chat.length;
  bot.chat('/home test');
  log('CMD /home test');
  await sleep(6000);
  R.home_replies = R.chat.slice(n);
  R.after_home = { ...pos(bot), below: below(bot) };
  n = R.chat.length;
  bot.chat('/delhome test');
  log('CMD /delhome test');
  await sleep(3500);
  R.delhome_replies = R.chat.slice(n);
} else {
  R.sethome_skipped = 'not far enough from market/admin claims';
}

R.final = { ...pos(bot), below: below(bot), dist_market: +distMarket(bot).toFixed(1) };
fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
log('DONE');
bot.quit();
process.exit(0);

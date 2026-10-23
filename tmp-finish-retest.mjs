import minecraftData from 'minecraft-data';
import { createBot } from 'mineflayer';
import { Vec3 } from 'vec3';
import fs from 'fs';

const OUT = '/home/dad/ai-player/tmp/home-retest-finish.txt';
const R = { started: new Date().toISOString(), chat: [], kicks: [], rubber: 0, steps: [] };
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

const bot = createBot({
  host:'127.0.0.1', port:25599, username:'MineBobNE',
  auth:'offline', version:'1.21.6', hideErrors:false, checkTimeoutInterval:60000,
});
wrapTickEnd(bot);
bot.on('kicked', r => R.kicks.push(typeof r==='string'?r:JSON.stringify(r)));
bot.on('forcedMove', () => { R.rubber++; });
bot.on('message', m => { try { const t=m.toString(); R.chat.push(t); log('CHAT: '+t); } catch {} });
bot.on('error', e => { if (!/PartialRead|Unexpected buffer/i.test(String(e))) log('ERR '+e); });

await new Promise((res,rej) => {
  const t=setTimeout(()=>rej(new Error('spawn timeout')),90000);
  bot.once('spawn',()=>{clearTimeout(t);res();});
  bot.once('kicked',r=>{clearTimeout(t);rej(new Error('kicked '+JSON.stringify(r)));});
});
await sleep(3000);
log('spawn '+JSON.stringify(pos(bot))+' below='+below(bot));

// Wait out any leftover TP cooldown
await sleep(16000);

const n0 = R.chat.length;
bot.chat('/warp market');
log('CMD /warp market');
await sleep(6000);
R.warp_market = { replies: R.chat.slice(n0), pos: pos(bot), below: below(bot), water: !!bot.entity.isInWater };
log('warp_market '+JSON.stringify(R.warp_market));

await sleep(18000);
const n1 = R.chat.length;
bot.chat('/sethome test');
log('CMD /sethome test');
await sleep(3500);
R.sethome = { replies: R.chat.slice(n1), pos: pos(bot), below: below(bot) };
log('sethome '+JSON.stringify(R.sethome));

// If sethome failed, try warp spawn / wild then sethome
const setFail = (R.sethome.replies||[]).some(t=>/permission|claim|can't|cannot|don't|admin|protected/i.test(t));
if (setFail) {
  for (const w of ['/warp spawn', '/spawn', '/wild', '/rtp']) {
    const n = R.chat.length;
    bot.chat(w); log('CMD '+w);
    await sleep(5000);
    log('after '+w+' '+JSON.stringify(pos(bot))+' replies='+JSON.stringify(R.chat.slice(n)));
  }
  await sleep(18000);
  const n2 = R.chat.length;
  bot.chat('/sethome test');
  log('CMD /sethome test (retry)');
  await sleep(3500);
  R.sethome_retry = { replies: R.chat.slice(n2), pos: pos(bot), below: below(bot) };
  log('sethome_retry '+JSON.stringify(R.sethome_retry));
}

const setOk = [...(R.sethome?.replies||[]), ...(R.sethome_retry?.replies||[])].some(t=>/home.*set|set.*home|Home set/i.test(t));
if (setOk) {
  // Try to move: look + brief forward, tolerate rubber
  const start = bot.entity.position.clone();
  await bot.lookAt(start.offset(8,0,0));
  bot.setControlState('forward', true);
  for (let i=0;i<40;i++) {
    await sleep(250);
    if (bot.entity.position.distanceTo(start) >= 8) break;
  }
  bot.clearControlStates();
  log('walked_dist '+bot.entity.position.distanceTo(start).toFixed(1)+' '+JSON.stringify(pos(bot)));
  await sleep(18000);
  const n3 = R.chat.length;
  bot.chat('/home test'); log('CMD /home test');
  await sleep(5000);
  R.home = { replies: R.chat.slice(n3), pos: pos(bot) };
  const n4 = R.chat.length;
  bot.chat('/delhome test'); log('CMD /delhome test');
  await sleep(3000);
  R.delhome = { replies: R.chat.slice(n4) };
}

// Chat hi after any movement attempt
const start2 = bot.entity.position.clone();
await bot.lookAt(start2.offset(0,0,6));
bot.setControlState('forward', true);
for (let i=0;i<30;i++) { await sleep(250); if (bot.entity.position.distanceTo(start2)>=5) break; }
bot.clearControlStates();
await sleep(1000);
const n5 = R.chat.length;
bot.chat('hi'); log('CMD chat hi');
await sleep(4000);
R.hi = { replies: R.chat.slice(n5), moved: bot.entity.position.distanceTo(start2) };
log('hi '+JSON.stringify(R.hi));

R.finished = new Date().toISOString();
R.final_pos = { ...pos(bot), below: below(bot) };
R.rubber_count = R.rubber;
fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
log('DONE');
bot.quit();
process.exit(0);

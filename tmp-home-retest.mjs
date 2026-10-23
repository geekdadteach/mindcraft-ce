/**
 * Sethome/home/delhome + warp market + hi chat. Includes tick_end wrap for Paper 26.3.
 */
import minecraftData from 'minecraft-data';
import { createBot } from 'mineflayer';
import { Vec3 } from 'vec3';
import fs from 'fs';

const OUT = '/home/dad/ai-player/tmp/home-retest-results.txt';
const results = {
  started: new Date().toISOString(), steps: [], kicks: [], rubber: [], chat: [], errors: []
};
function log(s) { console.log(s); results.steps.push({ t: new Date().toISOString(), s }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
}
function blockBelow(bot) {
  const p = bot.entity.position;
  const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)));
  return b ? b.name : 'null';
}

async function walkDir(bot, dx, dz, targetDist, timeoutMs = 60000) {
  const start = bot.entity.position.clone();
  const yaw = Math.atan2(-dx, -dz);
  await bot.look(yaw, 0, true);
  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(250);
    if (!bot.entity) break;
    const d = bot.entity.position.distanceTo(start);
    if (d >= targetDist) break;
    if ((Date.now() - t0) % 4000 < 300) {
      bot.setControlState('jump', true);
      await sleep(200);
      bot.setControlState('jump', false);
    }
  }
  bot.clearControlStates();
  const d = bot.entity ? bot.entity.position.distanceTo(start) : 0;
  log(`walked dist=${d.toFixed(1)} to ${JSON.stringify(pos(bot))} below=${blockBelow(bot)}`);
  return d;
}

async function cmd(bot, c, waitMs = 3500) {
  const n = results.chat.length;
  log('CMD ' + c);
  bot.chat(c);
  await sleep(waitMs);
  return results.chat.slice(n);
}

const bot = createBot({
  host: '127.0.0.1', port: 25599, username: 'MineBobNE',
  auth: 'offline', version: '1.21.6', hideErrors: false,
  checkTimeoutInterval: 60000,
});
wrapTickEnd(bot);

bot.on('kicked', (r) => {
  const s = typeof r === 'string' ? r : JSON.stringify(r);
  results.kicks.push(s);
  log('KICKED ' + s);
});
bot.on('error', (e) => {
  const msg = String(e?.message || e);
  if (/PartialRead|Unexpected buffer end/i.test(msg)) return;
  results.errors.push(msg);
  log('ERR ' + msg);
});
bot.on('forcedMove', () => {
  const p = bot.entity?.position;
  results.rubber.push(`forcedMove at (${p?.x}, ${p?.y}, ${p?.z})`);
});
bot.on('message', (m) => {
  try {
    const t = m.toString();
    results.chat.push(t);
    log('CHAT: ' + t);
  } catch {}
});

try {
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('spawn timeout')), 90000);
    bot.once('spawn', () => { clearTimeout(t); res(); });
    bot.once('kicked', (r) => { clearTimeout(t); rej(new Error('kicked:' + JSON.stringify(r))); });
  });
  await sleep(2500);
  log('spawn ' + JSON.stringify(pos(bot)) + ' below=' + blockBelow(bot) + ' water=' + bot.entity.isInWater);

  // Move gate then hi
  await walkDir(bot, 1, 0, 8, 25000);
  const beforeHi = results.chat.length;
  log('CMD chat: hi');
  bot.chat('hi');
  await sleep(4500);
  const afterHi = results.chat.slice(beforeHi);
  results.hi_check = {
    sent: 'hi',
    replies: afterHi,
    appeared_in_log: afterHi.some(t => /\bhi\b/i.test(t)),
    mute_or_filter: afterHi.some(t => /mute|filter|blocked|cannot chat|can't chat|slow down/i.test(t)),
  };
  log('hi_check ' + JSON.stringify(results.hi_check));

  // Leave racetrack claim: walk east ~50
  await walkDir(bot, 1, 0.1, 50, 100000);
  let p = pos(bot);
  if (Math.hypot(p.x - (-264), p.z - 513) < 40) {
    log('still near track, walk +Z');
    await walkDir(bot, 0.1, 1, 45, 100000);
  }
  p = pos(bot);
  results.sethome_spot = { ...p, below: blockBelow(bot), water: bot.entity.isInWater };
  log('sethome_spot ' + JSON.stringify(results.sethome_spot));

  results.sethome_replies = await cmd(bot, '/sethome test');
  await sleep(18000);
  await walkDir(bot, 0, 1, 12, 30000);
  results.before_home = pos(bot);
  results.home_replies = await cmd(bot, '/home test');
  await sleep(3000);
  results.after_home = { ...pos(bot), below: blockBelow(bot) };
  results.delhome_replies = await cmd(bot, '/delhome test');
  await sleep(18000);
  results.warp_market_replies = await cmd(bot, '/warp market', 5000);
  await sleep(3000);
  results.after_market = { ...pos(bot), below: blockBelow(bot), water: bot.entity.isInWater };

  results.finished = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  log('DONE');
  bot.quit();
  process.exit(0);
} catch (e) {
  results.errors.push(String(e));
  results.finished = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.error(e);
  try { bot.quit(); } catch {}
  process.exit(1);
}

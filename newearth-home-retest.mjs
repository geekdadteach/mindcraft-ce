import minecraftData from 'minecraft-data';
import { createBot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import fs from 'fs';

const { pathfinder, Movements, goals } = pathfinderPkg;
const USER = 'MineBobNE';
const results = [];
const log = (s) => { console.log(s); results.push(s); };
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

function attachChat(bot) {
  const lines = [];
  const onMsg = (jsonMsg) => {
    let text;
    try { text = jsonMsg.toString(); } catch { text = String(jsonMsg); }
    lines.push({ t: Date.now(), text });
    console.log('CHAT:', text);
  };
  bot.on('message', onMsg);
  return {
    lines,
    takeSince(t0) { return lines.filter(l => l.t >= t0).map(l => l.text); },
    stop() { bot.off('message', onMsg); }
  };
}

function posStr(bot) {
  const p = bot.entity.position;
  return `${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}`;
}

function belowName(bot) {
  const p = bot.entity.position;
  const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)));
  return b?.name || '(none)';
}

async function walkTo(bot, x, y, z, range = 1.5, timeoutMs = 90000) {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = bot.entity.position;
    if (Math.hypot(p.x - x, p.z - z) <= range + 0.5) {
      bot.pathfinder.setGoal(null);
      return true;
    }
    await sleep(250);
  }
  bot.pathfinder.setGoal(null);
  return false;
}

async function main() {
  const kicks = [];
  const bot = createBot({
    username: USER,
    host: '127.0.0.1',
    port: 25599,
    auth: 'offline',
    version: '1.21.6',
    checkTimeoutInterval: 60000,
  });
  wrapTickEnd(bot);
  bot.loadPlugin(pathfinder);
  bot.on('kicked', (r) => { kicks.push(JSON.stringify(r)); log('KICKED ' + JSON.stringify(r)); });
  bot.on('error', (e) => console.warn('ERR', e.message || e));

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('spawn timeout')), 90000);
    bot.once('spawn', () => { clearTimeout(t); resolve(); });
    bot.once('kicked', (r) => { clearTimeout(t); reject(new Error('kicked ' + JSON.stringify(r))); });
  });
  await sleep(2500);
  const chat = attachChat(bot);
  log(`SPAWN_AT ${posStr(bot)} below=${belowName(bot)}`);

  const start = bot.entity.position.clone();
  // Walk east then, if needed, south — get 20+ blocks from start (outside racetrack claim)
  let target = new Vec3(start.x + 45, start.y, start.z);
  log(`WALK1 toward ${target.x.toFixed(1)} ${target.z.toFixed(1)}`);
  await walkTo(bot, target.x, target.y, target.z, 2, 100000);
  await sleep(800);
  let dist = Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z);
  if (dist < 20) {
    target = new Vec3(start.x, start.y, start.z + 45);
    log(`WALK2 south toward ${target.x.toFixed(1)} ${target.z.toFixed(1)} (dist=${dist.toFixed(1)})`);
    await walkTo(bot, target.x, target.y, target.z, 2, 100000);
    await sleep(800);
    dist = Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z);
  }
  if (dist < 20) {
    target = new Vec3(start.x - 45, start.y, start.z);
    log(`WALK3 west toward ${target.x.toFixed(1)} ${target.z.toFixed(1)} (dist=${dist.toFixed(1)})`);
    await walkTo(bot, target.x, target.y, target.z, 2, 100000);
    await sleep(800);
    dist = Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z);
  }
  log(`OUTSIDE_POS ${posStr(bot)} below=${belowName(bot)} dist_from_start=${dist.toFixed(1)}`);

  let t0 = Date.now();
  bot.chat('/sethome test');
  await sleep(3500);
  log(`SETHOME_REPLIES ${JSON.stringify(chat.takeSince(t0))}`);
  log(`SETHOME_POS ${posStr(bot)}`);

  log('WAITING_COOLDOWN 20s');
  await sleep(20000);

  const homeSpot = bot.entity.position.clone();
  await walkTo(bot, homeSpot.x + 12, homeSpot.y, homeSpot.z, 1.5, 40000);
  await sleep(500);
  log(`AWAY_POS ${posStr(bot)} dist_from_sethome=${Math.hypot(bot.entity.position.x - homeSpot.x, bot.entity.position.z - homeSpot.z).toFixed(1)}`);

  t0 = Date.now();
  bot.chat('/home test');
  await sleep(8000);
  log(`HOME_REPLIES ${JSON.stringify(chat.takeSince(t0))}`);
  log(`HOME_LAND_POS ${posStr(bot)} below=${belowName(bot)}`);

  t0 = Date.now();
  bot.chat('/delhome test');
  await sleep(3500);
  log(`DELHOME_REPLIES ${JSON.stringify(chat.takeSince(t0))}`);
  log(`DELHOME_POS ${posStr(bot)}`);

  log('WAITING_COOLDOWN 20s before /warp market');
  await sleep(20000);
  t0 = Date.now();
  bot.chat('/warp market');
  await sleep(10000);
  log(`WARP_MARKET_REPLIES ${JSON.stringify(chat.takeSince(t0))}`);
  log(`WARP_MARKET_POS ${posStr(bot)} below=${belowName(bot)} inWater=${!!bot.entity.isInWater}`);

  const p = bot.entity.position;
  const nearMarket = Math.hypot(p.x - (-550), p.z - 480) < 100;
  if (nearMarket) {
    await walkTo(bot, p.x, p.y, p.z + 6, 1.5, 20000);
    await sleep(500);
  }
  log(`PARK_POS ${posStr(bot)} below=${belowName(bot)} nearMarket=${nearMarket}`);
  log(`KICKS ${JSON.stringify(kicks)}`);

  chat.stop();
  fs.writeFileSync('/home/dad/ai-player/tmp/home-retest-results.txt', results.join('\n') + '\n');
  try { bot.quit(); } catch {}
  await sleep(1500);
  process.exit(kicks.length ? 2 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  fs.writeFileSync('/home/dad/ai-player/tmp/home-retest-results.txt', 'FATAL ' + (e.stack || e) + '\n');
  process.exit(1);
});

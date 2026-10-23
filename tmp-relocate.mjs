import minecraftData from 'minecraft-data';
import { createBot } from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import fs from 'fs';
const { pathfinder, Movements, goals } = pf;
const OUT='/home/dad/ai-player/tmp/relocate-results.json';
const R={chat:[],kicks:[],steps:[],rubber:0};
const log=s=>{console.log(s);R.steps.push(s)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function wrapTickEnd(bot){const M=new Set(['position','position_look','look','flying']);const w=bot._client.write.bind(bot._client);let h=null;
 bot._client.write=function(n,d){const r=w(n,d);if(M.has(n)){try{if(h===null){const md=minecraftData(bot._client.version||bot.version);h=!!(md?.protocol?.play?.toServer?.types?.packet_tick_end);}if(h)w('tick_end',{});}catch{h=false}}return r;};}
const pos=b=>{const p=b.entity.position;return{x:+p.x.toFixed(1),y:+p.y.toFixed(1),z:+p.z.toFixed(1)}};
const below=b=>{const p=b.entity.position;return b.blockAt(new Vec3(Math.floor(p.x),Math.floor(p.y)-1,Math.floor(p.z)))?.name||'null'};
const PLAYER_BLOCKS=/(planks|chest|door|bed|glass|torch|lantern|fence|crafting_table|furnace|barrel|wool|brick|sign|stairs|slab|carpet|bookshelf|lectern|campfire|ladder|trapdoor|concrete|terracotta|smooth_|polished_|banner)/;
function baseScan(bot, r=32){
  const found={}; const p=bot.entity.position.floored();
  for(let dx=-r;dx<=r;dx+=1)for(let dz=-r;dz<=r;dz+=1)for(let dy=-8;dy<=12;dy+=1){
    const b=bot.blockAt(p.offset(dx,dy,dz)); if(!b) continue;
    if(PLAYER_BLOCKS.test(b.name) && !/^(birch|oak|spruce|dark_oak|jungle|acacia|mangrove|cherry)_(leaves|log)$/.test(b.name)){
      found[b.name]=(found[b.name]||0)+1; }
  }
  return found;
}
const bot=createBot({host:'127.0.0.1',port:25599,username:'MineBobNE',auth:'offline',version:'1.21.6',hideErrors:false,checkTimeoutInterval:60000});
wrapTickEnd(bot); bot.loadPlugin(pathfinder);
bot.on('kicked',r=>{R.kicks.push(typeof r==='string'?r:JSON.stringify(r));log('KICKED '+R.kicks.at(-1))});
bot.on('forcedMove',()=>R.rubber++);
bot.on('message',m=>{try{const t=m.toString();R.chat.push(t);log('CHAT: '+t)}catch{}});
bot.on('error',e=>{if(!/PartialRead|Unexpected buffer/i.test(String(e)))log('ERR '+e)});
const cmd=async(c,w=4000)=>{const n=R.chat.length;bot.chat(c);log('CMD '+c);await sleep(w);return R.chat.slice(n)};
try{
await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('spawn timeout')),90000);bot.once('spawn',()=>{clearTimeout(t);res()});bot.once('kicked',r=>{clearTimeout(t);rej(new Error('kicked'))})});
await sleep(3000);
log('spawn '+JSON.stringify(pos(bot))+' hp='+bot.health+' food='+bot.food);
R.warp=await cmd('/warp racetrack',7000);
log('after_warp '+JSON.stringify(pos(bot))+' below='+below(bot));
const mv=new Movements(bot); mv.canDig=false; mv.allow1by1towers=false; mv.allowParkour=true; mv.scafoldingBlocks=[];
bot.pathfinder.setMovements(mv);
// go east from racetrack (away from market which is west)
const targets=[[-180,540],[-120,560],[-90,600]];
for(const [tx,tz] of targets){
  try{
    await Promise.race([bot.pathfinder.goto(new goals.GoalNearXZ(tx,tz,4)), sleep(90000).then(()=>{throw new Error('timeout')})]);
    log(`reached ~${tx},${tz} at ${JSON.stringify(pos(bot))}`);
  }catch(e){ bot.pathfinder.stop(); log(`goto ${tx},${tz} err=${e.message} at ${JSON.stringify(pos(bot))}`); }
  const dTrack=Math.hypot(bot.entity.position.x+264,bot.entity.position.z-513);
  if(dTrack>=110) break;
}
await sleep(1500);
const p=bot.entity.position;
R.spot={...pos(bot),below:below(bot),water:!!bot.entity.isInWater,
  d_market:+Math.hypot(p.x+572,p.z-480).toFixed(0), d_track:+Math.hypot(p.x+264,p.z-513).toFixed(0)};
R.base_scan=baseScan(bot,32);
R.players_nearby=Object.values(bot.players).filter(pl=>pl.entity&&pl.username!=='MineBobNE').map(pl=>pl.username);
log('spot '+JSON.stringify(R.spot)+' scan='+JSON.stringify(R.base_scan)+' players='+JSON.stringify(R.players_nearby));
// sethome retest
R.sethome=await cmd('/sethome test',4000);
await sleep(17000);
const s0=bot.entity.position.clone();
try{ await Promise.race([bot.pathfinder.goto(new goals.GoalNearXZ(s0.x+10,s0.z,1)),sleep(25000)]);}catch(e){log('walk10 err '+e.message)}
R.before_home={...pos(bot),moved:+bot.entity.position.distanceTo(s0).toFixed(1)};
R.home=await cmd('/home test',7000);
R.after_home=pos(bot);
R.delhome=await cmd('/delhome test',3500);
R.final=pos(bot);
}catch(e){R.fatal=String(e);log('FATAL '+e)}
fs.writeFileSync(OUT,JSON.stringify(R,null,2));
try{bot.quit()}catch{}; await sleep(1000); process.exit(0);

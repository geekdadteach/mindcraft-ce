// one-off: /home home, place white_bed at homestead (-823 124 568), click/sleep it, quit
import minecraftData from 'minecraft-data';
import { createBot } from 'mineflayer';
import { Vec3 } from 'vec3';
import fs from 'fs';
const OUT='/home/dad/ai-player/tmp/bed-home-results.json';
const R={chat:[],kicks:[],steps:[]};
const log=s=>{console.log(s);R.steps.push(s)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function wrapTickEnd(bot){const M=new Set(['position','position_look','look','flying']);const w=bot._client.write.bind(bot._client);let h=null;
 bot._client.write=function(n,d){const r=w(n,d);if(M.has(n)){try{if(h===null){const md=minecraftData(bot._client.version||bot.version);h=!!(md?.protocol?.play?.toServer?.types?.packet_tick_end);}if(h)w('tick_end',{});}catch{h=false}}return r;};}
const pos=b=>{const p=b.entity.position;return{x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2)}};
const bot=createBot({host:'127.0.0.1',port:25599,username:'MineBobNE',auth:'offline',version:'1.21.6',hideErrors:false,checkTimeoutInterval:60000});
wrapTickEnd(bot);
bot.on('kicked',r=>{R.kicks.push(typeof r==='string'?r:JSON.stringify(r));log('KICKED '+R.kicks.at(-1))});
bot.on('message',m=>{try{const t=m.toString();R.chat.push(t);log('CHAT: '+t)}catch{}});
bot.on('actionBar',m=>{try{log('ACTIONBAR: '+m.toString())}catch{}});
bot.on('error',e=>{if(!/PartialRead|Unexpected buffer/i.test(String(e)))log('ERR '+e)});
bot.on('death',()=>log('DEATH'));
bot.on('spawnReset',()=>log('spawnReset event'));
const solid=b=>b&&b.boundingBox==='block'&&!/leaves|chest|crafting_table|bed|glass|slab|stairs|fence|torch|barrel|furnace/.test(b.name);
const free=b=>b&&(b.name==='air'||b.name==='cave_air'||b.name==='short_grass'||b.name==='tall_grass'===false&&b.name==='air');
const isAir=b=>b&&(b.name==='air'||b.name==='cave_air');
try{
 await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('spawn timeout')),90000);bot.once('spawn',()=>{clearTimeout(t);res()});bot.once('kicked',()=>{clearTimeout(t);rej(new Error('kicked'))})});
 await sleep(4000);
 R.spawn={...pos(bot),hp:bot.health,time:bot.time.timeOfDay};
 R.inv_bed=bot.inventory.items().filter(i=>/_bed$/.test(i.name)).map(i=>i.name+'x'+i.count);
 log('spawn '+JSON.stringify(R.spawn)+' beds='+JSON.stringify(R.inv_bed));
 if(!R.inv_bed.length) throw new Error('no bed in inventory');
 let n=R.chat.length; bot.chat('/home home'); log('CMD /home home');
 const t0=Date.now(); while(Date.now()-t0<15000){await sleep(500); const p=bot.entity.position; if(Math.hypot(p.x+823,p.z-568)<12) break;}
 await sleep(2500);
 R.after_home=pos(bot); log('after_home '+JSON.stringify(R.after_home));
 const bp=bot.entity.position; if(Math.hypot(bp.x+823,bp.z-568)>12) throw new Error('not at homestead after /home');
 // landmarks
 R.landmarks=bot.findBlocks({matching:b=>/chest|crafting_table|_bed$/.test(b.name),maxDistance:10,count:20}).map(v=>bot.blockAt(v).name+'@'+v.x+','+v.y+','+v.z);
 log('landmarks '+JSON.stringify(R.landmarks));
 // candidates: foot cell f (air) on solid ground, head cell = f + dominant cardinal dir from bot to f
 const me=bot.entity.position.floored(); const cands=[];
 for(let dx=-3;dx<=3;dx++)for(let dz=-3;dz<=3;dz++)for(let dy=-1;dy<=1;dy++){
  const f=me.offset(dx,dy,dz); const d=Math.hypot(dx,dz); if(d<1.5||d>3.6) continue;
  const ddx=f.x+0.5-bot.entity.position.x, ddz=f.z+0.5-bot.entity.position.z;
  const dir=Math.abs(ddx)>Math.abs(ddz)?new Vec3(Math.sign(ddx),0,0):new Vec3(0,0,Math.sign(ddz));
  const h=f.plus(dir);
  if(!isAir(bot.blockAt(f))||!isAir(bot.blockAt(h))) continue;
  if(!isAir(bot.blockAt(f.offset(0,1,0)))||!isAir(bot.blockAt(h.offset(0,1,0)))) continue;
  if(!solid(bot.blockAt(f.offset(0,-1,0)))||!solid(bot.blockAt(h.offset(0,-1,0)))) continue;
  cands.push({f,h,score:Math.abs(dy)*2+Math.hypot(f.x+823,f.z-568)*0.3+Math.abs(d-2.5)});
 }
 cands.sort((a,b)=>a.score-b.score);
 log('candidates '+cands.length+(cands[0]?' best foot='+cands[0].f+' head='+cands[0].h:''));
 if(!cands.length) throw new Error('no bed spot');
 const bed=bot.inventory.items().find(i=>/_bed$/.test(i.name)); await bot.equip(bed,'hand');
 let placed=null;
 for(const c of cands.slice(0,4)){
  const ref=bot.blockAt(c.f.offset(0,-1,0));
  try{ await bot.placeBlock(ref,new Vec3(0,1,0)); }catch(e){ log('place err '+e.message); }
  await sleep(1000);
  const bf=bot.blockAt(c.f), bh=bot.blockAt(c.h);
  log('after place foot='+bf?.name+' head='+bh?.name+' at '+c.f);
  if(/_bed$/.test(bf?.name||'')){placed=bf;break;}
 }
 if(!placed) throw new Error('bed not placed');
 R.bed_at=placed.position.toString(); R.bed_parts=bot.findBlocks({matching:b=>/_bed$/.test(b.name),maxDistance:6,count:4}).map(v=>v.toString());
 log('bed_at '+R.bed_at+' parts='+JSON.stringify(R.bed_parts)+' timeOfDay='+bot.time.timeOfDay);
 n=R.chat.length;
 try{ await bot.sleep(placed); log('SLEEPING ok'); await sleep(6000); try{await bot.wake(); log('woke');}catch(e){log('wake err '+e.message)} }
 catch(e){ log('sleep err '+e.message); try{ await bot.activateBlock(placed); log('activateBlock done'); }catch(e2){log('activate err '+e2.message)} await sleep(3000); }
 R.bed_replies=R.chat.slice(n);
 R.end=pos(bot); R.hp=bot.health;
}catch(e){R.fatal=String(e);log('FATAL '+e)}
fs.writeFileSync(OUT,JSON.stringify(R,null,2));
try{bot.quit()}catch{}; await sleep(1500); process.exit(0);

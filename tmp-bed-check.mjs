// one-off: /home home, inspect bed at (-822,124,569)/(-821,124,569); if standing, right-click (sleep if night) to set respawn; quit
import minecraftData from 'minecraft-data';
import { createBot } from 'mineflayer';
import { Vec3 } from 'vec3';
import fs from 'fs';
const OUT='/home/dad/ai-player/tmp/bed-check-results.json';
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
const desc=v=>{const b=bot.blockAt(v);return v.x+','+v.y+','+v.z+'='+(b?b.name+(b.name.endsWith('_bed')?JSON.stringify(b.getProperties?.()||{}):''):'unloaded')};
try{
 await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('spawn timeout')),90000);bot.once('spawn',()=>{clearTimeout(t);res()});bot.once('kicked',()=>{clearTimeout(t);rej(new Error('kicked'))})});
 await sleep(4000);
 R.spawn={...pos(bot),hp:bot.health,time:bot.time.timeOfDay};
 R.inv=bot.inventory.items().map(i=>i.name+'x'+i.count);
 R.inv_bed=bot.inventory.items().filter(i=>/_bed$/.test(i.name)).map(i=>i.name+'x'+i.count);
 log('spawn '+JSON.stringify(R.spawn)+' inv='+JSON.stringify(R.inv));
 bot.chat('/home home'); log('CMD /home home');
 const t0=Date.now(); while(Date.now()-t0<15000){await sleep(500); const p=bot.entity.position; if(Math.hypot(p.x+823,p.z-568)<12) break;}
 await sleep(3000);
 R.after_home=pos(bot); log('after_home '+JSON.stringify(R.after_home));
 const bp=bot.entity.position; if(Math.hypot(bp.x+823,bp.z-568)>12) throw new Error('not at homestead after /home');
 // inspect bed cells and surroundings
 const cells=[];
 for(let x=-824;x<=-819;x++)for(let z=567;z<=571;z++)for(let y=123;y<=126;y++){ const b=bot.blockAt(new Vec3(x,y,z)); if(b&&b.name!=='air'&&b.name!=='cave_air') cells.push(desc(new Vec3(x,y,z))); }
 R.area=cells; log('area_nonair '+JSON.stringify(cells));
 R.bed_cells=[desc(new Vec3(-822,124,569)),desc(new Vec3(-821,124,569))]; log('bed_cells '+JSON.stringify(R.bed_cells));
 R.beds_near=bot.findBlocks({matching:b=>/_bed$/.test(b.name),maxDistance:32,count:10}).map(v=>desc(v)); log('beds_near '+JSON.stringify(R.beds_near));
 R.landmarks=bot.findBlocks({matching:b=>/chest|crafting_table/.test(b.name),maxDistance:16,count:20}).map(v=>desc(v)); log('landmarks '+JSON.stringify(R.landmarks));
 R.items_near=Object.values(bot.entities).filter(e=>e.name==='item'||e.displayName==='Item').map(e=>{let it=null;try{it=e.getDroppedItem?.()}catch{} return (it?it.name+'x'+it.count:'item')+'@'+e.position.floored()}); log('items_near '+JSON.stringify(R.items_near));
 R.mobs_near=Object.values(bot.entities).filter(e=>e.type==='hostile'||e.kind==='Hostile mobs').map(e=>e.name+'@'+e.position.floored()); log('mobs_near '+JSON.stringify(R.mobs_near));
 const bedPos=R.beds_near.length?bot.findBlocks({matching:b=>/_bed$/.test(b.name),maxDistance:8,count:1})[0]:null;
 if(bedPos){
  const bed=bot.blockAt(bedPos); log('using bed '+desc(bedPos)+' timeOfDay='+bot.time.timeOfDay+' dist='+bot.entity.position.distanceTo(bedPos.offset(0.5,0.5,0.5)).toFixed(1));
  const n=R.chat.length;
  const night=bot.time.timeOfDay>=12542&&bot.time.timeOfDay<=23459;
  if(night){ try{ await bot.sleep(bed); log('SLEEPING ok'); await sleep(6000); try{await bot.wake(); log('woke')}catch(e){log('wake err '+e.message)} }catch(e){ log('sleep err '+e.message); } }
  if(!R.chat.slice(n).some(t=>/Respawn point set/i.test(t))){ try{ await bot.lookAt(bedPos.offset(0.5,0.3,0.5),true); await bot.activateBlock(bed); log('activateBlock done'); }catch(e){log('activate err '+e.message)} await sleep(3000); }
  R.bed_replies=R.chat.slice(n); R.respawn_set=R.bed_replies.some(t=>/Respawn point set/i.test(t)); log('respawn_set='+R.respawn_set);
 } else { R.respawn_set=false; log('NO BED within 8 of homestead'); }
 R.end=pos(bot); R.hp=bot.health; R.food=bot.food; R.inv_end=bot.inventory.items().map(i=>i.name+'x'+i.count);
}catch(e){R.fatal=String(e);log('FATAL '+e)}
fs.writeFileSync(OUT,JSON.stringify(R,null,2));
try{bot.quit()}catch{}; await sleep(1500); process.exit(0);

// one-off read-mostly: login, ask Essentials where the bed home is (/home bed), list plugins, quit
import minecraftData from 'minecraft-data';
import { createBot } from 'mineflayer';
import { Vec3 } from 'vec3';
import fs from 'fs';
const OUT='/home/dad/ai-player/tmp/bed-verify-results.json';
const R={chat:[],steps:[]};
const log=s=>{console.log(s);R.steps.push(s)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function wrapTickEnd(bot){const M=new Set(['position','position_look','look','flying']);const w=bot._client.write.bind(bot._client);let h=null;
 bot._client.write=function(n,d){const r=w(n,d);if(M.has(n)){try{if(h===null){const md=minecraftData(bot._client.version||bot.version);h=!!(md?.protocol?.play?.toServer?.types?.packet_tick_end);}if(h)w('tick_end',{});}catch{h=false}}return r;};}
const pos=b=>{const p=b.entity.position;return{x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2)}};
const bot=createBot({host:'127.0.0.1',port:25599,username:'MineBobNE',auth:'offline',version:'1.21.6',hideErrors:false,checkTimeoutInterval:60000});
wrapTickEnd(bot);
bot.on('kicked',r=>log('KICKED '+(typeof r==='string'?r:JSON.stringify(r))));
bot.on('message',m=>{try{const t=m.toString();R.chat.push(t);log('CHAT: '+t)}catch{}});
bot.on('error',e=>{if(!/PartialRead|Unexpected buffer/i.test(String(e)))log('ERR '+e)});
try{
 await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('spawn timeout')),90000);bot.once('spawn',()=>{clearTimeout(t);res()})});
 await sleep(4000);
 R.start={...pos(bot),hp:bot.health,time:bot.time.timeOfDay}; log('start '+JSON.stringify(R.start));
 const cmd=process.argv[2]||'/home bed';
 bot.chat(cmd); log('CMD '+cmd); await sleep(8000);
 R.after={...pos(bot)}; log('after '+JSON.stringify(R.after));
 const b=bot.blockAt(new Vec3(-822,124,569)); log('bed_foot '+(b?b.name:'unloaded'));
 R.hp=bot.health; R.food=bot.food; R.inv=bot.inventory.items().map(i=>i.name+'x'+i.count);
}catch(e){R.fatal=String(e);log('FATAL '+e)}
fs.writeFileSync(OUT,JSON.stringify(R,null,2));
try{bot.quit()}catch{}; await sleep(1500); process.exit(0);

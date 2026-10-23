import minecraftData from 'minecraft-data';
import { createBot } from 'mineflayer';
import { Vec3 } from 'vec3';
import fs from 'fs';
const OUT='/home/dad/ai-player/tmp/sethome-home-results.json';
const R={chat:[],kicks:[],rubber:0,steps:[]};
const log=s=>{console.log(s);R.steps.push(s)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function wrapTickEnd(bot){const M=new Set(['position','position_look','look','flying']);const w=bot._client.write.bind(bot._client);let h=null;
 bot._client.write=function(n,d){const r=w(n,d);if(M.has(n)){try{if(h===null){const md=minecraftData(bot._client.version||bot.version);h=!!(md?.protocol?.play?.toServer?.types?.packet_tick_end);}if(h)w('tick_end',{});}catch{h=false}}return r;};}
const pos=b=>{const p=b.entity.position;return{x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2)}};
const below=b=>{const p=b.entity.position;return b.blockAt(new Vec3(Math.floor(p.x),Math.floor(p.y)-1,Math.floor(p.z)))?.name||'null'};
const bot=createBot({host:'127.0.0.1',port:25599,username:'MineBobNE',auth:'offline',version:'1.21.6',hideErrors:false,checkTimeoutInterval:60000});
wrapTickEnd(bot);
bot.on('kicked',r=>{R.kicks.push(typeof r==='string'?r:JSON.stringify(r));log('KICKED '+R.kicks.at(-1))});
bot.on('forcedMove',()=>R.rubber++);
bot.on('message',m=>{try{const t=m.toString();R.chat.push(t);log('CHAT: '+t)}catch{}});
bot.on('error',e=>{if(!/PartialRead|Unexpected buffer/i.test(String(e)))log('ERR '+e)});
const cmd=async(c,w=5000)=>{const n=R.chat.length;bot.chat(c);log('CMD '+c);await sleep(w);return R.chat.slice(n)};
try{
 await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('spawn timeout')),90000);bot.once('spawn',()=>{clearTimeout(t);res()});bot.once('kicked',()=>{clearTimeout(t);rej(new Error('kicked'))})});
 await sleep(4000);
 R.spawn={...pos(bot),below:below(bot),hp:bot.health,food:bot.food,water:!!bot.entity.isInWater};
 R.players=Object.values(bot.players).filter(p=>p.entity&&p.username!=='MineBobNE').map(p=>p.username);
 log('spawn '+JSON.stringify(R.spawn)+' players='+JSON.stringify(R.players));
 R.sethome=await cmd('/sethome home',5000);
 await sleep(20000); // teleport cooldown
 R.home=await cmd('/home home',8000);
 R.after_home={...pos(bot),below:below(bot)};
}catch(e){R.fatal=String(e);log('FATAL '+e)}
fs.writeFileSync(OUT,JSON.stringify(R,null,2));
try{bot.quit()}catch{}; await sleep(1500); process.exit(0);

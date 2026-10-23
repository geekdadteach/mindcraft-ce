import fs from 'fs';
import { Ollama } from './src/models/ollama.js';
const prof = JSON.parse(fs.readFileSync('profiles/andy-api.json'));
const defs = JSON.parse(fs.readFileSync('profiles/defaults/_default.json'));
const vm = prof.vision_model;
const m = new Ollama(vm.model, vm.url, vm.params);
const img = fs.readFileSync(fs.readdirSync('/tmp/vtest').map(f => '/tmp/vtest/' + f)[0]);
const prompt = defs.image_analysis.replace('$NAME', 'MineBobNE').replace('$STATS', '');
const mem = JSON.parse(fs.readFileSync('bots/MineBobNE/memory.json'));
const turns = (mem.turns || []).slice(-10);
console.log('history turns:', turns.length, 'chars', JSON.stringify(turns).length);
turns.push({ role: 'assistant', content: 'Let me look around. !lookAtPosition(0, 64, 8)' });
let echo = 0;
for (let i = 0; i < 5; i++) {
  const t = Date.now();
  const r = await m.sendVisionRequest(turns, prompt, img);
  if (/^\s*!/.test(r) || /![a-zA-Z]+\(/.test(r)) echo++;
  console.log(`call ${i+1}: ${((Date.now()-t)/1000).toFixed(1)}s ->`, JSON.stringify(r).slice(0, 300));
}
console.log('command-like replies:', echo, '/5');
process.exit(0);

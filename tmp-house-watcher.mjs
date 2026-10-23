// [ai-player] One-shot watcher: next time Bob comes home from away, render a house picture from his eye
// (passive snapshot hook; no command, no head turn). Reads his position from MindServer state updates.
import { io } from 'socket.io-client';
import fs from 'fs';
const RUN = '/home/dad/ai-player/run', C = { x: -820, y: 125, z: 568 }, BOX = [-824, 123, 564, -816, 127, 572];
const START = Date.now(), MAX_MS = 12 * 3600e3, NIGHT_OK_AFTER = 9 * 3600e3;
const log = (m) => console.log(`${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false })} ${m}`);
const isDay = (t) => t < 12300 || t > 23200;
let away = false, bandSince = 0, busy = false, shots = [], lastTry = 0, losTries = 0, last = null;
function finish(status, extra = {}) {
    fs.writeFileSync(`${RUN}/house-watcher-done.json`, JSON.stringify({ status, at: new Date().toISOString(), ...extra }));
    log(`done: ${status} ${JSON.stringify(extra)}`); process.exit(0);
}
async function request(id, analyze) {
    const res = `${RUN}/snapshot-result-${id}.json`; try { fs.unlinkSync(res); } catch (_) {}
    fs.writeFileSync(`${RUN}/snapshot-request.json`, JSON.stringify({ id, target: [C.x, C.y, C.z], width: 1280, height: 800, viewDistance: 5, box: BOX, analyze, requireClear: true }));
    for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 1000)); if (fs.existsSync(res)) return JSON.parse(fs.readFileSync(res, 'utf8')); }
    return { ok: false, error: 'no result in 120 s' };
}
const good = (a) => a && /VISIBLE:\s*yes/i.test(a) && !/BLOCKED:\s*yes/i.test(a);
async function tick(st) {
    const g = st?.gameplay; if (!g?.position) return;
    const p = g.position, d = Math.hypot(p.x - C.x, p.y - C.y, p.z - C.z), h = Math.hypot(p.x - C.x, p.z - C.z); last = { p, d, h, t: g.timeOfDay };
    if (Date.now() - START > MAX_MS) return finish('timeout', { last });
    // away = more than 30 blocks out horizontally (a mine shaft under the house does not count)
    if (!away) { if (h > 30) { away = true; log(`away: d=${d.toFixed(1)} at ${p.x},${p.y},${p.z}`); } return; }
    if (busy) return;
    if (d < 6 || d > 15) {
        if (shots.length) return deliver();          // left the band after at least one shot
        bandSince = 0; losTries = 0;
        if (d < 6) { away = false; log(`reached home without a usable shot (d=${d.toFixed(1)}); re-arming`); }
        return;
    }
    if (p.y < 118) return;                       // must be at surface level, not in a tunnel below
    if (!bandSince) { bandSince = Date.now(); log(`in band: d=${d.toFixed(1)} pos=${p.x},${p.y},${p.z} t=${g.timeOfDay}`); }
    if (!isDay(g.timeOfDay) && Date.now() - START < NIGHT_OK_AFTER) return;   // daytime preferred
    if (Date.now() - lastTry < 2500) return;   // shoot as soon as he is in the band (he crosses it in a few seconds)
    if (shots.length && !(d <= shots[0].d - 2)) return;                        // retry only when a bit closer
    busy = true; lastTry = Date.now();
    try {
        const id = `house${shots.length + 1}-${Date.now()}`;
        const r = await request(id, true);
        if (r.skipped) { losTries++; if (losTries % 5 === 1) log(`los blocked (${r.los?.hit}) d=${d.toFixed(1)}`); return; }
        if (!r.ok) { log(`render failed: ${r.error}`); return; }
        const dd = Math.hypot(r.pos.x - C.x, r.pos.y - C.y, r.pos.z - C.z);
        shots.push({ ...r, d: dd, id });
        log(`shot ${id} d=${dd.toFixed(1)} los=${r.los?.hit} analysis=${String(r.analysis).slice(0, 200).replace(/\n/g, ' ')}`);
        if (good(r.analysis) || shots.length >= 2) return deliver();
    } finally { busy = false; }
}
function deliver() {
    const best = shots.find(s => good(s.analysis)) || shots[shots.length - 1];
    fs.copyFileSync(best.file, `${RUN}/bob-house.jpg`);
    for (const s of shots) if (s.file !== `${RUN}/bob-house.jpg`) { try { fs.unlinkSync(s.file); } catch (_) {} }
    finish('ok', { file: `${RUN}/bob-house.jpg`, pos: best.pos, distance: Number(best.d.toFixed(1)), los: best.los, analysis: best.analysis, mc_time: best.time, shots: shots.length });
}
const s = io('http://127.0.0.1:8081', { reconnection: true });
s.on('connect', () => { log('connected to MindServer'); s.emit('listen-to-agents'); });
s.on('disconnect', () => log('MindServer disconnected; will reconnect'));
s.on('state-update', (states) => { tick(states?.MineBobNE).catch(e => { busy = false; log('tick error ' + e.message); }); });
setInterval(() => { if (Date.now() - START > MAX_MS) finish('timeout', { last }); }, 60000);
setInterval(() => last && log(`heartbeat away=${away} d=${last.d.toFixed(1)} t=${last.t}`), 15 * 60e3);
log('watcher started');

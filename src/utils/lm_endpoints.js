// [ai-player] Ordered LM Studio endpoints (e.g. .144 Wi-Fi first, .143 Ethernet second).
// pickLmUrl(): first URL whose host:port accepts TCP within connectMs. A URL that fails is skipped for downMs,
// so a dead primary costs at most one quick probe per window. Same server behind both IPs => same model IDs/vectors.
import net from 'net';

const downUntil = new Map(); // url -> epoch ms

export function lmUrlList(primary, extra) {
    return [...new Set([primary, ...(Array.isArray(extra) ? extra : [])].filter(u => typeof u === 'string' && u))];
}

function probe(url, connectMs) {
    return new Promise(resolve => {
        let u;
        try { u = new URL(url); } catch { return resolve(false); }
        const s = net.connect({ host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) });
        const done = ok => { clearTimeout(t); s.destroy(); resolve(ok); };
        const t = setTimeout(() => done(false), connectMs);
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

export function markLmUrlDown(url, downMs = 10000) {
    downUntil.set(url, Date.now() + downMs);
}

export function clearLmUrlDown(urls) {
    for (const url of [].concat(urls || [])) downUntil.delete(url);
}

// [ai-player] 2026-11-01 (Randy): Wi-Fi to Leon (.144) sometimes takes >1.5 s to connect. Wait up to 5 s and
// retry once (after 1 s) before treating an endpoint as down, and only skip it for 10 s.
export async function pickLmUrl(urls, { connectMs = 5000, downMs = 10000, retries = 1 } = {}) {
    for (const url of urls) {
        if ((downUntil.get(url) || 0) > Date.now()) continue;
        let up = await probe(url, connectMs);
        for (let i = 0; !up && i < retries; i++) {
            await new Promise(r => setTimeout(r, 1000));
            up = await probe(url, connectMs);
        }
        if (up) return url;
        markLmUrlDown(url, downMs);
        console.warn(`[ai-player] lm endpoint ${url} unreachable (no connect within ${connectMs}ms, ${retries + 1} tries); skipping ${Math.round(downMs / 1000)}s`);
    }
    return null;
}

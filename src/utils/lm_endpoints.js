// [ai-player] Ordered LM Studio endpoints (e.g. .143 Ethernet first, .144 Wi-Fi second).
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

export function markLmUrlDown(url, downMs = 30000) {
    downUntil.set(url, Date.now() + downMs);
}

export async function pickLmUrl(urls, { connectMs = 1500, downMs = 30000 } = {}) {
    for (const url of urls) {
        if ((downUntil.get(url) || 0) > Date.now()) continue;
        if (await probe(url, connectMs)) return url;
        markLmUrlDown(url, downMs);
        console.warn(`[ai-player] lm endpoint ${url} unreachable (no connect within ${connectMs}ms); skipping ${Math.round(downMs / 1000)}s`);
    }
    return null;
}

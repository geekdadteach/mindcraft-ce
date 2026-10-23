/**
 * [ai-player] Disk cache for text embeddings (Andy API free-tier).
 * Path: /home/dad/ai-player/cache/embeddings.json
 * Key: modelName + ":" + sha256(text)
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

const CACHE_PATH = '/home/dad/ai-player/cache/embeddings.json';

let store = null; // { version, entries: { key: number[] } }
let dirty = false;
let stats = { hits: 0, misses: 0, http_batches: 0, writes: 0 };

function load() {
    if (store) return store;
    try {
        if (existsSync(CACHE_PATH)) {
            store = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
            if (!store.entries) store.entries = {};
            if (!store.version) store.version = 1;
        } else {
            store = { version: 1, entries: {} };
        }
    } catch (e) {
        console.warn('[ai-player] embedding-cache load failed, starting empty:', e.message || e);
        store = { version: 1, entries: {} };
    }
    return store;
}

function save() {
    if (!dirty) return;
    try {
        mkdirSync(dirname(CACHE_PATH), { recursive: true });
        writeFileSync(CACHE_PATH, JSON.stringify(store));
        dirty = false;
        stats.writes++;
        console.log(`[ai-player] embedding-cache saved entries=${Object.keys(store.entries).length} path=${CACHE_PATH}`);
    } catch (e) {
        console.warn('[ai-player] embedding-cache save failed:', e.message || e);
    }
}

function keyFor(modelName, text) {
    const h = createHash('sha256').update(String(text), 'utf8').digest('hex');
    return `${modelName || 'auto'}:${h}`;
}

export function embeddingCacheStats() {
    return { ...stats, entries: store ? Object.keys(store.entries).length : 0 };
}

export function logEmbeddingCacheStartupSummary(label = 'startup') {
    const s = embeddingCacheStats();
    console.log(`[ai-player] embedding-cache ${label}: hits=${s.hits} misses=${s.misses} http_batches=${s.http_batches} entries=${s.entries}`);
}

/**
 * Resolve embeddings for texts, using disk cache. uncachedFn(texts[]) -> embeddings[]
 * Returns embeddings in same order as texts.
 */
export async function embedWithCache(modelName, texts, uncachedFn) {
    load();
    const out = new Array(texts.length);
    const missingIdx = [];
    const missingTexts = [];

    for (let i = 0; i < texts.length; i++) {
        const k = keyFor(modelName, texts[i]);
        const hit = store.entries[k];
        if (Array.isArray(hit)) {
            out[i] = hit;
            stats.hits++;
        } else {
            missingIdx.push(i);
            missingTexts.push(texts[i]);
            stats.misses++;
        }
    }

    if (missingTexts.length > 0) {
        const fresh = await uncachedFn(missingTexts);
        if (!Array.isArray(fresh) || fresh.length !== missingTexts.length) {
            throw new Error('embedding-cache: uncachedFn returned bad length');
        }
        stats.http_batches++;
        for (let j = 0; j < missingTexts.length; j++) {
            const i = missingIdx[j];
            out[i] = fresh[j];
            store.entries[keyFor(modelName, missingTexts[j])] = fresh[j];
            dirty = true;
        }
        save();
    }

    return out;
}

export function resetEmbeddingCacheStats() {
    stats = { hits: 0, misses: 0, http_batches: 0, writes: 0 };
}

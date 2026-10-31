// !searchWiki: resolve the article with opensearch first (list=search as the fallback), then
// summarize the top hit. Covers the ~10 s timeout, the ~2000 character cap (with room kept
// for the section list), the not-found path and the command's error handling.
// Nothing here touches the network: every fetch is injected or stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
// This import must stay first. queries.js and commands/index.js import each other, so
// commands/index.js has to be evaluated before queries.js or `queryList` is still in its
// temporal dead zone and importing queries.js throws.
import '../src/agent/commands/index.js';
import {
    buildWikiSummary,
    fetchWikiOpenSearchTitle,
    fetchWikiTopHit,
    searchWiki,
    queryList,
    WIKI_SEARCH_TIMEOUT_MS,
    WIKI_SUMMARY_MAX_CHARS,
} from '../src/agent/commands/queries.js';

const OPENSEARCH = url => url.includes('action=opensearch');
const SEARCH = url => url.includes('list=search');
const PAGE = url => url.includes('/w/');

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

function htmlResponse(html, { ok = true, status = 200 } = {}) {
    return { ok, status, json: () => Promise.resolve({}), text: () => Promise.resolve(html) };
}

// opensearch answers [query, [titles], [descriptions], [urls]].
function opensearchBody(...titles) {
    return [titles[0] ?? '', titles, titles.map(() => ''), titles.map(() => '')];
}

function searchHit(title) {
    return jsonResponse({ query: { search: [{ title }] } });
}

function article(...parts) {
    return `<div class="mw-parser-output">${parts.join('')}</div>`;
}

// Live minecraft.wiki wraps headings in <div class="mw-heading mw-heading2">.
function heading(text, level = 2) {
    return `<div class="mw-heading mw-heading${level}"><h${level}>${text}</h${level}></div>`;
}

function recordingFetch(routes) {
    const calls = [];
    const impl = (url, options) => {
        calls.push({ url, options });
        const route = routes.find(candidate => candidate.match(url));
        if (!route) return Promise.reject(new Error(`unexpected fetch: ${url}`));
        return Promise.resolve(route.respond(url, options));
    };
    impl.calls = calls;
    return impl;
}

function wikiCommand() {
    return queryList.find(command => command.name === '!searchWiki');
}

test('!searchWiki resolves the title with opensearch and skips list=search entirely', async () => {
    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse(opensearchBody('Diamond')) },
        { match: PAGE, respond: () => htmlResponse(article('<p>Diamonds are gems.</p>')) },
    ]);

    const summary = await searchWiki('diamonds', { fetchImpl });

    assert.equal(fetchImpl.calls.length, 2, 'opensearch then the page, nothing else');
    assert.equal(fetchImpl.calls[0].url, 'https://minecraft.wiki/api.php?action=opensearch&search=diamonds&limit=1&redirects=resolve&format=json');
    assert.equal(fetchImpl.calls[1].url, 'https://minecraft.wiki/w/Diamond');
    assert.ok(!fetchImpl.calls.some(call => SEARCH(call.url)), 'list=search must not be called when opensearch answers');
    assert.match(summary, /Diamond/);
});

test('!searchWiki falls back to the list=search top hit when opensearch has no title', async () => {
    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse(opensearchBody()) },
        { match: SEARCH, respond: () => jsonResponse({ query: { search: [{ title: 'Diamond' }, { title: 'Diamond Ore' }] } }) },
        { match: PAGE, respond: () => htmlResponse(article('<p>Diamonds are gems.</p>')) },
    ]);

    await searchWiki('diamonds', { fetchImpl });

    assert.equal(fetchImpl.calls.length, 3, 'opensearch, list=search, then the page');
    assert.ok(OPENSEARCH(fetchImpl.calls[0].url));
    assert.equal(fetchImpl.calls[1].url, 'https://minecraft.wiki/api.php?action=query&list=search&srsearch=diamonds&format=json');
    assert.equal(fetchImpl.calls[2].url, 'https://minecraft.wiki/w/Diamond');
    assert.ok(!fetchImpl.calls[2].url.includes('Diamond_Ore'), 'the runner-up must not be fetched');
});

test('!searchWiki falls back to list=search when opensearch itself fails', async () => {
    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse({}, { ok: false, status: 503 }) },
        { match: SEARCH, respond: () => searchHit('Diamond') },
        { match: PAGE, respond: () => htmlResponse(article('<p>Diamonds are gems.</p>')) },
    ]);

    assert.match(await searchWiki('diamonds', { fetchImpl }), /Diamond/);
    assert.equal(fetchImpl.calls.length, 3);
    assert.equal(fetchImpl.calls[1].url, 'https://minecraft.wiki/api.php?action=query&list=search&srsearch=diamonds&format=json');
});

test('!searchWiki URL-encodes the query for both APIs and the fetched page title', async () => {
    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse(opensearchBody()) },
        { match: SEARCH, respond: () => searchHit('Block of Diamond') },
        { match: PAGE, respond: () => htmlResponse(article('<p>A block.</p>')) },
    ]);

    await searchWiki('block of diamond', { fetchImpl });

    assert.equal(fetchImpl.calls[0].url, 'https://minecraft.wiki/api.php?action=opensearch&search=block%20of%20diamond&limit=1&redirects=resolve&format=json');
    assert.equal(fetchImpl.calls[1].url, 'https://minecraft.wiki/api.php?action=query&list=search&srsearch=block%20of%20diamond&format=json');
    assert.equal(fetchImpl.calls[2].url, 'https://minecraft.wiki/w/Block_of_Diamond');
});

test('!searchWiki returns a short not-found message and never fetches a page when neither API has a hit', async () => {
    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse(opensearchBody()) },
        { match: SEARCH, respond: () => jsonResponse({ query: { search: [] } }) },
    ]);

    const result = await searchWiki('zzzznope', { fetchImpl });

    assert.equal(fetchImpl.calls.length, 2, 'no page fetch without a hit');
    assert.match(result, /zzzznope was not found on the Minecraft Wiki/);
    assert.ok(result.length < 200, `not-found message should be short, was ${result.length}`);
});

test('!searchWiki treats a missing search block as no hits', async () => {
    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse(opensearchBody()) },
        { match: SEARCH, respond: () => jsonResponse({}) },
    ]);

    assert.match(await searchWiki('nothing', { fetchImpl }), /was not found on the Minecraft Wiki/);
    assert.equal(fetchImpl.calls.length, 2);
});

test('!searchWiki builds a clean title + intro + key-sections summary from wrapped headings', () => {
    const summary = buildWikiSummary('Diamond', article(
        '<table class="navbox"><tr><td>NAVBOX NOISE</td></tr></table>',
        '<p>Diamonds are <b>rare</b> gems.</p>',
        '<p>They are used for tools.</p>',
        heading('Obtaining <span class="mw-editsection">[edit]</span>'),
        '<p>Mine them deep underground.</p>',
        heading('References'),
    ));

    assert.match(summary, /^Diamond\n/);
    assert.match(summary, /Diamonds are rare gems\./);
    assert.match(summary, /They are used for tools\./);
    assert.match(summary, /Sections: Obtaining/);
    assert.ok(!summary.includes('NAVBOX NOISE'), 'navbox noise must be stripped');
    assert.ok(!summary.includes('[edit]'), 'edit links must be stripped');
    assert.ok(!summary.includes('References'), 'navigation-only headings must be skipped');
    assert.ok(!summary.includes('Mine them deep underground.'), 'body text after a wrapped heading is not intro');
});

test('!searchWiki keeps body text out of the intro and the Sections line under the cap', async () => {
    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse(opensearchBody('Long')) },
        { match: PAGE, respond: () => htmlResponse(article(
            `<p>${'D'.repeat(9000)}</p>`,
            heading('Obtaining'),
            '<p>Mine them deep underground.</p>',
            heading('Usage'),
        )) },
    ]);

    const summary = await searchWiki('long', { fetchImpl });

    assert.ok(summary.length <= WIKI_SUMMARY_MAX_CHARS, `summary was ${summary.length} chars`);
    assert.ok(summary.endsWith('Sections: Obtaining, Usage'), `section list was cut off: ${summary.slice(-60)}`);
    assert.ok(!summary.includes('Mine them deep underground.'), 'body text after a wrapped heading is not intro');
});

test('!searchWiki caps the summary at about 2000 characters', async () => {
    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse(opensearchBody('Long')) },
        { match: PAGE, respond: () => htmlResponse(article(`<p>${'A'.repeat(9000)}</p>`)) },
    ]);

    const summary = await searchWiki('long', { fetchImpl });

    assert.ok(summary.length <= WIKI_SUMMARY_MAX_CHARS, `summary was ${summary.length} chars`);
    assert.ok(summary.length > WIKI_SUMMARY_MAX_CHARS - 10, `summary should fill the cap, was ${summary.length}`);
    assert.ok(summary.endsWith('…'), 'a truncated summary ends with an ellipsis');
});

test('!searchWiki uses a ~10 s timeout and signals every request', async () => {
    assert.equal(WIKI_SEARCH_TIMEOUT_MS, 10000);

    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse(opensearchBody()) },
        { match: SEARCH, respond: () => searchHit('Diamond') },
        { match: PAGE, respond: () => htmlResponse(article('<p>Diamond.</p>')) },
    ]);

    await searchWiki('diamond', { fetchImpl });

    assert.equal(fetchImpl.calls.length, 3, 'opensearch, list=search, page');
    for (const call of fetchImpl.calls) {
        assert.ok(call.options?.signal instanceof AbortSignal, 'each request must carry an abort signal');
        assert.equal(call.options.signal.aborted, false);
    }
});

test('fetchWikiOpenSearchTitle reports a non-OK opensearch response as an error', async () => {
    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse({}, { ok: false, status: 502 }) },
    ]);

    await assert.rejects(() => fetchWikiOpenSearchTitle('diamond', { fetchImpl }), /HTTP 502/);
});

test('fetchWikiTopHit reports a non-OK search response as an error', async () => {
    const fetchImpl = recordingFetch([
        { match: SEARCH, respond: () => jsonResponse({}, { ok: false, status: 503 }) },
    ]);

    await assert.rejects(() => fetchWikiTopHit('diamond', { fetchImpl }), /HTTP 503/);
});

test('searchWiki reports a non-OK page response as an error', async () => {
    const fetchImpl = recordingFetch([
        { match: OPENSEARCH, respond: () => jsonResponse(opensearchBody('Diamond')) },
        { match: PAGE, respond: () => htmlResponse('nope', { ok: false, status: 404 }) },
    ]);

    await assert.rejects(() => searchWiki('diamond', { fetchImpl }), /HTTP 404/);
});

test('the !searchWiki command returns the summary end to end', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = (url) => {
        calls.push(url);
        if (OPENSEARCH(url)) return Promise.resolve(jsonResponse(opensearchBody('Diamond')));
        return Promise.resolve(htmlResponse(article('<p>Diamonds are gems.</p>', heading('Obtaining'))));
    };

    try {
        const result = await wikiCommand().perform({}, 'diamond');
        assert.equal(calls.length, 2);
        assert.match(result, /Diamond/);
        assert.match(result, /Sections: Obtaining/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('the !searchWiki command turns a timeout into a short message instead of throwing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(Object.assign(
        new Error('The operation was aborted due to timeout'),
        { name: 'TimeoutError' },
    ));

    try {
        const result = await wikiCommand().perform({}, 'diamond');
        assert.match(result, /could not be reached/);
        assert.match(result, /timeout/i);
        assert.ok(result.length < 200, `error message should be short, was ${result.length}`);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

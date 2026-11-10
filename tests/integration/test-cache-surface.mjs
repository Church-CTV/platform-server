/**
 * The public cache surface, over real HTTP (2026-11-09).
 *
 * The owner asked for a cache system for CTV: "if the config/feed content hasn't changed and the client
 * already has the latest config, the server should return the appropriate cache response instead of the full
 * body... just have to check real quick, and if it isn't the newest, the backend will just send the new one,
 * so no lost time waiting to make another request". Measured on both live origins that model is half true
 * already (`gates/t2-feed-cache-surface-2026-11-09.md`): a matching `If-None-Match` answers `304 0 B` in 3 ms
 * where the `200` costs 79 ms, but only 0.4 % of requests carry a validator, **no path sends a freshness
 * policy at all**, nothing is compressed, and even a `304` re-reads, re-parses, re-validates and re-serializes
 * the whole document (`/api/v2/config`'s `304` is *slower* than its `200`: 14 ms against 12 ms).
 *
 * The policy this file pins (design of record `CACHE-DESIGN-2026-11-09.md`, ACCEPTED [owner 2026-11-09]):
 *  - `CACHE-1` a validator is a content digest, never a clock or a filesystem mtime, and it is the *same*
 *    digest the body itself carries (`configVersion`), so "the server agrees with itself" is not the claim;
 *  - `CACHE-2` the memoized bytes are what answer, so a repeat request does no read/parse/validate work;
 *  - `CACHE-3` the freshness policy is stated in a header, and a path the table does not name is `no-store`;
 *  - `CACHE-5` one representation per encoding, `Vary: Accept-Encoding`, and the compressed bytes are the
 *    bytes the `ETag` describes when that encoding is what was served;
 *  - `CACHE-9` the operator surface and the heartbeat are never cacheable, so a cached page cannot become a
 *    stale operator decision or a cached "alive";
 *  - `CACHE-10` `CACHE_DISABLE=true` turns reuse off without changing what a digest means;
 *  - `CACHE-11` a config release arrives as one document: the v2 feed and the v2 config must agree, by
 *    construction and by digest, about which config a television is being told to use.
 *
 * Two processes: the default one, and one with `CACHE_DISABLE=true`, because the outage switch must not
 * change identity - the same content must keep the same digest with the cache off, or turning the cache off
 * becomes a silent mass-invalidation of every client on earth.
 */

import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import nodeHttp from 'node:http';

// The org identity the enabled fixture digests with: `routes/../lib/httpCache.js#orgKey()` resolves to the
// `URL` the process declares, and the digest is salted by it (`CACHE-6`) so two orgs publishing identical
// bytes can never answer for each other. Recomputing a digest here without the salt is a different digest.
const ORG_ON = 'http://127.0.0.1:3177';
const sha256 = (input) => {
    const body =
        typeof input === 'string' || Buffer.isBuffer(input)
            ? Buffer.from(input)
            : Buffer.from(canonical(input), 'utf8');
    return sha256Hex(Buffer.concat([Buffer.from(`${ORG_ON}\n`, 'utf8'), body]));
};

function canonical(node) {
    if (node === null || node === undefined) return 'null';
    if (Array.isArray(node)) return `[${node.map(canonical).join(',')}]`;
    if (typeof node !== 'object') return JSON.stringify(node);
    return `{${Object.keys(node)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(node[key])}`)
        .join(',')}}`;
}

const sha256Hex = (input) => createHash('sha256').update(input).digest('hex');

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

const temp = mkdtempSync(path.join(os.tmpdir(), 'ctv-cache-surface-'));

const running = [];
const PORT_ON = 3177;
const PORT_OFF = 3178;
// A third deployment whose operator store sets freshness seconds (`CACHE-3` as configuration), and a
// fourth with the same setting and the outage switch on, which has to win (`CACHE-10`).
const PORT_TTL = 3179;
const PORT_TTL_OFF = 3180;

function fixture(port, { storeExtra = {} } = {}) {
    const dir = path.join(temp, `p${port}`);
    mkdirSync(path.join(dir, 'output'), { recursive: true });
    mkdirSync(path.join(dir, 'media'), { recursive: true });
    writeFileSync(
        path.join(dir, 'channel-config.json'),
        JSON.stringify({
            version: '1.0.0',
            channel: { name: 'Cache Church', description: 'Sermons', language: 'en', copyright: '(c) 2026' },
            content: { sourceUrl: `http://127.0.0.1:${port}/api/v2/feed`, maxRows: 12 },
            branding: { colors: { accent: '0xE8B931' } },
            ...storeExtra
        })
    );
    // A feed big enough that compression is measurable, with month keys holding arrays of real items.
    const feed = {
        providerName: 'Cache Church',
        lastUpdated: '2026-11-09T00:00:00.000Z',
        language: 'en',
        feedVersion: '1',
        config: { branding: { colors: { accent: '0x111111' } } }
    };
    feed['November 2026'] = Array.from({ length: 120 }, (_, i) => ({
        id: `cache-item-${i}`,
        title: `Sermon ${i} ${'padding to make the document compressible '.repeat(6)}`,
        shortDescription: 'a fairly long description repeated so that gzip has something to work with '.repeat(4),
        genres: ['sermon', 'series'],
        releaseDate: '2026-11-01',
        length: 2400,
        contentId: `content-${i}`
    }));
    const raw = JSON.stringify(feed);
    writeFileSync(path.join(dir, 'feed.json'), raw);
    writeFileSync(path.join(dir, 'output', 'roku_feed.json'), raw);
    return { dir, dbPath: path.join(dir, 'analytics.db'), feedPath: path.join(dir, 'feed.json') };
}

async function start({ port, env = {}, storeExtra = {} }) {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', () => reject(new Error(`port ${port} is already taken - pick another`)));
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });

    const { dir, dbPath } = fixture(port, { storeExtra });
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            URL: `http://127.0.0.1:${port}`,
            ADMIN_PASSWORD: 'local-cache-test-only',
            DB_PATH: dbPath,
            CTV_V2_FEED_PATH: path.join(dir, 'feed.json'),
            CTV_FEED_OUTPUT_DIR: path.join(dir, 'output'),
            CTV_VIDEOS_DIR: path.join(dir, 'media'),
            CTV_VIDEOS_METADATA: path.join(dir, 'videos.json'),
            CTV_AUDIT_DIR: path.join(dir, 'audit'),
            CTV_CHANNEL_CONFIG: path.join(dir, 'channel-config.json'),
            SESSION_SECRET: 'local-cache-session-only',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    running.push(child);
    let log = '';
    child.stdout.on('data', (chunk) => (log += chunk));
    child.stderr.on('data', (chunk) => (log += chunk));

    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 120 && !up; i += 1) {
        try {
            up = (await fetch(`${base}/api/v2/health`)).status === 200;
        } catch {
            /* not listening yet */
        }
        if (!up && child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${log.slice(0, 800)}`);
        if (!up) await new Promise((done) => setTimeout(done, 250));
    }
    if (!up) throw new Error(`server never became healthy: ${log.slice(0, 800)}`);

    /**
     * Raw `node:http` request. The global `fetch` negotiates `accept-encoding: gzip` on its own and
     * transparently decompresses the answer, so through fetch a compressed response looks identical to an
     * uncompressed one and `content-length` describes bytes that are no longer on the wire. Encoding is
     * measured here the way a television sees it: exact bytes, no help.
     */
    async function raw(route, { headers = {}, method = 'GET' } = {}) {
        return new Promise((resolve, reject) => {
            const req = nodeHttp.request(new URL(base + route), { method, headers }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode,
                        headers: Object.fromEntries(
                            Object.entries(res.headers).map(([k, v]) => [
                                k,
                                Array.isArray(v) ? v.join(', ') : String(v)
                            ])
                        ),
                        body: Buffer.concat(chunks)
                    })
                );
            });
            req.on('error', reject);
            req.end();
        });
    }

    async function request(route, { headers = {}, method = 'GET' } = {}) {
        const res = await fetch(base + route, { method, headers, redirect: 'manual' });
        const body = method === 'HEAD' ? '' : Buffer.from(await res.arrayBuffer());
        return {
            status: res.status,
            headers: Object.fromEntries(res.headers),
            body,
            text: body.toString('utf8')
        };
    }
    return { base, request, raw, dir, log: () => log, feedPath: path.join(dir, 'feed.json') };
}

let on; // cache enabled (the default)
let off; // CACHE_DISABLE=true
let ttl; // freshness seconds set in the operator store
let ttlOff; // the same freshness setting with CACHE_DISABLE=true

before(async () => {
    assert.equal(
        ORG_ON,
        `http://127.0.0.1:${PORT_ON}`,
        "ORG_ON must track PORT_ON, or every digest recomputed in this file is the wrong org's"
    );
    on = await start({ port: PORT_ON });
    // `/feed` is the same file on both processes, so it is the honest cross-process comparison: turning the
    // cache off must not move the digest of identical content, or the outage switch is a mass invalidation.
    // The disabled process declares the enabled process's origin on purpose: a digest is scoped to its org
    // (`CACHE-6`), so comparing two different orgs here would measure the namespace, not the switch.
    off = await start({ port: PORT_OFF, env: { CACHE_DISABLE: 'true', URL: ORG_ON } });
    ttl = await start({
        port: PORT_TTL,
        storeExtra: { cache: { feedMaxAgeSeconds: 120, feedStaleWhileRevalidateSeconds: 30 } }
    });
    ttlOff = await start({
        port: PORT_TTL_OFF,
        env: { CACHE_DISABLE: 'true' },
        storeExtra: { cache: { feedMaxAgeSeconds: 120 } }
    });
});

after(() => {
    for (const child of running) {
        if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(temp, { recursive: true, force: true });
});

/** Every public read path this design has an opinion about. */
const READ_PATHS = ['/feed', '/feed/', '/api/v2/feed', '/api/v2/config', '/api/v2/health'];

test('CACHE-3: every named read path states its freshness policy, in one table, fail closed', async () => {
    for (const route of READ_PATHS) {
        const res = await on.request(route);
        assert.equal(res.status, 200, `${route} must still answer a plain GET`);
        const cc = res.headers['cache-control'];
        assert.ok(cc, `${route} sends no Cache-Control: a strict client is left guessing (heuristic freshness)`);
        assert.ok(
            /public, (no-cache|max-age=)/.test(cc),
            `${route} Cache-Control "${cc}" is not one of the table's two shapes (revalidate or age)`
        );
        if (route.startsWith('/api/v2/')) {
            assert.match(cc, /no-cache/, `${route} is content-addressed and must revalidate, not age`);
        }
    }
});

test('CACHE-3: freshness seconds are configuration, and releasing them is neither a rebuild nor a restart', async () => {
    // The table is the default; the tenant's `cache` section is the override, read from the deployment layers
    // (server profile + operator store) and not from the `config` block embedded in a published feed. A policy
    // that lived inside the published document could not be changed without republishing it, which is the
    // release bug this design exists to remove.
    for (const route of ['/feed', '/feed/', '/api/v2/feed']) {
        const res = await ttl.request(route);
        assert.equal(res.status, 200, `${route} must answer on a deployment that configured freshness`);
        assert.equal(
            res.headers['cache-control'],
            'public, max-age=120, stale-while-revalidate=30',
            `${route} ignored the configured freshness seconds`
        );
        // The age changes reuse, not identity: a validator is still a content digest, still strong.
        assert.match(res.headers.etag, /^"[0-9a-f]{64}"$/, `${route} lost its digest when freshness was configured`);
    }

    // Config itself never ages, whatever the tenant set: it is the document that says what the rules are.
    const cfg = await ttl.request('/api/v2/config');
    assert.equal(cfg.headers['cache-control'], 'public, no-cache', 'the config response took the tenant age');

    // And the knob is per-deployment: the default process, which set nothing, still always revalidates.
    const sameRoute = await on.request('/feed');
    assert.equal(
        sameRoute.headers['cache-control'],
        'public, no-cache',
        'the freshness knob leaked across deployments: a tenant setting an age changed another deployment policy'
    );

    // Release it without touching the process: rewrite the store the way the admin panel does, and the next
    // request must answer differently. This is the difference between configuration and a deploy.
    const storePath = path.join(ttl.dir, 'channel-config.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store.cache = { feedMaxAgeSeconds: 0, feedStaleWhileRevalidateSeconds: 0 };
    writeFileSync(storePath, JSON.stringify(store));

    const after = await ttl.request('/feed');
    assert.equal(
        after.headers['cache-control'],
        'public, no-cache',
        'a freshness change in the operator store did not reach the next request without a restart'
    );
});

test('CACHE-10: the outage switch outranks a configured freshness age, and does not touch the digest', async () => {
    // A tenant that asked for `max-age=120` and an operator who just pulled the switch: the switch is the
    // answer. If the tenant value won, "cache off" would mean "still reusing", which is not an outage switch.
    const res = await ttlOff.request('/feed');
    assert.equal(res.status, 200);
    assert.match(res.headers['cache-control'] || '', /no-store/, 'CACHE_DISABLE lost to a configured max-age');
    assert.equal(res.headers['x-ctv-cache'], 'no-store', 'the switch did not report what it did');
    assert.match(res.headers.etag, /^"[0-9a-f]{64}"$/, 'the switch changed what the bytes digest to');
});

test('CACHE-9: the heartbeat and any path the table does not name are no-store', async () => {
    const hb = await on.request('/api/heartbeat');
    assert.equal(hb.status, 200);
    assert.match(hb.headers['cache-control'] || '', /no-store/, 'a cached heartbeat is a lie about liveness');

    const unknown = await on.request('/definitely-not-a-route-8f2c1d');
    assert.equal(unknown.status, 404);
    assert.match(
        unknown.headers['cache-control'] || '',
        /no-store/,
        'an unknown path must fail closed: not cacheable by accident (the project rule)'
    );
});

test("CACHE-3: the wire policy is the table's answer for the path the client asked for, exactly", async () => {
    // Measured on the stage 2026-11-10, and the reason this test exists: `/api/v2/search` was answering
    // `public, no-cache` while the design says a query-dependent answer is `no-store`. The v2 router forwards
    // it by rewriting `req.url` to `/search` (routes/v2.js), so whichever path the policy lookup used was an
    // internal routing detail, not the public path a client (or a shared cache) sees. A forward must not be
    // able to change what is cacheable, so the policy is taken from the path the request arrived with.
    const expected = [
        ['/feed', 'public, no-cache'],
        ['/feed/', 'public, no-cache'],
        ['/api/v2/feed', 'public, no-cache'],
        ['/api/v2/config', 'public, no-cache'],
        ['/api/v2/health', 'public, no-cache'],
        ['/privacy', 'public, max-age=300, stale-while-revalidate=60'],
        // `CACHE-3` + the design\'s rule that the query is not in the cache key: neither spelling of the
        // search endpoint may be stored, or one query\'s hits answer another\'s question.
        ['/search?q=grace', 'no-store'],
        ['/api/v2/search?q=grace', 'no-store']
    ];
    for (const [route, want] of expected) {
        const res = await on.request(route);
        assert.equal(res.status, 200, `${route} must answer 200 for its policy to mean anything (got ${res.status})`);
        assert.equal(res.headers['cache-control'], want, `${route} sent "${res.headers['cache-control']}"`);
        if (want === 'no-store') {
            assert.ok(
                !/public|max-age=/.test(res.headers['cache-control']),
                `${route} must not be storable by a shared cache`
            );
        }
    }
});

test('CACHE-1: a validator is a content digest, strong, and the same digest the body carries', async () => {
    const feed = await on.request('/api/v2/feed');
    const cfg = await on.request('/api/v2/config');
    const legacy = await on.request('/feed');

    for (const [route, res] of [
        ['/api/v2/feed', feed],
        ['/api/v2/config', cfg],
        ['/feed', legacy]
    ]) {
        const etag = res.headers.etag;
        assert.ok(etag, `${route} sends no ETag`);
        assert.ok(!etag.startsWith('W/'), `${route} sends a weak validator for bytes a client must byte-compare`);
        assert.match(etag, /^"[0-9a-f]{64}"$/, `${route} ETag ${etag} is not a strong sha256 content digest`);
    }
    // The tell: what a validator claims. For a JSON representation it is the sha256 of the canonical
    // (sorted-key) form of the body actually served, so the digest cannot drift from the bytes, and
    // `configVersion` is the same function over the config the body carries - which is what lets a client
    // tell "this server restarted" from "this content changed".
    const cfgBody = JSON.parse(cfg.text);
    assert.match(cfgBody.configVersion, /^[0-9a-f]{64}$/, 'configVersion is not the canonical digest form');
    assert.equal(
        cfg.headers.etag,
        `"${sha256(canonical(cfgBody))}"`,
        'the config ETag does not describe the body it ships'
    );
    assert.equal(
        cfgBody.configVersion,
        sha256(canonical(cfgBody.config)),
        'configVersion is not a content digest of the config it names'
    );
    assert.equal(
        feedBody().configVersion,
        cfgBody.configVersion,
        'the feed and the config endpoints name different digests for the same released config'
    );
    function feedBody() {
        return JSON.parse(feed.text);
    }
    assert.equal(
        feed.headers.etag,
        `"${sha256(canonical(feedBody()))}"`,
        'the v2 feed ETag does not describe the body it ships'
    );
    // The legacy published format is a file: its validator is a digest of the bytes served, and it is the
    // one representation whose *config* is whatever was baked when the file was written (CACHE-11 open).
    assert.equal(legacy.headers.etag, `"${sha256(legacy.body)}"`, 'the legacy feed ETag is not its own bytes');

    // Two representations of the same document share one validator (`/feed` and `/feed/`).
    assert.equal((await on.request('/feed/')).headers.etag, legacy.headers.etag);

    // And the digest describes content, not the clock: an untouched document keeps its digest across
    // repeated requests, and a byte changed on disk moves it.
    const first = legacy.headers.etag;
    assert.equal((await on.request('/feed')).headers.etag, first, 'an unchanged document changed its digest');
    const raw = readFileSync(on.feedPath, 'utf8');
    const bumped = JSON.parse(raw);
    bumped['November 2026'][0].title = 'a different title';
    writeFileSync(on.feedPath, JSON.stringify(bumped));
    await new Promise((done) => setTimeout(done, 1200));
    const moved = (await on.request('/feed')).headers.etag;
    assert.notEqual(moved, first, 'a content change did not move the digest');

    // ...and the same bytes assembled in a different key order keep the same digest (CACHE-1's fixture pair).
    const reordered = JSON.parse(raw);
    const asMap = (node) =>
        Array.isArray(node)
            ? node.map(asMap)
            : node && typeof node === 'object'
              ? Object.fromEntries(
                    Object.keys(node)
                        .sort()
                        .map((k) => [k, asMap(node[k])])
                )
              : node;
    writeFileSync(on.feedPath, JSON.stringify(asMap(reordered)));
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(
        (await on.request('/api/v2/feed')).headers.etag,
        feed.headers.etag,
        'assembly order leaked into the digest: spurious cache misses and false "content changed" claims'
    );
    writeFileSync(on.feedPath, raw);
});

test('CACHE-4: conditional GET answers 304 with no body, and a stale validator gets the whole new body', async () => {
    for (const route of READ_PATHS) {
        const fresh = await on.request(route);
        const etag = fresh.headers.etag;

        const hit = await on.request(route, { headers: { 'if-none-match': etag } });
        assert.equal(hit.status, 304, `${route} did not honour a matching If-None-Match`);
        assert.equal(hit.body.length, 0, `${route} sent ${hit.body.length} bytes with a 304`);

        const stale = await on.request(route, { headers: { 'if-none-match': '"00000000000000000000000000000000"' } });
        assert.equal(stale.status, 200, `${route} answered 304 to a validator it never issued`);
        assert.ok(stale.body.length > 0, `${route} answered 200 with no body`);

        const multi = await on.request(route, { headers: { 'if-none-match': `"nope", ${etag}` } });
        assert.equal(multi.status, 304, `${route} mishandled a multi-candidate If-None-Match`);

        const weak = await on.request(route, { headers: { 'if-none-match': `W/${etag}` } });
        assert.equal(weak.status, 304, `${route} rejected a weak-form candidate for a strong validator`);

        const star = await on.request(route, { headers: { 'if-none-match': '*' } });
        assert.equal(star.status, 304, `${route} mishandled If-None-Match: *`);

        // A 304 must not describe a body it is not sending.
        assert.ok(!hit.headers['content-length'] || hit.headers['content-length'] === '0', 'a 304 carried a length');
        assert.ok(!hit.headers['content-encoding'], 'a 304 claimed an encoding for no body');
    }
});

test('CACHE-4: Last-Modified and If-Modified-Since agree with the content, and HEAD matches the 200', async () => {
    for (const route of ['/feed', '/api/v2/config']) {
        const fresh = await on.request(route);
        const lm = fresh.headers['last-modified'];
        assert.ok(lm, `${route} sends no Last-Modified`);

        const same = await on.request(route, { headers: { 'if-modified-since': lm } });
        assert.equal(same.status, 304, `${route} refetched itself at its own Last-Modified`);

        const older = await on.request(route, {
            headers: { 'if-modified-since': new Date(Date.parse(lm) - 86400000).toUTCString() }
        });
        assert.equal(older.status, 200, `${route} answered 304 for a document the client had not seen`);

        const head = await on.request(route, { method: 'HEAD' });
        assert.equal(head.status, 200, `${route} does not answer HEAD`);
        assert.equal(head.body.length, 0, `${route} HEAD sent a body`);
        assert.equal(head.headers.etag, fresh.headers.etag, `${route} HEAD disagrees with GET about the validator`);
        assert.equal(head.headers['cache-control'], fresh.headers['cache-control'], `${route} HEAD policy differs`);
    }
});

test('CACHE-5: compression is negotiated, described, and byte-exact; Vary names every input', async () => {
    for (const route of ['/feed', '/api/v2/feed']) {
        // A client that does not ask for an encoding is not handed one - Roku's `roUrlTransfer` and every
        // old store build is in that group, and an unsolicited `Content-Encoding` breaks them.
        const identity = await on.raw(route, { headers: { 'accept-encoding': 'identity' } });
        assert.ok(!identity.headers['content-encoding'], `${route} compressed a client that asked not to`);
        assert.equal(Number(identity.headers['content-length']), identity.body.length, `${route} lied about length`);

        const gz = await on.raw(route, { headers: { 'accept-encoding': 'gzip' } });
        assert.equal(gz.headers['content-encoding'], 'gzip', `${route} ignored Accept-Encoding: gzip`);
        assert.ok(
            gz.body.length < identity.body.length,
            `${route} compressed to ${gz.body.length} of ${identity.body.length}`
        );
        assert.equal(
            Number(gz.headers['content-length']),
            gz.body.length,
            `${route} Content-Length does not describe the compressed bytes`
        );
        const round = zlib.gunzipSync(gz.body);
        assert.deepEqual([...round], [...identity.body], `${route} compressed bytes are not the same document`);

        const vary = (gz.headers.vary || '').toLowerCase();
        assert.match(vary, /accept-encoding/, `${route} Vary omits Accept-Encoding: a shared cache can mix bodies`);
        assert.match(vary, /origin/, `${route} Vary omits Origin, which the CORS middleware already varies on`);

        // One content, one digest: the encoding is a transport detail, so revalidating with the digest the
        // other encoding was given must still answer 304 rather than refetch (measured: Roku sends no
        // Accept-Encoding at all, so its identity bytes have to agree with a browser's gzipped ones).
        assert.equal(gz.headers.etag, identity.headers.etag, `${route} encodings disagree about the digest`);
        const revalidated = await on.raw(route, {
            headers: { 'if-none-match': identity.headers.etag, 'accept-encoding': 'gzip' }
        });
        assert.equal(revalidated.status, 304, `${route} does not revalidate across encodings`);
        assert.equal(revalidated.body.length, 0, 'a 304 carried bytes');
        assert.ok(!revalidated.headers['content-encoding'], 'a 304 claimed an encoding for no body');
    }

    // Small documents are not worth a second representation, and the threshold is a number we chose.
    const health = await on.raw('/api/v2/health', { headers: { 'accept-encoding': 'gzip' } });
    assert.ok(
        !health.headers['content-encoding'] || health.body.length < require('../../lib/httpCache.js').MIN_GZIP_BYTES,
        'a 30-byte health answer was compressed'
    );
});

test('CACHE-5: the compressed answer is built once per document, then handed over', async () => {
    // Measured on the example channel origin the day the cache went live: the same 1,526,322 B `/feed` answers in 2.3 ms
    // uncompressed and 37 ms compressed. Building gzip per request was fine while nobody asked for it (the
    // edge census: 27 polls in 4.6 days asked for gzip out of 22,513) and became the estate's standing cost
    // the moment the pollers learned to ask. The memo is observable on the wire as `X-Ctv-Gzip`, and this
    // assertion is deliberately order-independent - other tests in this file may have warmed the process
    // first - so what it pins is that a repeat never pays a second build, and that the bytes never change.
    const route = '/feed';
    const seen = [];
    let digest = null;
    let bytes = null;
    for (let i = 0; i < 3; i++) {
        const r = await on.raw(route, { headers: { 'accept-encoding': 'gzip' } });
        assert.equal(r.headers['content-encoding'], 'gzip', `${route} stopped compressing mid-suite`);
        seen.push(r.headers['x-ctv-gzip']);
        assert.ok(
            ['built', 'hit'].includes(r.headers['x-ctv-gzip']),
            `${route} did not report how the encoding was produced: ${r.headers['x-ctv-gzip']}`
        );
        digest = digest || r.headers.etag;
        bytes = bytes || r.body;
        assert.equal(r.headers.etag, digest, `${route} digest moved between identical encodings`);
        assert.deepEqual([...r.body], [...bytes], `${route} compressed bytes differ between polls of one document`);
    }
    assert.ok(seen.filter((s) => s === 'hit').length >= 2, `the memo never answered: ${seen.join(', ')}`);

    // ... and the other half of the claim, which the first version of this test could not distinguish from a
    // header hard-coded to 'hit' (the adversarial review proved it by replacing the value with a literal and
    // watching 18/18 stay green): somebody has to be shown `built`. `/api/v2/config` is the one document in
    // this file that no earlier test asks for compressed, so its first compressed answer is a cold build.
    // If a future test gzips it earlier, move this assertion rather than relaxing it.
    const cold = await on.raw('/api/v2/config', { headers: { 'accept-encoding': 'gzip' } });
    if (cold.body.length >= 1024) {
        assert.equal(cold.headers['x-ctv-gzip'], 'built', '/api/v2/config answered "hit" before anything built it');
        const warm = await on.raw('/api/v2/config', { headers: { 'accept-encoding': 'gzip' } });
        assert.equal(warm.headers['x-ctv-gzip'], 'hit', 'the second compressed answer rebuilt the bytes anyway');
        assert.deepEqual([...warm.body], [...cold.body], 'the memo answered with different bytes');
    } else {
        assert.ok(!cold.headers['x-ctv-gzip'], 'a document below the gzip floor was compressed anyway');
    }

    // A `HEAD` must describe the representation a `GET` with the same request headers would return (RFC 9110
    // §8.6 and §15.3.2): the review measured the first version answering `HEAD` with the identity length
    // while the `GET` would have been 275,195 B gzipped.
    for (const encoding of ['gzip', 'identity']) {
        const head = await on.raw(route, { method: 'HEAD', headers: { 'accept-encoding': encoding } });
        const get = await on.raw(route, { headers: { 'accept-encoding': encoding } });
        assert.equal(
            head.headers['content-encoding'] || '',
            get.headers['content-encoding'] || '',
            `${encoding}: HEAD and GET disagree about the encoding`
        );
        assert.equal(
            head.headers['content-length'],
            get.headers['content-length'],
            `${encoding}: HEAD advertises ${head.headers['content-length']} for a GET that carries ${get.headers['content-length']}`
        );
        assert.equal(head.body.length, 0, `${encoding}: HEAD sent a body`);
    }

    // A client that asks for nothing gets no encoding and no memo header, and a revalidation gets neither.
    const identity = await on.raw(route, { headers: { 'accept-encoding': 'identity' } });
    assert.ok(!identity.headers['x-ctv-gzip'], 'the memo header rode on an uncompressed answer');
    const revalidated = await on.raw(route, { headers: { 'accept-encoding': 'gzip', 'if-none-match': digest } });
    assert.equal(revalidated.status, 304);
    assert.ok(!revalidated.headers['x-ctv-gzip'], 'a 304 claimed a compressed body it does not have');
});
test('CACHE-2: the memoized bytes answer - a repeat request does no build work', async () => {
    const route = '/api/v2/config';
    const first = await on.request(route);
    assert.ok(
        ['miss', 'hit'].includes(first.headers['x-ctv-cache']),
        `${route} reported "${first.headers['x-ctv-cache']}" - the state header is not one of miss/hit/revalidated`
    );
    const second = await on.request(route);
    assert.equal(
        second.headers['x-ctv-cache'],
        'hit',
        `${route} rebuilt the body on a repeat request: the memo is not being used (the owner's "it's already done")`
    );
    assert.equal(second.headers.etag, first.headers.etag);
    assert.deepEqual([...second.body], [...first.body]);

    const revalidated = await on.request(route, { headers: { 'if-none-match': first.headers.etag } });
    assert.equal(revalidated.headers['x-ctv-cache'], 'revalidated', `${route} rebuilt before answering the 304`);
});

test('CACHE-10: CACHE_DISABLE turns reuse off without changing what a digest means', async () => {
    // `/feed` is the same file on both processes, so it is the honest cross-process comparison: turning the
    // cache off must not move the digest of identical content, or the outage switch is a mass invalidation.
    const legacyOn = await on.request('/feed');
    const legacyOff = await off.request('/feed');
    assert.match(
        legacyOff.headers['cache-control'] || '',
        /no-store/,
        '/feed still advertises reuse with the switch on'
    );
    assert.equal(legacyOff.headers.etag, legacyOn.headers.etag, '/feed digest moved with the cache switch');
    assert.notEqual(legacyOff.headers['x-ctv-cache'], 'hit', '/feed served from memory while disabled');
    assert.equal(legacyOff.body.length, legacyOn.body.length, 'the same file served different bytes');

    // The v2 bodies are rewritten per configured origin (`routes/v2.js#baseUrl()`), and the two processes
    // differ in port, so within each process is the honest comparison: nothing rebuilds, and nothing moves.
    for (const [name, server] of [
        ['enabled', on],
        ['disabled', off]
    ]) {
        const a = await server.request('/api/v2/feed');
        const b = await server.request('/api/v2/feed');
        assert.equal(a.headers.etag, b.headers.etag, `${name} v2 digest moved between two identical requests`);
        assert.equal(b.headers['x-ctv-cache'], name === 'disabled' ? 'no-store' : 'hit', `${name} memo state wrong`);
        assert.equal(b.headers.etag, `"${sha256(b.body)}"`, `${name} v2 ETag does not describe the body served`);
    }
    // Not offered, by design: a switch that turns validation off would make "the cache is off" mean
    // "the digest is wrong". Assert the environment variable that would do that has no effect.
    const strict = await off.request('/api/v2/config', { headers: { 'if-none-match': '"anything"' } });
    assert.equal(strict.status, 200);
});

test('CACHE-11: a config release is one document - the v2 feed and the v2 config must agree', async () => {
    const before = await on.request('/api/v2/config');
    const released = JSON.parse(before.text).config;

    const feed = await on.request('/api/v2/feed');
    const feedBody = JSON.parse(feed.text);

    // The feed must name the config it is shipping, so a client that reads the feed can tell whether its
    // cached config is the one the server is releasing. Measured on example channel 2026-11-09: the feed shipped a config
    // whose sha256 differed from the released one, with no configVersion field to detect that with.
    assert.equal(
        feedBody.configVersion,
        JSON.parse(before.text).configVersion,
        'the v2 feed does not name the configVersion it embeds'
    );
    assert.equal(
        canonical(feedBody.config),
        canonical(released),
        'the v2 feed embeds a config the release does not stand behind'
    );

    // And a release must move the feed's validator, or a caching client is truthfully told to keep the old one.
    const cfgDir = path.join(on.dir, 'channel-config.json');
    const original = readFileSync(cfgDir, 'utf8');
    const cfg = JSON.parse(original);
    cfg.content.maxRows = 7; // a field a television can see
    writeFileSync(cfgDir, JSON.stringify(cfg));
    await new Promise((done) => setTimeout(done, 1200));

    const afterCfg = await on.request('/api/v2/config');
    assert.notEqual(afterCfg.headers.etag, before.headers.etag, 'a visible config edit did not move its digest');
    const afterFeed = await on.request('/api/v2/feed');
    assert.notEqual(afterFeed.headers.etag, feed.headers.etag, 'a config release did not move the feed validator');
    assert.equal(
        canonical(JSON.parse(afterFeed.text).config),
        canonical(JSON.parse(afterCfg.text).config),
        'after the release the feed and the config still disagree'
    );
    writeFileSync(cfgDir, JSON.stringify(original));
});

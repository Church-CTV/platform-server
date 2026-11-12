import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

/**
 * Unit coverage for the pieces of `lib/httpCache.js` that a full server cannot show cheaply: which path a
 * policy is keyed on, and what the table is allowed to contain. Found by measuring the stage 2026-11-10
 * (the private evidence record stage-surface in the parent project): `/api/v2/search` answered
 * `public, no-cache` although the design says a query-dependent answer is never storable, because the table
 * carried a `/search` row its own comment contradicted and a v2 forward rewrote the path the policy was
 * looked up with.
 */

const {
    FRESHNESS_TABLE,
    DEFAULT_POLICY,
    policyFor,
    feedPolicy,
    gzipMemo,
    gzipMemoStats,
    GZIP_MEMO_MAX_ENTRIES,
    publicPath,
    orgKey,
    canonicalJson,
    contentDigest,
    bytesDigest,
    parseETagHeader,
    acceptsGzip
} = require('../../lib/httpCache');

test('CACHE-6: the org namespace comes from configuration, and identical content digests differently per org', () => {
    const saved = {
        CTV_ORG_ID: process.env.CTV_ORG_ID,
        URL: process.env.URL,
        CTV_SERVER_PROFILE: process.env.CTV_SERVER_PROFILE
    };
    const restore = () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    try {
        process.env.CTV_ORG_ID = 'org-alpha';
        delete process.env.URL;
        delete process.env.CTV_SERVER_PROFILE;
        assert.equal(orgKey(), 'org-alpha');
        const jsonAlpha = contentDigest({ a: 1, b: { c: 2 } });
        const bytesAlpha = bytesDigest(Buffer.from('identical bytes'));

        process.env.CTV_ORG_ID = 'org-beta';
        assert.notEqual(contentDigest({ a: 1, b: { c: 2 } }), jsonAlpha, 'two orgs digest identical JSON alike');
        assert.notEqual(
            bytesDigest(Buffer.from('identical bytes')),
            bytesAlpha,
            'two orgs digest identical bytes alike'
        );

        // Precedence, because it is the fact an operator needs when the origin itself moves: an explicit id
        // survives an http-to-https migration, while falling back to `URL` would rotate every digest.
        process.env.CTV_ORG_ID = 'pinned';
        process.env.URL = 'https://x.example';
        process.env.CTV_SERVER_PROFILE = '/srv/profile.json';
        assert.equal(orgKey(), 'pinned');
        delete process.env.CTV_ORG_ID;
        assert.equal(orgKey(), 'https://x.example');
        delete process.env.URL;
        assert.equal(orgKey(), '/srv/profile.json');
        delete process.env.CTV_SERVER_PROFILE;
        assert.equal(orgKey(), 'default', 'a single-org box still gets a stable namespace');

        // The namespace must not depend on anything per-boot, or every deploy is a mass invalidation.
        process.env.CTV_ORG_ID = 'org-alpha';
        assert.equal(contentDigest({ a: 1 }), contentDigest({ a: 1 }));
    } finally {
        restore();
    }
});

test('CACHE-3: no query-dependent path is in the freshness table, so it falls to the fail-closed default', () => {
    for (const key of Object.keys(FRESHNESS_TABLE)) {
        assert.ok(!/search/i.test(key), `the table names "${key}": a query is part of that representation`);
    }
    assert.equal(policyFor('/search'), 'no-store');
    assert.equal(policyFor('/api/v2/search'), 'no-store');
    assert.equal(DEFAULT_POLICY, 'no-store', 'the default is what makes an unnamed route safe');
});

test('CACHE-3: a policy is keyed on the path the client asked for, not the one the router forwarded to', () => {
    // `routes/v2.js` forwards `/search` by rewriting `req.url`; inside a mounted router `req.path` is already
    // stripped. Either way the client cached `/api/v2/search`, and that is the path whose policy applies.
    assert.equal(publicPath({ originalUrl: '/api/v2/search?q=grace', path: '/search' }), '/api/v2/search');
    assert.equal(publicPath({ originalUrl: '/feed/?x=1', path: '/' }), '/feed/');
    assert.equal(publicPath({ path: '/api/v2/config' }), '/api/v2/config');
    assert.equal(publicPath({}), '');
    assert.equal(policyFor(publicPath({ originalUrl: '/api/v2/search?q=x', path: '/search' })), 'no-store');
});

test('CACHE-3: freshness is configuration - the feed policy comes from the cache section, clamped and fail-closed', () => {
    // 0 / absent / garbage all mean "store it, always ask": the safe answer when nothing was configured.
    assert.equal(feedPolicy({}), 'public, no-cache');
    assert.equal(feedPolicy({ cache: {} }), 'public, no-cache');
    assert.equal(feedPolicy({ cache: { feedMaxAgeSeconds: 0 } }), 'public, no-cache');
    assert.equal(feedPolicy({ cache: { feedMaxAgeSeconds: 'sixty' } }), 'public, no-cache');
    assert.equal(feedPolicy({ cache: { feedMaxAgeSeconds: -30 } }), 'public, no-cache');

    assert.equal(feedPolicy({ cache: { feedMaxAgeSeconds: 120 } }), 'public, max-age=120');
    assert.equal(
        feedPolicy({ cache: { feedMaxAgeSeconds: 120, feedStaleWhileRevalidateSeconds: 30 } }),
        'public, max-age=120, stale-while-revalidate=30'
    );
    // The schema refuses an out-of-range layer before it is applied; the clamp is the second net, for a value
    // that reached us from somewhere the schema did not gate. Either way a typo cannot age a live channel.
    assert.equal(feedPolicy({ cache: { feedMaxAgeSeconds: 999999 } }), 'public, max-age=3600');
    assert.equal(
        feedPolicy({ cache: { feedMaxAgeSeconds: 300, feedStaleWhileRevalidateSeconds: 99999 } }),
        'public, max-age=300, stale-while-revalidate=600'
    );
    // A stale window without an age is meaningless, and shipping `stale-while-revalidate` alone would be a
    // header a cache cannot apply - so the age branch decides, once.
    assert.equal(feedPolicy({ cache: { feedStaleWhileRevalidateSeconds: 60 } }), 'public, no-cache');
});

test('CACHE-1: canonical JSON is key-ordered and undefined-dropping, so assembly order cannot reach a digest', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson({ x: { b: 1, a: [2, { d: 4, c: 3 }] } }), '{"x":{"a":[2,{"c":3,"d":4}],"b":1}}');
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(canonicalJson(null), 'null');
    assert.equal(contentDigest({ a: 1, b: { c: 2, d: 3 } }), contentDigest({ b: { d: 3, c: 2 }, a: 1 }));
    assert.match(contentDigest({ a: 1 }), /^[0-9a-f]{64}$/);
});

test('CACHE-4: the conditional-request headers are parsed the way RFC 9110 writes them', () => {
    assert.deepEqual(parseETagHeader('"abc"'), [{ weak: false, value: '"abc"' }]);
    assert.deepEqual(parseETagHeader('W/"abc"'), [{ weak: true, value: '"abc"' }]);
    const many = parseETagHeader('"one", W/"two", "three"');
    assert.equal(many.length, 3);
    assert.equal(many[1].weak, true);
    assert.equal(many[2].value, '"three"');
    assert.deepEqual(parseETagHeader(undefined), []);
    assert.deepEqual(parseETagHeader(''), []);
});

test('CACHE-5: gzip is only offered by a client that can read it, and `q=0` is not an offer', () => {
    // RFC 9110 §12.5.3: a coding marked `q=0` is explicitly rejected. The first version of `acceptsGzip`
    // looked for the token and nothing else, so `Accept-Encoding: gzip;q=0` was served gzip anyway - found
    // by the adversarial review of 2026-11-10 with a direct probe.
    assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'gzip;q=0' } }), false);
    assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'gzip;q=0.0, br' } }), false);
    assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'gzip;q=0.5' } }), true);
    assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'deflate, gzip;q=1.0' } }), true);
    assert.equal(acceptsGzip({ headers: { 'accept-encoding': '*;q=0, gzip' } }), true);
    assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'gzip, deflate, br' } }), true);
    assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'x-gzip' } }), true);
    assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'br' } }), false);
    assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'gzipz' } }), false);
    assert.equal(acceptsGzip({ headers: {} }), false);
});

test('CACHE-5: the compressed form is a representation, so it is built once per document, not once per poll', () => {
    // Measured on the example channel origin after the cache went live: an uncompressed `/feed` answers in 2.3 ms and a
    // gzip answer takes 37 ms for the same 1,526,322 B. The moment the pollers learn to ask for compression -
    // and the edge census says three of them are 99.5 % of the bytes - that 35 ms stops being one request's
    // cost and becomes the estate's per-poll cost. Memoising the compressed bytes by the same digest that
    // names the representation is the whole fix.
    const bytes = Buffer.from(JSON.stringify({ rows: 'x'.repeat(40000) }));
    const digest = bytesDigest(bytes);

    const first = gzipMemo(bytes, digest);
    assert.equal(first.state, 'stored');
    assert.ok(Buffer.isBuffer(first.buffer) && first.buffer.length < bytes.length);

    const second = gzipMemo(bytes, digest);
    assert.equal(second.state, 'hit');
    assert.deepEqual(second.buffer, first.buffer, 'a memoised answer must be byte-identical to built one');

    const stats = gzipMemoStats();
    assert.ok(stats.entries >= 1);
    assert.ok(stats.hits >= 1);
});

test('CACHE-5: the memo keys on the digest, never on anything as weak as length', () => {
    // Two documents of identical length and different content must not answer for each other - that is the
    // same class of bug as a clock-based ETag, and a length-keyed memo would reproduce it silently.
    const a = Buffer.from(`{"v":"${'a'.repeat(40000)}"}`);
    const b = Buffer.from(`{"v":"${'b'.repeat(40000)}"}`);
    assert.equal(a.length, b.length, 'the fixture only tests what it claims if the lengths really match');

    const da = bytesDigest(a);
    const db = bytesDigest(b);
    const ra = gzipMemo(a, da);
    const rb = gzipMemo(b, db);
    assert.equal(rb.state, 'stored', 'a second document must not be served from the first one memo');
    assert.notDeepEqual(ra.buffer, rb.buffer);
});

test('CACHE-5: the memo is bounded, and a document that does not pay for gzip keeps a remembered verdict', () => {
    // Measured here rather than assumed: `crypto.randomBytes(20000)` gzips to 20,028 B, so gzip genuinely
    // costs bytes on that payload; a 60 KB run of one character gzips to 108 B. An evicting memo cannot grow
    // the heap with the feed population, and the "not worth it" verdict has to be remembered too, or every
    // poll of an incompressible document pays the attempt again.
    const incompressible = crypto.randomBytes(20000);
    const d = bytesDigest(incompressible);
    const first = gzipMemo(incompressible, d);
    assert.equal(first.state, 'stored');
    assert.equal(first.buffer, null, 'gzip that costs bytes is not a representation worth sending');

    const again = gzipMemo(incompressible, d);
    assert.equal(again.state, 'hit', 'the verdict itself is memoised, not just the successful compression');
    assert.equal(again.buffer, null);
    assert.ok(gzipMemoStats().skipped >= 1);

    for (let i = 0; i < 14; i++) {
        const doc = Buffer.concat([crypto.randomBytes(20000), Buffer.from(`row-${i}`)]);
        gzipMemo(doc, bytesDigest(doc));
    }
    const stats = gzipMemoStats();
    assert.ok(
        stats.entries <= GZIP_MEMO_MAX_ENTRIES,
        `memo grew to ${stats.entries} entries, max ${GZIP_MEMO_MAX_ENTRIES}`
    );
    assert.ok(stats.evictions >= 1, 'a memo that never evicts is a slow leak with a name');
});

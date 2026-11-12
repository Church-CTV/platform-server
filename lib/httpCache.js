/**
 * The cache layer for everything a television, a monitor or a browser reads (2026-11-09).
 *
 * Design of record: `CACHE-DESIGN-2026-11-09.md` (ACCEPTED [owner 2026-11-09]); the measurement that
 * sized it: the private record t2-feed-cache-surface-2026-11-09. Both live origins were already answering
 * `304 0 B` to a matching `If-None-Match` (3 ms against the `200`'s 79 ms p50), and almost nobody asked:
 * 207 of 46,426 requests in a 3.9-day edge window, `GET /feed` = 99.1 % of all bytes served, no path
 * sending a `Cache-Control` at all, nothing compressed, and every request - including a `304` - re-reading,
 * re-parsing, re-validating and re-serializing the whole document.
 *
 * Four rules make that safe, and each one is tested in `tests/integration/test-cache-surface.mjs`:
 *  - `CACHE-1` a validator is a content digest (`CACHE-1`'s canonical form below), never a clock, never a
 *    file mtime, and for a JSON representation it is the digest of the canonical form of the body served;
 *  - `CACHE-2` the built bytes are memoized against the inputs they were built from, so a repeat request
 *    does no read/parse/validate work at all - that is the half of the owner's request ("it's already
 *    done") the old code never delivered;
 *  - `CACHE-3`/`CACHE-9` the freshness policy is in the table below, and **a path the table does not name
 *    is `no-store`**: the fail-closed default the project contract requires, so a new route cannot become
 *    cacheable by accident;
 *  - `CACHE-10` `CACHE_DISABLE=true` turns reuse off and advertises `no-store`, but changes nothing about
 *    what a digest means: the same content keeps the same validator with the cache off, because an outage
 *    switch that invalidates every client on earth is a second outage;
 *  - `CACHE-6` a digest names the organization it belongs to, and every storable response says so in `Vary`.
 *    Two orgs can publish byte-identical documents, and an org-agnostic validator plus a cache that keys on
 *    path alone lets one org's `304` answer the other's question. Measured in
 *    `tests/integration/test-cache-org-isolation.mjs`.
 *
 * Deliberately not here: `CACHE_VALIDATE=false` (turning validation off would make "the cache is off"
 * mean "the digest is wrong"), and any edge/CDN cache (`CACHE-6` is a precondition for that).
 */

const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

// Below this, gzip costs more than it saves and adds a second representation to reason about.
const MIN_GZIP_BYTES = Number.parseInt(process.env.CTV_CACHE_MIN_GZIP_BYTES || '1024', 10);

/**
 * `CACHE-3` one table, every public read path, and `no-store` for anything not named here.
 * `no-cache` means "store it, but always ask" - which is cheap now that asking costs 3 ms and 0 bytes.
 */
const FRESHNESS_TABLE = {
    '/feed': 'public, no-cache',
    '/feed/': 'public, no-cache',
    '/api/v2/feed': 'public, no-cache',
    '/api/v2/config': 'public, no-cache',
    // Query-dependent answers (`/search`, `/api/v2/search`) are deliberately absent from the table: the
    // query is part of the representation, and until it is part of the cache key they take the default
    // `no-store`. A shared cache that keyed on path alone would serve one query's hits to another. `/search`
    // was in this table as `public, no-cache` until 2026-11-10, which contradicted this very comment and was
    // visible on the stage as `/api/v2/search` answering `public, no-cache`; the row is gone rather than
    // changed, so the comment and the table now say the same thing.

    // Liveness is never stale: a cached "ok" is not evidence. Monitors get a cheap `304` instead of an age.
    '/api/v2/health': 'public, no-cache',
    '/privacy': 'public, max-age=300, stale-while-revalidate=60',
    // Generated art at a fixed name is revalidated, not aged (`CACHE-3`): the measured `MC-Live.png` had
    // not changed since 2025-12-21 and was pulled whole 1,023 times in 3.9 days.
    '/output/thumbnails': 'public, no-cache',
    // `CACHE-9`: the operator's own surface and the liveness ping are never cacheable. A cached heartbeat
    // is a lie about liveness; a cached operator page is a stale decision behind a login.
    '/api/heartbeat': 'no-store',
    '/api/analytics': 'no-store',
    '/api/v1/analytics': 'no-store'
};

const DEFAULT_POLICY = 'no-store';

function cacheDisabled() {
    return process.env.CACHE_DISABLE === 'true';
}

function policyFor(pathname) {
    if (cacheDisabled()) return 'no-store';
    const exact = FRESHNESS_TABLE[pathname];
    if (exact) return exact;
    for (const [prefix, policy] of Object.entries(FRESHNESS_TABLE)) {
        if (pathname === prefix || pathname.startsWith(prefix + '/')) return policy;
    }
    return DEFAULT_POLICY;
}

/**
 * `CACHE-6`: whose document is this? Two deployments can publish identical bytes, so bytes alone cannot tell
 * a cache that one org's `304` must not answer another org's request. The identity is configuration, in a
 * fixed order of preference: an explicit `CTV_ORG_ID` (the one an operator pins when the origin itself moves,
 * e.g. an http-to-https migration, so the estate is not force-refetched for a cosmetic URL change), then the
 * public `URL`, then the server profile path, then `default` for a single-org box.
 *
 * It must not contain anything that changes on restart: a per-boot value would rotate every digest in the
 * estate on each deploy, which is the mass-invalidation failure `CACHE-10` exists to avoid.
 */
function orgKey() {
    return process.env.CTV_ORG_ID || process.env.URL || process.env.CTV_SERVER_PROFILE || 'default';
}

/**
 * `CACHE-1`: canonical JSON - sorted keys at every level, so assembly order can never leak into a digest, and
 * keys whose value is `undefined` or a function dropped, exactly as `JSON.stringify` (and therefore `res.json`)
 * drops them. Without the second half, `{a: undefined, b: 1}` and `{b: 1}` would digest differently while
 * serialising to identical bytes, which is the one thing a content digest may not do.
 */
function canonicalJson(value) {
    if (value === null || value === undefined) return JSON.stringify(null);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (typeof value !== 'object') return JSON.stringify(value);
    return `{${Object.keys(value)
        .filter((key) => value[key] !== undefined && typeof value[key] !== 'function')
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(',')}}`;
}

function sha256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Digest of an object in canonical form, scoped to the org (`CACHE-1` + `CACHE-6`): the same content in the
 * same deployment always digests the same, whatever order built it, and the same content in another
 * deployment never does.
 */
function contentDigest(value) {
    return sha256(`${orgKey()}\n${canonicalJson(value)}`);
}

/**
 * Digest of exact bytes - the legacy published format is a file, so its validator describes those bytes -
 * also scoped to the org, so two orgs shipping the identical file cannot answer for each other.
 */
function bytesDigest(buffer) {
    return sha256(Buffer.concat([Buffer.from(`${orgKey()}\n`, 'utf8'), buffer]));
}

// ---- the memo -------------------------------------------------------------------------------
// Keyed by (what is being represented, the fingerprint of every input that can change its bytes).
// A stale key must be impossible, not merely unlikely (`CACHE-2`), so the fingerprint is computed from
// the sources on every request - a stat is cheap, a 1.5 MB read/parse/validate/Ajv pass is not.
const memo = new Map();

function fingerprintFiles(...paths) {
    const parts = [];
    for (const target of paths) {
        if (!target) continue;
        try {
            const stats = fs.statSync(target);
            parts.push(`${target}:${stats.mtimeMs}:${stats.size}:${stats.ino}`);
        } catch {
            parts.push(`${target}:absent`);
        }
    }
    // The configured origin is an input: `routes/v2.js#baseUrl()` rewrites endpoint URLs from `URL`, so a
    // restarted process with a different `URL` must not be served the previous body.
    parts.push(`url:${process.env.URL || ''}`);
    parts.push(`profile:${process.env.CTV_SERVER_PROFILE || ''}`);
    return parts.join('|');
}

/**
 * `CACHE-2`. `build()` is only run when the inputs changed (or nothing is memoized yet).
 * Returns `{ value, state }` where state is `hit` (nothing rebuilt), `miss` (built now) or
 * `disabled` (built now, and deliberately not remembered).
 */
function memoized(key, fingerprint, build) {
    if (cacheDisabled()) return { value: build(), state: 'disabled' };
    const entry = memo.get(key);
    if (entry && entry.fingerprint === fingerprint) return { value: entry.value, state: 'hit' };
    const value = build();
    memo.set(key, { fingerprint, value });
    return { value, state: 'miss' };
}

/**
 * `CACHE-3` as tenant configuration: how long a published feed may be reused before the client asks again.
 *
 * The value comes from the deployment layers (the server profile's `clientConfig` and the operator store the
 * admin panel writes), deliberately not from the `config` block embedded in a published feed: a freshness
 * policy that lives inside a published document cannot be changed without republishing the document, which is
 * the exact release bug this design exists to remove. An operator setting it in the panel therefore reaches
 * `/feed` on the next request, with no rebuild and no restart.
 *
 * `0` (the default) means `public, no-cache`: store the copy, always ask. That is the safe product answer - a
 * television sees what the channel published, not what it remembered - and it is cheap here because asking now
 * costs one comparison at the origin and ships zero bytes when nothing changed. A tenant opts into an age when
 * polling itself, rather than bytes, is the expense, and accepts up to that many seconds of lateness.
 *
 * Values are clamped, not trusted. The schema refuses an out-of-range layer before it is ever applied, so a
 * clamp here only fires if a value arrived from somewhere the schema did not gate (an older profile, a
 * hand-edited file), and "somewhere the schema did not gate" is precisely where a live channel ends up with a
 * 30-day stale feed.
 */
const MAX_FEED_MAX_AGE_SECONDS = 3600;
const MAX_STALE_WHILE_REVALIDATE_SECONDS = 600;

function clampInt(value, min, max) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

function feedPolicy(config) {
    const cache = (config && config.cache) || {};
    const maxAge = clampInt(cache.feedMaxAgeSeconds, 0, MAX_FEED_MAX_AGE_SECONDS);
    if (maxAge === 0) return 'public, no-cache';
    const swr = clampInt(cache.feedStaleWhileRevalidateSeconds, 0, MAX_STALE_WHILE_REVALIDATE_SECONDS);
    return swr > 0 ? `public, max-age=${maxAge}, stale-while-revalidate=${swr}` : `public, max-age=${maxAge}`;
}

/** Drop one representation (a publish, an upload, a config save) rather than the whole memo. */
function invalidate(keyPrefix) {
    for (const key of [...memo.keys()]) {
        if (!keyPrefix || key.startsWith(keyPrefix)) memo.delete(key);
    }
}

// ---- the response ---------------------------------------------------------------------------

function parseETagHeader(value) {
    return String(value || '')
        .split(',')
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .map((candidate) => ({ weak: /^W\//i.test(candidate), value: candidate.replace(/^W\//i, '') }));
}

function acceptsGzip(req) {
    const header = String((req && req.headers && req.headers['accept-encoding']) || '');
    if (!header) return false;
    // RFC 9110 §12.5.3: a coding carrying `q=0` is explicitly rejected, and the first version of this
    // function matched the token and nothing else, so `Accept-Encoding: gzip;q=0` was served gzip. Tokens
    // are compared case-insensitively, `x-gzip` is the obsolete spelling of the same coding, and a `*`
    // wildcard never stands in for a client that named gzip and rejected it.
    for (const entry of header.split(',')) {
        const parts = entry.trim().split(';');
        const token = (parts[0] || '').trim().toLowerCase();
        if (token !== 'gzip' && token !== 'x-gzip') continue;
        let q = 1;
        for (const param of parts.slice(1)) {
            const m = /^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/.exec(param);
            if (m) q = Number.parseFloat(m[1]);
        }
        if (!Number.isNaN(q) && q > 0) return true;
    }
    return false;
}

/**
 * `CACHE-6`: name the hostname as a cache-key input, exactly once, on anything storable. `res.append` would
 * happily write `Vary: Origin, Accept-Encoding, Host, Host` on the second call, so the check is against the
 * header that is already there, case-insensitively.
 */
function addOrgVary(res) {
    const current = res.getHeader('Vary');
    const existing = (Array.isArray(current) ? current : [current || ''])
        .join(',')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    if (!existing.includes('host')) res.append('Vary', 'Host');
}

/**
 * The path the client asked for, which is not always the path the code is running. Inside a mounted router
 * `req.path` has the mount stripped, and `routes/v2.js` additionally rewrites `req.url` when it forwards to a
 * legacy handler, so neither is safe to key a policy on: an internal forward would otherwise decide what a
 * client - or a shared cache - is allowed to store. Express keeps the arriving URL in `req.originalUrl`, and
 * that is the path being cached.
 */
function publicPath(req) {
    const raw = req.originalUrl || req.url || req.path || '';
    const q = raw.indexOf('?');
    return q === -1 ? raw : raw.slice(0, q);
}

/**
 * Serve one representation of one body: headers, conditional handling, encoding negotiation, HEAD.
 * `representation` = { digest, json?, bytes?, lastModified? }; `options` = { state, policyPath?, contentType? },
 * where `policyPath` is the table key to apply (a v2 route passes its own public path; otherwise
 * `publicPath(req)` is used).
 */

// ---------------------------------------------------------------------------
// The compressed form is a representation, so it gets memoised like one.
//
// Filed measurement, both origins, 2026-11-10 (the private evidence record probe-origin-latency-loopback
// in the ctv project, n=25 per row): the example channel origin answers an identity `/feed` (1,526,322 B) at p50 2.1 ms and
// a gzipped one (275,195 B) at p50 37.8 ms; example channel answers 162,563 B at 1.9 ms and 19,324 B at 3.6 ms, and a
// matching validator on either box at p50 1.5 ms. That is a good trade once per document and a bad one once per poll, and
// the edge census (2026-11-10, the private evidence record edge-census-v2) says three pollers are
// 99.5 % of the bytes - so the moment those pollers learn to ask for gzip, per-request compression becomes
// the estate's standing cost. Keyed by the same content digest that names the representation, so it cannot
// confuse two documents the way a length-keyed cache would, and bounded so the feed population cannot grow
// the heap. A "not worth compressing" verdict is remembered too, or every poll of an incompressible document
// pays the attempt. This memo is not a reuse policy: it changes how the bytes were produced, never which
// bytes or which digest go on the wire, so `CACHE_DISABLE` leaves it alone.
// ---------------------------------------------------------------------------

const GZIP_MEMO_MAX_ENTRIES = 8;
const gzipMemoEntries = new Map(); // digest -> { buffer: Buffer | null }
const gzipMemoCounters = { hits: 0, stored: 0, skipped: 0, evictions: 0 };

function gzipMemo(raw, digest) {
    if (!digest) return { buffer: zlib.gzipSync(raw, { level: 6 }), state: 'unkeyed' };
    const found = gzipMemoEntries.get(digest);
    if (found) {
        gzipMemoCounters.hits += 1;
        return { buffer: found.buffer, state: 'hit' };
    }
    const gzipped = zlib.gzipSync(raw, { level: 6 });
    const worthIt = gzipped.length < raw.length;
    const buffer = worthIt ? gzipped : null;
    gzipMemoEntries.set(digest, { buffer });
    gzipMemoCounters.stored += 1;
    if (!worthIt) gzipMemoCounters.skipped += 1;
    while (gzipMemoEntries.size > GZIP_MEMO_MAX_ENTRIES) {
        // Insertion order, oldest first - FIFO, not LRU: `Map.get` does not refresh position, so a document
        // that stays hot eventually still gets evicted and simply rebuilds. That is safe by construction (a
        // miss costs one compression and returns byte-identical output), and it is the right trade while one
        // process serves three live documents; if this path ever carries more than eight hot representations
        // - query-scoped ones, say - the memo will thrash and the fix is a bigger bound, not a lie here.
        const oldest = gzipMemoEntries.keys().next();
        if (oldest.done) break;
        gzipMemoEntries.delete(oldest.value);
        gzipMemoCounters.evictions += 1;
    }
    return { buffer, state: 'stored' };
}

function gzipMemoStats() {
    return {
        entries: gzipMemoEntries.size,
        maxEntries: GZIP_MEMO_MAX_ENTRIES,
        ...gzipMemoCounters
    };
}

function sendRepresentation(req, res, representation, { state, policyPath, policy, contentType = 'application/json' }) {
    const { digest, json, bytes, lastModified } = representation;
    const etag = `"${digest}"`;
    const pathname = policyPath === undefined ? publicPath(req) : policyPath;

    // A tenant-configured freshness value (`feedPolicy`) wins over the table; the table still answers for
    // every path nobody configured, and the default for an unnamed path stays `no-store`. The outage switch
    // outranks both: `CACHE_DISABLE=true` must put a configured `max-age` back to `no-store` as well, or
    // turning the cache off would leave tenants on the reuse policy they just asked us to stop using.
    res.set('Cache-Control', cacheDisabled() ? 'no-store' : policy || policyFor(pathname));
    res.set('ETag', etag);
    if (lastModified) res.set('Last-Modified', new Date(lastModified).toUTCString());
    // `CACHE-5`: every input that can change the bytes we are choosing to send is named. `Vary: Origin`
    // is already set by the CORS middleware; Accept-Encoding is what this layer negotiates, and Host is the
    // organization the bytes belong to (`CACHE-6`).
    res.append('Vary', 'Accept-Encoding');
    addOrgVary(res);

    // RFC 9110: a matching `If-None-Match` wins over `If-Modified-Since`, and a non-matching one means
    // the full body is sent - the two conditions are never combined into one answer.
    const candidates = parseETagHeader(req.headers['if-none-match']);
    if (candidates.length) {
        const matched = candidates.some((candidate) => candidate.value === '*' || candidate.value === etag);
        if (matched && (req.method === 'GET' || req.method === 'HEAD')) {
            res.set('X-Ctv-Cache', 'revalidated');
            return res.status(304).end();
        }
    } else if (req.headers['if-modified-since'] && lastModified && (req.method === 'GET' || req.method === 'HEAD')) {
        const since = Date.parse(req.headers['if-modified-since']);
        // The header is second-precise, so compare against the same second the header can express.
        if (!Number.isNaN(since) && since >= Math.floor(new Date(lastModified).getTime() / 1000) * 1000) {
            res.set('X-Ctv-Cache', 'revalidated');
            return res.status(304).end();
        }
    }

    res.set('X-Ctv-Cache', state === 'hit' ? 'hit' : state === 'disabled' ? 'no-store' : 'miss');

    const raw = bytes !== undefined ? bytes : Buffer.from(json, 'utf8');
    res.set('Content-Type', contentType);
    if (req.method === 'HEAD') {
        // RFC 9110 §8.6 / §15.3.2: a `HEAD` response must carry the field lines the corresponding `GET`
        // would carry, including `Content-Encoding` and a `Content-Length` that describes the negotiated
        // representation. Serving the identity length to a client that offered gzip advertised 1,526,322 B
        // for a body that would have been 275,195 B - measured by the adversarial review of 2026-11-10 and
        // the reason this branch consults the memo instead of shrugging.
        let described = raw;
        if (acceptsGzip(req) && raw.length >= MIN_GZIP_BYTES) {
            const { buffer: gzipped, state: gzipState } = gzipMemo(raw, digest);
            if (gzipped) {
                res.set('X-Ctv-Gzip', gzipState === 'hit' ? 'hit' : 'built');
                res.set('Content-Encoding', 'gzip');
                described = gzipped;
            }
        }
        res.set('Content-Length', String(described.length));
        return res.status(200).end();
    }

    if (acceptsGzip(req) && raw.length >= MIN_GZIP_BYTES) {
        const { buffer: gzipped, state: gzipState } = gzipMemo(raw, digest);
        if (gzipped) {
            // `X-Ctv-Gzip` is operational telemetry, not cache semantics: it says whether this response's
            // compressed bytes were built here or handed over from the memo, which is the only way to prove
            // on the public wire that the memo is doing its job. It never takes part in a digest or a
            // validator, and it is absent when there is no compressed representation.
            res.set('X-Ctv-Gzip', gzipState === 'hit' ? 'hit' : 'built');
            res.set('Content-Encoding', 'gzip');
            res.set('Content-Length', String(gzipped.length));
            return res.status(200).end(gzipped);
        }
    }
    res.set('Content-Length', String(raw.length));
    return res.status(200).end(raw);
}

module.exports = {
    FRESHNESS_TABLE,
    gzipMemo,
    gzipMemoStats,
    GZIP_MEMO_MAX_ENTRIES,
    DEFAULT_POLICY,
    MIN_GZIP_BYTES,
    MAX_FEED_MAX_AGE_SECONDS,
    MAX_STALE_WHILE_REVALIDATE_SECONDS,
    cacheDisabled,
    policyFor,
    feedPolicy,
    orgKey,
    canonicalJson,
    contentDigest,
    bytesDigest,
    sha256,
    fingerprintFiles,
    memoized,
    invalidate,
    sendRepresentation,
    publicPath,
    addOrgVary,
    acceptsGzip,
    parseETagHeader
};

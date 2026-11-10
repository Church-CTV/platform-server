import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const FEED_PATH = path.join(process.cwd(), 'output', 'roku_feed.json');
const FEED_BACKUP = FEED_PATH + '.bak';
const TEST_FEED_PATH = path.join(process.cwd(), 'output', 'test_feed.json');
const TEST_FEED_BACKUP = TEST_FEED_PATH + '.test_backup';

function saveFeed() {
    if (fs.existsSync(FEED_PATH)) {
        fs.copyFileSync(FEED_PATH, FEED_BACKUP);
    }
    // Also back up the test feed (the real feed the Roku uses)
    if (fs.existsSync(TEST_FEED_PATH)) {
        fs.copyFileSync(TEST_FEED_PATH, TEST_FEED_BACKUP);
    }
}

function restoreFeed() {
    if (fs.existsSync(FEED_BACKUP)) {
        fs.copyFileSync(FEED_BACKUP, FEED_PATH);
    }
    // Restore the real test feed that the Roku channel depends on
    if (fs.existsSync(TEST_FEED_BACKUP)) {
        fs.copyFileSync(TEST_FEED_BACKUP, TEST_FEED_PATH);
    }
    // Clean up backup files
    if (fs.existsSync(FEED_BACKUP)) {
        fs.rmSync(FEED_BACKUP);
    }
    if (fs.existsSync(TEST_FEED_BACKUP)) {
        fs.rmSync(TEST_FEED_BACKUP);
    }
}

describe('feed route', () => {
    let feedRouter;

    before(() => {
        saveFeed();
        // Ensure output directory exists
        const OUTPUT_DIR = path.join(process.cwd(), 'output');
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }
        // Clear require cache to get fresh router instance
        delete require.cache[require.resolve('../../routes/feed')];
        feedRouter = require('../../routes/feed');
    });

    after(() => {
        restoreFeed();
    });

    /**
     * The slice of Express' `res` the cache layer touches: `set`, `append`, `status`, `end(payload)`, `get`.
     * A mock this thin is only acceptable because the real-HTTP coverage of the same contract lives in
     * `tests/integration/test-cache-surface.mjs` (four server processes, real sockets, gzip, HEAD, 304);
     * what is pinned here is the *legacy route's* shape - the published Roku lineages still call `/feed`
     * with nothing but `If-Modified-Since`, so that path must keep answering them whether or not they ever
     * learn about `ETag`. `tests/unit/AGENTS.md`'s rule: a unit test may assert a shape, a contract claim
     * belongs to the integration suite.
     */
    function fakeRes(headers = {}, method = 'GET') {
        const res = {
            statusCode: null,
            body: null,
            setHeaders: {},
            set(key, value) {
                this.setHeaders[key] = value;
                return this;
            },
            append(key, value) {
                const prior = this.setHeaders[key];
                this.setHeaders[key] = prior ? `${prior}, ${value}` : value;
                return this;
            },
            get(key) {
                return this.setHeaders[key];
            },
            // `http.ServerResponse#getHeader`, which `lib/httpCache.js#addOrgVary()` reads before deciding to
            // add `Vary: Host`. A real response looks the header up case-insensitively, so the fake must too -
            // otherwise the cache layer looks broken in a unit test while working on a wire.
            getHeader(key) {
                const wanted = String(key).toLowerCase();
                for (const [name, value] of Object.entries(this.setHeaders)) {
                    if (name.toLowerCase() === wanted) return value;
                }
                return undefined;
            },
            getHeaders() {
                return { ...this.setHeaders };
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            end(payload) {
                this.body = payload === undefined ? null : Buffer.from(payload);
                return this;
            },
            json(data) {
                this.jsonData = data;
                this.body = Buffer.from(JSON.stringify(data));
                return this;
            }
        };
        return {
            req: { method, path: '/feed', originalUrl: '/feed', headers, socket: { remoteAddress: '127.0.0.1' } },
            res
        };
    }

    it('returns 200 with the published bytes, a validator and a stated freshness policy', async () => {
        fs.writeFileSync(FEED_PATH, JSON.stringify({ providerName: 'Test', lastUpdated: new Date().toISOString() }));

        const { req, res } = fakeRes();
        await feedRouter.stack[0].route.stack[1].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
        assert.ok(JSON.parse(res.body.toString()).providerName);
        assert.ok(res.setHeaders.ETag);
        assert.ok(res.setHeaders['Last-Modified']);
        // Measured on both live origins 2026-11-09: `/feed` sent no Cache-Control at all, leaving every
        // strict client on heuristic freshness. A policy is now stated, not guessed.
        assert.strictEqual(res.setHeaders['Cache-Control'], 'public, no-cache');
        // `CACHE-5` + `CACHE-6`: the inputs that can change these bytes are named, including the hostname, so
        // a shared cache in front of two organizations is told not to merge them.
        const vary = String(res.setHeaders.Vary || '')
            .split(',')
            .map((v) => v.trim().toLowerCase());
        assert.ok(vary.includes('accept-encoding'), 'Vary does not name Accept-Encoding');
        assert.ok(vary.includes('host'), `Vary="${res.setHeaders.Vary}" does not name Host`);
        assert.strictEqual(vary.filter((v) => v === 'host').length, 1, 'Host named twice');
    });

    it('returns an ETag that is a strong digest of the bytes it ships', async () => {
        const raw = JSON.stringify({ test: 'data' });
        fs.writeFileSync(FEED_PATH, raw);

        const { req, res } = fakeRes();
        await feedRouter.stack[0].route.stack[1].handle(req, res, () => {});

        // `CACHE-1`: the validator used to be an MD5 of whatever the route had just read. It is now the
        // sha256 of the exact bytes on the wire, so a client can prove the body matches the validator, and
        // no validator in this product is built on MD5 anymore.
        assert.match(res.setHeaders.ETag, /^"[0-9a-f]{64}"$/);
        // Org-scoped like every validator in this product (`CACHE-6`): the namespace is part of what the
        // digest means, so a neighbour publishing identical bytes cannot answer for us. Recomputed from
        // `orgKey()` rather than hardcoded, because the namespace is configuration, not a constant.
        const { orgKey } = require('../../lib/httpCache');
        const expected = require('crypto')
            .createHash('sha256')
            .update(Buffer.concat([Buffer.from(`${orgKey()}\n`, 'utf8'), res.body]))
            .digest('hex');
        assert.strictEqual(res.setHeaders.ETag, `"${expected}"`, 'the ETag does not describe the served bytes');
    });

    it("ships the compact serialization, so the file's formatting never reaches the wire or a bill", async () => {
        // Measured on the example channel origin 2026-11-10, at the first minute of the new build: the published file
        // on disk is pretty-printed (214,494 B) while the build that was serving it shipped the compact form
        // (162,563 B) - byte for byte the same document, 32 % more on the endpoint the estate polls most, and
        // the published Roku clients do not ask for gzip. Indentation is a property of a file, not of a
        // document, so it must not survive into the representation.
        const doc = {
            providerName: 'Test',
            lastUpdated: '2026-11-08T10:30:55.737Z',
            November2026: [{ title: 'x', content: { videos: [{ url: '/stream/x.mp4' }] } }],
            'November 2026': [{ title: 'x', content: { videos: [{ url: '/stream/x.mp4' }] } }]
        };
        fs.writeFileSync(FEED_PATH, JSON.stringify(doc, null, 2));

        const { req, res } = fakeRes();
        await feedRouter.stack[0].route.stack[1].handle(req, res, () => {});

        const served = res.body.toString('utf8');
        assert.ok(!served.includes('\n'), "the file's indentation reached the published feed");
        assert.equal(served, JSON.stringify(doc), 'the served body is not the compact serialization of the document');
        assert.ok(
            res.body.length < fs.statSync(FEED_PATH).size,
            'a poll now costs more than it did because the file on disk is pretty-printed'
        );
        const { orgKey } = require('../../lib/httpCache');
        const expected = require('crypto')
            .createHash('sha256')
            .update(Buffer.concat([Buffer.from(`${orgKey()}\n`, 'utf8'), res.body]))
            .digest('hex');
        assert.strictEqual(
            res.setHeaders.ETag,
            `"${expected}"`,
            'the validator must describe the bytes served, not the file read'
        );
    });

    it('serves a document it cannot parse verbatim, and still digests what it shipped', async () => {
        // Fail-open on the byte path, fail-closed on the validator claim: an unparseable published file is
        // still someone's feed, and the ETag must still describe the bytes on the wire.
        const raw = '{"providerName": "Test", oops';
        fs.writeFileSync(FEED_PATH, raw);

        const { req, res } = fakeRes();
        await feedRouter.stack[0].route.stack[1].handle(req, res, () => {});

        assert.strictEqual(res.body.toString('utf8'), raw);
        assert.match(res.setHeaders.ETag, /^"[0-9a-f]{64}"$/, 'an unparseable feed lost its content validator');
    });

    it('still answers 304 to If-Modified-Since, which is all the published Roku lineages send', async () => {
        fs.writeFileSync(FEED_PATH, JSON.stringify({ test: 'data' }));
        const stats = fs.statSync(FEED_PATH);
        const lastModified = new Date(stats.mtime).toUTCString();

        const { req, res } = fakeRes({ 'if-modified-since': lastModified });
        await feedRouter.stack[0].route.stack[1].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 304);
        assert.strictEqual(res.body, null, 'a 304 carried a body');
    });

    it('answers 304 to a matching If-None-Match, and 200 to one it never issued', async () => {
        fs.writeFileSync(FEED_PATH, JSON.stringify({ test: 'data' }));

        const first = fakeRes();
        await feedRouter.stack[0].route.stack[1].handle(first.req, first.res, () => {});
        assert.strictEqual(first.res.statusCode, 200);

        const hit = fakeRes({ 'if-none-match': first.res.setHeaders.ETag });
        await feedRouter.stack[0].route.stack[1].handle(hit.req, hit.res, () => {});
        assert.strictEqual(hit.res.statusCode, 304);
        assert.strictEqual(hit.res.body, null);

        const stale = fakeRes({
            'if-none-match': '"0000000000000000000000000000000000000000000000000000000000000000"'
        });
        await feedRouter.stack[0].route.stack[1].handle(stale.req, stale.res, () => {});
        assert.strictEqual(stale.res.statusCode, 200);
        assert.ok(stale.res.body.length > 0, 'a 200 with no body is not a feed');
    });

    it('returns 200 when If-Modified-Since is older than file mtime', async () => {
        fs.writeFileSync(FEED_PATH, JSON.stringify({ test: 'data' }));
        const stats = fs.statSync(FEED_PATH);
        const oldDate = new Date(stats.mtime.getTime() - 3600000).toUTCString();

        const { req, res } = fakeRes({ 'if-modified-since': oldDate });
        await feedRouter.stack[0].route.stack[1].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
    });

    it('returns Last-Modified from file mtime, at the second precision the header can carry', async () => {
        fs.writeFileSync(FEED_PATH, JSON.stringify({ test: 'data' }));
        const stats = fs.statSync(FEED_PATH);

        const { req, res } = fakeRes();
        await feedRouter.stack[0].route.stack[1].handle(req, res, () => {});

        const served = new Date(res.setHeaders['Last-Modified']);
        assert.ok(!Number.isNaN(served.getTime()), 'Last-Modified is not a date');
        // `CACHE-1` says freshness comes from content, but this representation *is* a file, so its
        // Last-Modified is the file's own mtime - truncated to whole seconds, because that is all the
        // header can express and a client that echoes it back must get a 304, not a full refetch.
        assert.strictEqual(Math.floor(served.getTime() / 1000), Math.floor(stats.mtimeMs / 1000));
    });

    it('returns 500 when feed file does not exist', async () => {
        // Delete both production and test feeds to trigger fallback failure
        if (fs.existsSync(FEED_PATH)) fs.rmSync(FEED_PATH);
        if (fs.existsSync(TEST_FEED_PATH)) fs.rmSync(TEST_FEED_PATH);

        const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
        const res = {
            statusCode: null,
            jsonData: null,
            headersSent: false,
            setHeaders: {},
            json(data) {
                this.statusCode = data.error ? 500 : 200;
                this.jsonData = data;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            end() {
                this.statusCode = 304;
            },
            set(key, value) {
                this.setHeaders[key] = value;
            }
        };

        await feedRouter.stack[0].route.stack[1].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 500);
        assert.ok(res.jsonData.error);
        // Test feed is restored by after() hook via restoreFeed() -
        // do NOT write a dummy here; it would corrupt the real feed the Roku uses.
    });
});

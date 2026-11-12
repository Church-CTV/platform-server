const express = require('express');
const fs = require('fs');
const Ajv = require('ajv');
const { extractEventsFromPayload, validateBatchPayload } = require('../lib/eventValidator');
const { resolve: resolveEffectiveConfig, normalizeEndpoints } = require('../lib/effectiveConfig');
const { deploymentConfig } = require('../lib/deploymentConfig');
const validateConfig = new Ajv({ allErrors: true }).compile(require('../schemas/ctv-config-v1.json'));
async function loadV2Feed() {
    if (process.env.CTV_V2_FEED_PATH) return { raw: await fs.promises.readFile(process.env.CTV_V2_FEED_PATH) };
    return feedRouter.loadFeed();
}
const path = require('path');
const feedRouter = require('./feed');
const apiRouter = require('./api');
const { apiAuth } = require('../middleware/apiAuth');
const { getRateLimitMiddleware } = require('../middleware/rateLimit');
const { rateLimitValue } = require('../lib/rateLimits');
const router = express.Router();
const httpCache = require('../lib/httpCache');

// A configured public origin prevents Host-header poisoning of URLs published to TVs.
function v2FeedPath() {
    return process.env.CTV_V2_FEED_PATH || require('../lib/feedSource').resolveFeedFile()?.path;
}

/**
 * Every input the assembled v2 body is built from. `lib/httpCache.js` re-fingerprints these on each request
 * and rebuilds only when one changes, which is the whole of `CACHE-2`: measured 2026-11-09, a v2 `304` cost
 * the origin more (14 ms) than its `200` (12 ms) because the old code read, parsed, Ajv-validated and
 * serialized the document before Express could compare a body it had just built.
 */
function v2Sources() {
    return [v2FeedPath(), process.env.CTV_SERVER_PROFILE, process.env.CTV_CHANNEL_CONFIG].filter(Boolean);
}

function readV2FeedRaw() {
    const target = v2FeedPath();
    if (!target) throw Object.assign(new Error('feed-not-found'), { reason: 'no-feed-source-configured' });
    return fs.readFileSync(target, 'utf8');
}

function latestMtime(paths) {
    let newest = 0;
    for (const target of paths) {
        try {
            newest = Math.max(newest, fs.statSync(target).mtimeMs);
        } catch {
            /* absent input */
        }
    }
    return newest || undefined;
}

function baseUrl() {
    return process.env.URL.replace(/\/+$/, '') + '/api/v2';
}

function versionFeed(data) {
    // One store, one merge: the feed's own config block, then the server profile's clientConfig,
    // then the operator store the admin panel writes (`lib/effectiveConfig.js`). Before this seam
    // the profile replaced the block and the operator store was never read here at all, so an edit
    // made in the admin panel could not reach a television. A refused layer is reported, never
    // silently half-applied; `resolve` also carries `reason`/`refusedKeys` onto the error below.
    const resolved = resolveEffectiveConfig({
        base: data.config,
        profilePath: process.env.CTV_SERVER_PROFILE,
        storePath: process.env.CTV_CHANNEL_CONFIG,
        // Only this server knows its own origin, so endpoint values written relative or left empty
        // by an operator become absolute here, before the contract is enforced on the result.
        repair: (config) => normalizeEndpoints(config, process.env.URL)
    });
    if (resolved.config) data = { ...data, config: resolved.config };
    const base = baseUrl();
    const oldOrigin = data.config?.server?.baseUrl;
    function rewrite(value) {
        if (Array.isArray(value)) return value.map(rewrite);
        if (value && typeof value === 'object')
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
        if (typeof value !== 'string') return value;
        try {
            const url = new URL(value, oldOrigin || process.env.URL);
            if (
                url.origin === new URL(oldOrigin || process.env.URL).origin &&
                /^\/(stream|output|images|uploads|Videos)\//.test(url.pathname)
            ) {
                return base + url.pathname + url.search;
            }
        } catch {
            /* Non-URL strings are retained. */
        }
        return value;
    }
    const result = rewrite(data);
    result.apiVersion = 2;
    result.config = result.config || {};
    result.config.server = { ...result.config.server, baseUrl: base };
    result.config.content = { ...result.config.content, sourceUrl: base + '/feed' };
    result.config.analytics = { ...result.config.analytics, exportUrl: base + '/analytics' };
    // `CACHE-11` [owner 2026-11-09]: a config release must be one document. The feed body names the digest
    // of the config it embeds, which is the same digest `/api/v2/config` publishes, so a client that reads
    // the feed can tell whether the config it already holds is the one being released. Measured on the live
    // example channel origin the same day: the legacy `/feed` file shipped no `config` at all and no version field,
    // and on example channel it shipped a `config` whose sha256 (`7bfbd977...`) was not the released one (`cf451ec9...`).
    // Safe for every client: it is a top-level string, and all three parsers skip non-array top-level keys
    // (Roku `BuildContentTree` requires roArray, Fire TV `RawFeedResponse` requires JsonArray, webOS
    // `getMonthKeys` filters strings) - and `apiVersion`/`feedVersion` already set the precedent.
    result.configVersion = httpCache.contentDigest(result.config);
    if (!validateConfig(result.config)) {
        const error = new Error('invalid-server-config');
        error.details = validateConfig.errors;
        error.reason = resolved.reason || 'invalid-effective-config';
        error.refusedKeys = resolved.refusedKeys || [];
        throw error;
    }
    return result;
}

// Diagnostics are computed for the config endpoint only: a television gets the effective config,
// the operator UI gets told which layer was refused and why. They are never smuggled into the feed
// body, where an extra top-level key would itself be a contract change.
function configDiagnostics(rawConfig) {
    return resolveEffectiveConfig({
        base: rawConfig,
        profilePath: process.env.CTV_SERVER_PROFILE,
        storePath: process.env.CTV_CHANNEL_CONFIG,
        repair: (config) => normalizeEndpoints(config, process.env.URL)
    });
}

router.get('/config', async (req, res) => {
    try {
        const sources = v2Sources();
        const { value, state } = httpCache.memoized('v2-config', httpCache.fingerprintFiles(...sources), () => {
            const raw = JSON.parse(readV2FeedRaw());
            const config = versionFeed(raw).config;
            const diagnostics = configDiagnostics(raw.config);
            const body = { apiVersion: 2, configVersion: httpCache.contentDigest(config), config };
            if (diagnostics.degraded) body.refusedKeys = diagnostics.refusedKeys;
            if (diagnostics.reason) body.configNotice = diagnostics.reason;
            // Canonical bytes, so the ETag is a digest of the bytes actually served and cannot drift from
            // them (`CACHE-1`), and so an equivalent config assembled in another order keeps its digest.
            const json = httpCache.canonicalJson(body);
            // Org-scoped, like every other validator (`CACHE-6`): `bytesDigest` is the one function that
            // adds the namespace, so no route can forget it by reaching for the raw hash.
            return {
                json,
                digest: httpCache.bytesDigest(Buffer.from(json, 'utf8')),
                lastModified: latestMtime(sources)
            };
        });
        return httpCache.sendRepresentation(req, res, value, {
            state,
            policyPath: '/api/v2/config',
            contentType: 'application/json; charset=utf-8'
        });
    } catch (error) {
        return res.status(400).json({
            error: 'invalid-server-config',
            reason: error.reason,
            refusedKeys: error.refusedKeys || [],
            details: error.details || []
        });
    }
});
router.get('/health', (req, res) => {
    // Liveness keeps its own representation: cheap to answer, and `public, no-cache` in the table means a
    // monitor gets a 0-byte `304` instead of a 30-byte body every poll.
    const json = httpCache.canonicalJson({ status: 'ok', apiVersion: 2 });
    return httpCache.sendRepresentation(
        req,
        res,
        { json, digest: httpCache.bytesDigest(Buffer.from(json, 'utf8')) },
        { state: 'hit', policyPath: '/api/v2/health', contentType: 'application/json; charset=utf-8' }
    );
});
// the same budget as the published `/feed`, because one organisation's audience and monitoring are
// one peer address no matter which of the two endpoints they call
router.get('/feed', getRateLimitMiddleware(rateLimitValue('feed'), 60000, 'v2-feed'), async (req, res, next) => {
    try {
        const sources = v2Sources();
        const { value, state } = httpCache.memoized('v2-feed', httpCache.fingerprintFiles(...sources), () => {
            const body = httpCache.canonicalJson(versionFeed(JSON.parse(readV2FeedRaw())));
            return {
                json: body,
                digest: httpCache.bytesDigest(Buffer.from(body, 'utf8')),
                lastModified: latestMtime(sources)
            };
        });
        return httpCache.sendRepresentation(req, res, value, {
            state,
            policyPath: '/api/v2/feed',
            // Same deployment-level freshness as legacy `/feed`, so the two published shapes cannot disagree
            // about how long their bytes may be reused (`CACHE-11`).
            policy: httpCache.feedPolicy(deploymentConfig()),
            contentType: 'application/json; charset=utf-8'
        });
    } catch (err) {
        next(err);
    }
});
router.use('/search', async (req, res, next) => {
    let config;
    try {
        const input = await loadV2Feed();
        config = input ? JSON.parse(input.raw).config : undefined;
    } catch (err) {
        return next(err);
    }
    const json = res.json.bind(res);
    // `res.json` is a callback: an error thrown inside it reaches neither `try` block above nor Express's
    // error handling, so it escapes to the process. Measured 2026-11-09 on the stage at 14:1x UTC: one
    // `GET /api/v2/search?q=live` against a deployment whose channel store is still the legacy shape
    // printed `Error: invalid-server-config / at res.json (routes/v2.js:137)` and the Node process exited -
    // the origin died on a request. A monitoring probe must be able to take a channel offline by accident.
    res.json = (data) => {
        try {
            return json(versionFeed({ items: data, config }).items);
        } catch (err) {
            // Hand the response back before delegating: the error responder below calls `res.json` too,
            // and re-entering this wrapper would version the refusal body as if it were a feed.
            res.json = json;
            return next(err);
        }
    };
    req.url = '/search' + req.url;
    feedRouter(req, res, next);
});
router.use(require('./stream'));
for (const dir of ['output', 'images', 'uploads', 'Videos']) {
    router.use(
        '/' + dir,
        express.static(
            dir === 'Videos'
                ? require('../lib/contentRoot').requireVideosDir()
                : dir === 'images' && process.env.CTV_IMAGES_DIR
                  ? process.env.CTV_IMAGES_DIR
                  : path.join(__dirname, '..', dir),
            { dotfiles: 'ignore' }
        )
    );
}
// Strict v2 envelope leaves permissive legacy ingestion unchanged.
const eventKeys = new Set([
    'eventType',
    'timestamp',
    'screenName',
    'previousScreen',
    'contentId',
    'contentTitle',
    'contentDuration',
    'source',
    'state',
    'errorType',
    'errorMessage',
    'action',
    'target',
    'sessionDuration',
    'appVersion',
    'mediaType',
    'deepLinkId',
    'eventId',
    'platform',
    'sessionId',
    'details',
    'sourceScreen',
    'context',
    'timeToFirstFrame',
    'watchSeconds',
    'bufferSeconds',
    'measurementSource'
]);
router.post('/analytics', (req, res, next) => {
    const events = extractEventsFromPayload(req.body);
    if (!events || !req.body.deviceInfo?.deviceId) return res.status(400).json({ error: 'invalid-event-envelope' });
    for (const event of events) {
        if (!event || typeof event !== 'object' || Array.isArray(event))
            return res.status(400).json({ error: 'invalid-event' });
        for (const field of ['timeToFirstFrame', 'watchSeconds', 'bufferSeconds']) {
            if (event[field] !== undefined && (!Number.isFinite(event[field]) || event[field] < 0))
                return res.status(400).json({ error: 'invalid-event-measurement', field });
        }
        const unknown = Object.keys(event).filter((key) => !eventKeys.has(key));
        if (unknown.length) return res.status(400).json({ error: 'unknown-event-field', fields: unknown });
    }
    const batch = validateBatchPayload(req.body);
    if (!batch.valid || batch.rejected?.length)
        return res.status(400).json({ error: 'invalid-events', details: batch.errors || batch.rejected });
    console.log('[v2-analytics] events=' + events.length);
    next();
});
// v2 names stay independent of legacy URLs; shared core retains auth and validation.
router.use((req, res, next) => {
    if (/^\/analytics(?:\/|\?|$)/.test(req.url)) req.url = req.url.replace(/^\/analytics/, '/v1/analytics');
    if (/^\/subscription\/checkout(?:\?|$)/.test(req.url))
        req.url = req.url.replace('/subscription/checkout', '/checkout');
    next();
});
router.use((req, res, next) => {
    const known = apiRouter.stack.some(
        (layer) => layer.route && layer.route.path === req.path && layer.route.methods[req.method.toLowerCase()]
    );
    if (!known) return res.status(404).json({ error: 'unknown-v2-endpoint', apiVersion: 2 });
    apiAuth(req, res, next);
});
router.use(apiRouter);
// One error boundary for the whole v2 surface. Until 2026-11-09 an error that no route caught fell
// through to Express, whose default responder sends an HTML page with a stack trace naming the
// server's install directory - to a television. Measured on the stage against the real example channel
// configuration: `/api/v2/config` correctly answered a machine-readable 400
// (`missing-required:content.sourceUrl`, see cert the private record t8-admin-groundwork-2026-11-08 section 14)
// while `/api/v2/feed`, same condition, answered 500 HTML. A contract refusal is now answered the way
// the contract documents it, everywhere under `/api/v2`, and a client that asked for the v2 feed is
// told where the document it wants actually lives.
router.use((err, req, res, next) => {
    if (err && err.message === 'invalid-server-config') {
        const body = {
            error: 'invalid-server-config',
            reason: err.reason || 'invalid-effective-config',
            refusedKeys: err.refusedKeys || [],
            details: (err.details || []).slice(0, 5)
        };
        if (req.path === '/feed') body.fallback = '/feed';
        return res.status(400).json(body);
    }
    next(err);
});
module.exports = router;

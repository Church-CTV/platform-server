/**
 * API Authentication Middleware
 * Public Roku ingestion and schedule/config reads are rate-limited by handlers.
 * Analytics query endpoints require an admin session. Subscription mutations
 * require an API key. Stripe webhooks require a signature when configured,
 * otherwise an API key.
 */

const crypto = require('crypto');

// Generate or load API key from env
const ANALYTICS_API_KEY = process.env.ANALYTICS_API_KEY || crypto.randomBytes(32).toString('hex');
if (!process.env.ANALYTICS_API_KEY) {
    console.warn('[Security] Generated random ANALYTICS_API_KEY at startup. Set one in .env for persistence.');
}

/**
 * Simple rate limiter - tracks requests per API key within a time window.
 */
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // max requests per window

function checkRateLimit(apiKey) {
    const now = Date.now();
    let entry = rateLimitStore.get(apiKey);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
        entry = { windowStart: now, count: 0 };
        rateLimitStore.set(apiKey, entry);
    }

    entry.count++;

    if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
        return false; // Rate limited
    }

    return true;
}

/**
 * API Key authentication middleware.
 * Validates the X-API-Key header against the configured key.
 */
function apiKeyAuth(req, res, next) {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({ error: 'Missing API key. Provide X-API-Key header.' });
    }

    // Constant-time comparison to prevent timing attacks
    if (!safeCompare(apiKey, ANALYTICS_API_KEY)) {
        return res.status(403).json({ error: 'Invalid API key.' });
    }

    // Rate limiting per API key
    if (!checkRateLimit(apiKey)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Max 100 requests per minute.' });
    }

    next();
}

// Optional operator-defined delay for analytics queries after login. This is
// not a substitute for session regeneration or authentication.
const MIN_SESSION_AGE_SECONDS = Number.parseInt(process.env.MIN_SESSION_AGE_SECONDS ?? '0', 10);

/**
 * Admin session authentication middleware.
 * Requires the user to be logged in as an admin (via express-session).
 */
function adminSessionAuth(req, res, next) {
    if (!req.session || !req.session.adminAuthenticated) {
        return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }

    // Apply the optional operator-defined delay.
    if (MIN_SESSION_AGE_SECONDS > 0) {
        const loginTime = req.session.loginTime || 0;
        if (Date.now() - loginTime < MIN_SESSION_AGE_SECONDS * 1000) {
            return res.status(403).json({ error: 'Session too new. Please wait before querying analytics.' });
        }
    }

    next();
}

/**
 * Route-based API auth - applies the correct auth based on route pattern.
 * Mount this as a middleware at /api/ in server.js.
 *
 * Express strips the mount path before this runs, so req.path is the
 * router-relative path (e.g. /v1/analytics/events, NOT /api/v1/analytics/events).
 * Normalize an optional /api prefix for alternate mounting arrangements.
 */
function apiAuth(req, res, next) {
    const method = req.method;
    const path = (req.path || '').replace(/^\/api(?=\/|$)/, '');

    // Roku clients cannot keep an API secret. Ingestion remains public and
    // handlers enforce validation and IP rate limits. Read queries require login.
    if (method === 'POST' && ['/analytics', '/analytics/legacy', '/v1/analytics', '/heartbeat'].includes(path)) {
        return next();
    }
    if (
        method === 'GET' &&
        ['/subscription/plans', '/subscription/prices', '/subscription/status', '/schedule', '/heartbeat'].includes(
            path
        )
    ) {
        return next();
    }
    // The Stripe handler validates its own signature against the raw body.
    if (method === 'POST' && path === '/webhook/stripe') {
        return process.env.STRIPE_WEBHOOK_SECRET ? next() : apiKeyAuth(req, res, next);
    }
    if (method === 'GET' && path.startsWith('/v1/analytics/')) {
        return adminSessionAuth(req, res, next);
    }
    if (method === 'POST' && ['/checkout', '/subscription/cancel'].includes(path)) {
        return apiKeyAuth(req, res, next);
    }

    // Default: reject all other /api/* routes
    return res.status(403).json({ error: 'Access denied. Authentication required.' });
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

module.exports = {
    ANALYTICS_API_KEY,
    apiKeyAuth,
    adminSessionAuth,
    apiAuth,
    safeCompare,
    RATE_LIMIT_MAX_REQUESTS,
    checkRateLimit // for testing
};

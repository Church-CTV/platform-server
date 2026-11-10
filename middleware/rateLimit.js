const rateLimitStore = new Map();

/**
 * Each limiter needs its own counters. Sharing one Map keyed only by IP lets a
 * caller consume another route's budget: 10 feed requests exhausted the shared
 * counter, so the next admin login was refused even though its own limit is a
 * separate 10/min. Namespace every key by the limiter's own name.
 */
let limiterSeq = 0;

function getRateLimitMiddleware(maxRequests = 100, windowMs = 60000, name = null) {
    const namespace = name || `rl${limiterSeq++}`;

    // Clean up expired entries for this limiter every minute
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, data] of rateLimitStore.entries()) {
            if (!key.startsWith(`${namespace}:`)) continue;
            if (data.windowStart + windowMs < now) {
                rateLimitStore.delete(key);
            }
        }
    }, 60000);
    cleanupInterval.unref();

    return function rateLimit(req, res, next) {
        const trusted = process.env.TRUST_PROXY === 'true';
        const ip = trusted
            ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim()
            : req.socket.remoteAddress || 'unknown';
        const key = `${namespace}:${ip}`;
        const now = Date.now();

        let clientData = rateLimitStore.get(key);
        const expired = !clientData || now - clientData.windowStart >= windowMs;

        if (expired) {
            // Clean up old entry atomically before creating new window
            if (clientData) rateLimitStore.delete(key);
            clientData = { windowStart: now, count: 0 };
            rateLimitStore.set(key, clientData);
        }

        clientData.count++;

        if (clientData.count > maxRequests) {
            const retryAfter = Math.ceil((clientData.windowStart + windowMs - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                error: 'Too many requests',
                retryAfter: retryAfter
            });
        }

        // Set rate limit headers
        res.set('X-RateLimit-Limit', String(maxRequests));
        res.set('X-RateLimit-Remaining', String(maxRequests - clientData.count));
        res.set('X-RateLimit-Reset', String(Math.ceil((clientData.windowStart + windowMs) / 1000)));

        next();
    };
}

module.exports = { getRateLimitMiddleware };

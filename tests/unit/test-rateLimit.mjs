import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { getRateLimitMiddleware } = require('../../middleware/rateLimit.js');

function createMockReq(options = {}) {
    return {
        ip: options.ip || '127.0.0.1',
        headers: options.headers || {},
        socket: { remoteAddress: options.ip || '127.0.0.1' },
        connection: { remoteAddress: options.ip || '127.0.0.1' }
    };
}

function createMockRes() {
    return {
        headersSent: false,
        statusCode: 200,
        headers: {},
        json(data) {
            this.headersSent = true;
            this.jsonData = data;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        set(name, value) {
            this.headers[name] = value;
            return this;
        }
    };
}

describe('rateLimit middleware', () => {
    const originalTrustProxy = process.env.TRUST_PROXY;

    after(() => {
        // Restore original env
        if (originalTrustProxy === undefined) {
            delete process.env.TRUST_PROXY;
        } else {
            process.env.TRUST_PROXY = originalTrustProxy;
        }
    });

    it('allows requests within rate limit', () => {
        const middleware = getRateLimitMiddleware(2, 1000); // 2 req per second
        const req = createMockReq({ ip: '10.0.0.1' });
        const res = createMockRes();
        let nextCalled = false;

        middleware(req, res, () => {
            nextCalled = true;
        });

        assert.strictEqual(nextCalled, true);
        assert.strictEqual(res.headersSent, false);
    });

    it('blocks requests exceeding rate limit', () => {
        const middleware = getRateLimitMiddleware(1, 1000); // 1 req per second
        const req = createMockReq({ ip: '10.0.0.2' });
        const res = createMockRes();
        let nextCalled = false;

        // First request should pass
        middleware(req, res, () => {});

        // Second request should be rate limited
        const res2 = createMockRes();
        middleware(req, res2, () => {
            nextCalled = true;
        });

        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res2.statusCode, 429);
        assert.ok(res2.jsonData.error.includes('Too many requests'));
        assert.ok(res2.headers['Retry-After']);
    });

    it('resets window after time expires', async () => {
        const middleware = getRateLimitMiddleware(1, 50); // 1 req per 50ms

        const req = createMockReq({ ip: '10.0.0.3' });

        // First request should pass
        const res1 = createMockRes();
        let passed1 = false;
        middleware(req, res1, () => {
            passed1 = true;
        });
        assert.strictEqual(passed1, true);

        // Second request should fail
        const res2 = createMockRes();
        let passed2 = false;
        middleware(req, res2, () => {
            passed2 = true;
        });
        assert.strictEqual(passed2, false);

        // Wait for window to expire
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Third request should pass after reset
        const res3 = createMockRes();
        let passed3 = false;
        middleware(req, res3, () => {
            passed3 = true;
        });
        assert.strictEqual(passed3, true);
    });

    it('tracks different IPs separately', () => {
        const middleware = getRateLimitMiddleware(1, 1000);

        // IP 1 should pass
        const req1 = createMockReq({ ip: '10.0.0.4' });
        const res1 = createMockRes();
        let passed1 = false;
        middleware(req1, res1, () => {
            passed1 = true;
        });
        assert.strictEqual(passed1, true);

        // IP 1 should be rate limited
        const res2 = createMockRes();
        let passed2 = false;
        middleware(req1, res2, () => {
            passed2 = true;
        });
        assert.strictEqual(passed2, false);

        // IP 2 should still pass (separate tracking)
        const req2 = createMockReq({ ip: '10.0.0.5' });
        const res3 = createMockRes();
        let passed3 = false;
        middleware(req2, res3, () => {
            passed3 = true;
        });
        assert.strictEqual(passed3, true);
    });

    it('sets rate limit headers', () => {
        const middleware = getRateLimitMiddleware(10, 1000);
        const req = createMockReq({ ip: '10.0.0.6' });
        const res = createMockRes();

        middleware(req, res, () => {});

        assert.strictEqual(res.headers['X-RateLimit-Limit'], '10');
        assert.strictEqual(res.headers['X-RateLimit-Remaining'], '9');
        assert.ok(res.headers['X-RateLimit-Reset']);
    });

    it('uses x-forwarded-for header when TRUST_PROXY is true', () => {
        process.env.TRUST_PROXY = 'true';
        const middleware = getRateLimitMiddleware(1, 1000);

        // Request with X-Forwarded-For header
        const req = createMockReq({
            ip: '10.0.0.7',
            headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.7' }
        });
        const res = createMockRes();
        let nextCalled = false;

        middleware(req, res, () => {
            nextCalled = true;
        });

        assert.strictEqual(nextCalled, true);
        process.env.TRUST_PROXY = originalTrustProxy;
    });

    it('uses first IP from x-forwarded-for list', () => {
        process.env.TRUST_PROXY = 'true';
        const middleware = getRateLimitMiddleware(1, 1000);

        // First request from 192.168.1.2
        const req1 = createMockReq({
            ip: '10.0.0.8',
            headers: { 'x-forwarded-for': '192.168.1.2, 10.0.0.8' }
        });
        const res1 = createMockRes();
        middleware(req1, res1, () => {});

        // Second request from same forwarded IP should be limited
        const res2 = createMockRes();
        let passed = false;
        middleware(req1, res2, () => {
            passed = true;
        });
        assert.strictEqual(passed, false);

        // Request from different forwarded IP should pass
        const req2 = createMockReq({
            ip: '10.0.0.8',
            headers: { 'x-forwarded-for': '192.168.1.3, 10.0.0.8' }
        });
        const res3 = createMockRes();
        let passed2 = false;
        middleware(req2, res3, () => {
            passed2 = true;
        });
        assert.strictEqual(passed2, true);

        process.env.TRUST_PROXY = originalTrustProxy;
    });

    it('ignores x-forwarded-for when TRUST_PROXY is not true', () => {
        process.env.TRUST_PROXY = 'false';
        const middleware = getRateLimitMiddleware(1, 1000);

        // Request with X-Forwarded-For header (should be ignored)
        const req = createMockReq({
            ip: '10.0.0.9',
            headers: { 'x-forwarded-for': '192.168.1.4' }
        });
        const res = createMockRes();
        let passed = false;

        middleware(req, res, () => {
            passed = true;
        });

        assert.strictEqual(passed, true);
        process.env.TRUST_PROXY = originalTrustProxy;
    });

    it('uses defaults when no parameters provided', () => {
        const middleware = getRateLimitMiddleware();
        const req = createMockReq({ ip: '10.0.0.10' });
        const res = createMockRes();

        middleware(req, res, () => {});

        assert.strictEqual(res.headers['X-RateLimit-Limit'], '100');
    });

    // --- Regression: each limiter needs its own budget -------------------
    // Counters used to live in one module-level Map keyed by IP alone, so one
    // route could spend another route's budget. Seven limiters are declared
    // with limits of 10, 30, 60 and 100 req/min; browsing /feed exhausted the
    // shared counter and the next POST /admin/login returned 429 even though
    // its own 10/min allowance was untouched.

    function fire(middleware, ip) {
        const res = createMockRes();
        let nextCalled = false;
        middleware(createMockReq({ ip }), res, () => {
            nextCalled = true;
        });
        return { nextCalled, res };
    }

    it('does not let one limiter exhaust another limiter budget', () => {
        const feed = getRateLimitMiddleware(2, 60000, 'indep-feed');
        const login = getRateLimitMiddleware(2, 60000, 'indep-login');
        const ip = '10.0.1.1';

        assert.strictEqual(fire(feed, ip).nextCalled, true);
        assert.strictEqual(fire(feed, ip).nextCalled, true);
        assert.strictEqual(fire(feed, ip).res.statusCode, 429, 'feed limiter should be exhausted');

        // The login limiter has an independent budget and must still serve.
        assert.strictEqual(fire(login, ip).nextCalled, true, 'login limiter must not inherit the feed budget');
        assert.strictEqual(fire(login, ip).nextCalled, true);
        assert.strictEqual(fire(login, ip).res.statusCode, 429);
    });

    it('keeps different limits independent for the same client', () => {
        const strict = getRateLimitMiddleware(1, 60000, 'lim-strict');
        const loose = getRateLimitMiddleware(10, 60000, 'lim-loose');
        const ip = '10.0.1.2';

        fire(strict, ip);
        assert.strictEqual(fire(strict, ip).res.statusCode, 429, 'strict limiter exhausted');

        for (let i = 0; i < 10; i++) {
            assert.strictEqual(fire(loose, ip).nextCalled, true, `loose request ${i + 1} should pass`);
        }
    });

    it('gives limiters without an explicit name independent counters', () => {
        const first = getRateLimitMiddleware(1, 60000);
        const second = getRateLimitMiddleware(1, 60000);
        const ip = '10.0.1.3';

        assert.strictEqual(fire(first, ip).nextCalled, true);
        assert.strictEqual(fire(first, ip).res.statusCode, 429, 'first limiter exhausted');
        assert.strictEqual(fire(second, ip).nextCalled, true, 'anonymous limiter must get its own counter');
    });
});

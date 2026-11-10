import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Regression tests for the apiAuth path-matching defect found in review.
 *
 * routes/api.js is mounted at '/api' in server.js. Express strips the mount path
 * before middleware runs, so req.path is router-relative. Routes that also
 * declared an '/api' prefix therefore served at '/api/api/...' and matched none of
 * the auth patterns, so every /api/* request fell through to the 403 default.
 *
 * These tests drive apiAuth with the exact (method, req.path) pairs Express
 * produces for the real routes and assert none of them hit the default reject.
 */

function decide(apiAuth, method, path, extra = {}) {
    let outcome = 'next';
    let status = 200;
    const res = {
        status(code) {
            status = code;
            outcome = 'reject';
            return this;
        },
        json() {
            return this;
        }
    };
    apiAuth({ method, path, headers: {}, ...extra }, res, () => {});
    return { outcome, status };
}

describe('apiAuth route matching', () => {
    const { apiAuth } = require('../../middleware/apiAuth.js');

    // [method, req.path as Express sees it when the router is mounted at /api]
    const ingestionPaths = [['/analytics'], ['/analytics/legacy']];
    const adminQueryPaths = [['/v1/analytics/events'], ['/v1/analytics/stats'], ['/v1/analytics/devices']];
    const publicPaths = [['/subscription/plans'], ['/subscription/prices']];

    it('allows public Roku ingestion instead of default 403', () => {
        for (const [p] of ingestionPaths) {
            const { status } = decide(apiAuth, 'POST', p);
            // 401 = reached apiKeyAuth (no key supplied). 403 default = BUG.
            assert.strictEqual(status, 200, `POST ${p} should reach public ingestion`);
        }
    });

    it('allows admin query routes through to session auth instead of default 403', () => {
        for (const [p] of adminQueryPaths) {
            const { status } = decide(apiAuth, 'GET', p);
            // 401 = reached adminSessionAuth (no session). 403 default = BUG.
            assert.strictEqual(status, 401, `GET ${p} fell through to default 403`);
        }
    });

    it('allows public subscription read endpoints', () => {
        for (const [p] of publicPaths) {
            const { outcome } = decide(apiAuth, 'GET', p);
            assert.strictEqual(outcome, 'next', `GET ${p} should be public`);
        }
    });

    it('tolerates a redundant /api prefix in req.path', () => {
        // Some deployments mount the router at the app root instead of /api.
        const { outcome } = decide(apiAuth, 'GET', '/api/subscription/plans');
        assert.strictEqual(outcome, 'next', 'redundant /api prefix should still resolve as public');
    });

    it('still rejects genuinely unknown /api routes', () => {
        const { status } = decide(apiAuth, 'GET', '/not-a-route');
        assert.strictEqual(status, 403, 'unknown routes must stay denied');
    });

    it('does not let a public GET bypass analytics via method confusion', () => {
        // POST to a subscription read path must not be treated as public.
        const { outcome } = decide(apiAuth, 'POST', '/subscription/plans');
        assert.strictEqual(outcome, 'reject', 'POST must not inherit the public GET exemption');
    });

    it('admits an authenticated admin session past the session-age gate', () => {
        // MIN_SESSION_AGE_SECONDS defaults to 300s; use an old loginTime so the
        // session-age check passes and we prove auth itself is reachable.
        const { outcome } = decide(apiAuth, 'GET', '/v1/analytics/stats', {
            session: { adminAuthenticated: true, loginTime: Date.now() - 3600 * 1000 }
        });
        assert.strictEqual(outcome, 'next', 'valid admin session should be admitted');
    });

    it('admits a fresh authenticated admin session by default', () => {
        const { status } = decide(apiAuth, 'GET', '/v1/analytics/stats', {
            session: { adminAuthenticated: true, loginTime: Date.now() }
        });
        assert.strictEqual(status, 200, 'fresh authenticated sessions work by default');
    });
});

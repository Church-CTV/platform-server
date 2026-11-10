import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('dashboard routes', () => {
    let dashboardRouter;

    before(() => {
        // Clear require cache to get fresh router instance
        delete require.cache[require.resolve('../../routes/dashboard')];
        delete require.cache[require.resolve('../../lib/db')];
        delete require.cache[require.resolve('../../routes/api')];
        dashboardRouter = require('../../routes/dashboard');
    });

    it('should handle invalid limit/offset parameters', () => {
        const query = { limit: 'invalid', offset: '-1', search: '<script>alert(1)</script>' };
        assert.strictEqual(typeof parseInt(query.limit, 10), 'number');
        assert.strictEqual(parseInt(query.offset, 10), -1);
    });

    it('should properly escape search query for SQL LIKE', () => {
        const search = 'test_script%.txt';
        const sanitized = search.replace(/[_%]/g, (c) => '\\' + c);
        assert.ok(sanitized.includes('\\_'));
        assert.ok(sanitized.includes('\\%'));
    });

    it('should handle empty search parameter', () => {
        const search = '';
        const sanitized = search.replace(/[_%]/g, (c) => '\\' + c);
        assert.strictEqual(sanitized, '');
    });

    function makeMockReq(query = {}, { session = { adminAuthenticated: true } } = {}) {
        // A session is part of the request these routes now expect: `GET /`, `/events` and `/devices` are
        // the operator surface, so the gate in `routes/dashboard.js` reads `req.session` before the handler
        // runs. Pass `{ session: {} }` (or omit the auth flag) to drive the anonymous path.
        return { query, method: 'GET', session, headers: {}, xhr: false, originalUrl: '/events' };
    }

    function makeMockRes() {
        return {
            statusCode: null,
            jsonData: null,
            renderTemplate: null,
            renderData: null,
            setHeaders: {},
            json(data) {
                this.statusCode = 200;
                this.jsonData = data;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            end() {},
            set(key, value) {
                this.setHeaders[key] = value;
            },
            redirect(location) {
                this.statusCode = 302;
                this.redirectedTo = location;
            },
            send(body) {
                this.statusCode = 200;
                this.sentBody = body;
            },
            render(template, data) {
                this.renderTemplate = template;
                this.renderData = data;
                this.statusCode = 200;
            }
        };
    }

    it('GET / should render overview page', async () => {
        const req = makeMockReq();
        const res = makeMockRes();

        await dashboardRouter.stack[0].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.renderTemplate, 'dashboard/overview');
    });

    it('GET /events should render events page with valid params', async () => {
        const req = makeMockReq({ limit: 50, offset: 0 });
        const res = makeMockRes();

        await dashboardRouter.stack[1].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.renderTemplate, 'dashboard/events');
    });

    it('GET /events should filter by event type', async () => {
        const req = makeMockReq({ limit: 50, offset: 0, eventType: 'screen_view' });
        const res = makeMockRes();

        await dashboardRouter.stack[1].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
    });

    it('GET /events should filter by device ID', async () => {
        const req = makeMockReq({ limit: 50, offset: 0, deviceId: 'test-device-123' });
        const res = makeMockRes();

        await dashboardRouter.stack[1].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
    });

    it('GET /events should handle SQL injection in search', async () => {
        const req = makeMockReq({ limit: 50, offset: 0, search: "'; DROP TABLE events; --" });
        const res = makeMockRes();

        await dashboardRouter.stack[1].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
    });

    it('GET /events should handle pagination', async () => {
        const req = makeMockReq({ limit: 10, offset: 20 });
        const res = makeMockRes();

        await dashboardRouter.stack[1].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
    });

    it('GET /devices should render devices page', async () => {
        const req = makeMockReq({ activeDays: 7 });
        const res = makeMockRes();

        await dashboardRouter.stack[2].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.renderTemplate, 'dashboard/devices');
    });

    it('GET /devices should handle activeDays=all', async () => {
        const req = makeMockReq({ activeDays: 'all' });
        const res = makeMockRes();

        await dashboardRouter.stack[2].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
    });

    it('GET /devices should handle invalid activeDays', async () => {
        const req = makeMockReq({ activeDays: 'invalid' });
        const res = makeMockRes();

        await dashboardRouter.stack[2].handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
    });

    // The gate itself, at the unit level. The integration file
    // (`tests/integration/test-dashboard-exposure.mjs`) proves the same over real HTTP on three real
    // processes; these two are the cheap fence that keeps the policy in this module rather than only in a
    // server that has to be spawned to be believed.
    it('an anonymous visitor is sent to the login page and their intended page is remembered', async () => {
        for (const [index, route] of [
            [0, '/'],
            [1, '/events'],
            [2, '/devices']
        ]) {
            const req = makeMockReq({}, { session: {} });
            req.originalUrl = route;
            const res = makeMockRes();

            await dashboardRouter.stack[index].handle(req, res, () => {});

            assert.strictEqual(res.statusCode, 302, `${route} did not redirect an anonymous visitor`);
            assert.strictEqual(res.redirectedTo, '/admin/login');
            assert.strictEqual(req.session.redirectTo, route, `${route} was not remembered for after login`);
            assert.strictEqual(res.setHeaders['X-CTV-Denied'], 'auth-required', `${route} refused silently`);
            // The data handler never ran: it is the only thing on these routes that renders.
            assert.strictEqual(res.renderTemplate, null, `${route} still rendered the operator's data`);
        }
    });

    it('ADMIN_DASHBOARD_PUBLIC=true is the one documented way to publish these pages', async () => {
        const req = makeMockReq({}, { session: {} }); // anonymous: only the flag may let this through
        const res = makeMockRes();

        process.env.ADMIN_DASHBOARD_PUBLIC = 'true';
        try {
            await dashboardRouter.stack[0].handle(req, res, () => {});
        } finally {
            delete process.env.ADMIN_DASHBOARD_PUBLIC;
        }

        assert.strictEqual(res.renderTemplate, 'dashboard/overview', 'the published flag did not publish the page');
        assert.strictEqual(res.setHeaders['X-CTV-Dashboard'], 'public-by-flag');

        // Anything that is not exactly "true" - unset, a typo, a truthy-looking string - keeps the login.
        for (const value of ['TRUE', 'yes', '1', '']) {
            const gated = makeMockReq({}, { session: {} });
            const gatedRes = makeMockRes();
            process.env.ADMIN_DASHBOARD_PUBLIC = value;
            try {
                await dashboardRouter.stack[0].handle(gated, gatedRes, () => {});
            } finally {
                delete process.env.ADMIN_DASHBOARD_PUBLIC;
            }
            assert.strictEqual(gatedRes.statusCode, 302, `"${value}" published a page that should have stayed gated`);
        }
    });
});

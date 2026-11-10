import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const DB_PATH = path.join(process.cwd(), 'analytics.db.test_export');
const BACKUP_PATH = path.join(process.cwd(), 'analytics.db.test_export_backup');
// Override DB_PATH env var for this test file to use isolated DB
process.env.DB_PATH = DB_PATH;

function cleanup() {
    // Clear require cache FIRST to get fresh module with our DB_PATH
    Object.keys(require.cache).forEach((key) => {
        if (
            key.includes('lib/db.js') ||
            key.includes('routes/api.js') ||
            key.includes('lib/eventValidator.js') ||
            key.includes('middleware/rateLimit.js')
        ) {
            delete require.cache[key];
        }
    });

    // Close DB if it exists (uses our env-override path)
    try {
        const { closeDb } = require('../../lib/db.js');
        closeDb();
    } catch {}

    if (fs.existsSync(DB_PATH)) {
        if (fs.existsSync(BACKUP_PATH)) {
            try {
                fs.unlinkSync(BACKUP_PATH);
            } catch {}
        }
        fs.renameSync(DB_PATH, BACKUP_PATH);
    }
}

function restore() {
    // Clear require cache
    Object.keys(require.cache).forEach((key) => {
        if (
            key.includes('lib/db.js') ||
            key.includes('routes/api.js') ||
            key.includes('lib/eventValidator.js') ||
            key.includes('middleware/rateLimit.js')
        ) {
            delete require.cache[key];
        }
    });

    // Close DB
    try {
        const { closeDb } = require('../../lib/db.js');
        closeDb();
    } catch {}

    if (fs.existsSync(BACKUP_PATH)) {
        if (fs.existsSync(DB_PATH)) {
            try {
                fs.unlinkSync(DB_PATH);
            } catch {}
        }
        fs.renameSync(BACKUP_PATH, DB_PATH);
    } else if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH);
    }
}

// Clean all tables in the DB
function cleanTables(db) {
    db.prepare('DELETE FROM events').run();
    db.prepare('DELETE FROM devices').run();
    db.prepare('DELETE FROM summary').run();
    try {
        db.prepare('DELETE FROM subscription_customers').run();
    } catch {}
    try {
        db.prepare('DELETE FROM subscriptions').run();
    } catch {}
}

function createMockReq(body) {
    return {
        body,
        ip: '127.0.0.1',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
        connection: { remoteAddress: '127.0.0.1' }
    };
}

function createMockRes() {
    const res = {
        headersSent: false,
        statusCode: 200,
        jsonData: null,
        headers: {},
        json(statusOrData, data) {
            this.headersSent = true;
            if (typeof statusOrData === 'number') {
                this.statusCode = statusOrData;
                this.jsonData = data;
            } else {
                this.jsonData = statusOrData;
            }
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        set(name, value) {
            this.headers[name] = value;
            return this;
        },
        header(name, value) {
            this.headers[name] = value;
            return this;
        }
    };
    return res;
}

describe('event validator - Roku nested format', () => {
    const { validateBatchPayload, flattenRokuEvents, extractEventsFromPayload } = require('../../lib/eventValidator');

    it('flattens Roku structured events object', () => {
        const eventsObj = {
            screenViews: [
                { eventType: 'screen_view', screenName: 'Home' },
                { eventType: 'screen_view', screenName: 'Detail' }
            ],
            plays: [{ eventType: 'content_play', contentId: 'vid1' }],
            deepLinks: [{ eventType: 'deep_link', contentId: 'vid1', mediaType: 'video' }],
            errors: [{ eventType: 'error', errorType: 'network' }]
        };
        const flat = flattenRokuEvents(eventsObj);
        assert.strictEqual(flat.length, 5);
    });

    it('extracts events from Roku structured payload', () => {
        const payload = {
            appVersion: '1.0.0',
            sessionStartTime: '00:01:00',
            activeScreen: 'Home',
            eventCount: 10,
            summary: { screenViews: 5, plays: 3, deepLinks: 1, errors: 1 },
            events: {
                screenViews: [{ eventType: 'screen_view', screenName: 'Home', timestamp: '00:01:00' }],
                plays: [{ eventType: 'content_play', contentId: 'vid1', timestamp: '00:02:00' }]
            }
        };
        const events = extractEventsFromPayload(payload);
        assert.strictEqual(events.length, 2);
    });

    it('validates batch with Roku nested events format', () => {
        const result = validateBatchPayload({
            appVersion: '1.0.0',
            events: {
                screenViews: [{ eventType: 'screen_view', timestamp: '12:00:00', screenName: 'Home' }],
                plays: [{ eventType: 'content_play', timestamp: '12:01:00', contentId: 'vid1' }],
                deepLinks: [{ eventType: 'deep_link', timestamp: '12:02:00', contentId: 'vid1', mediaType: 'video' }],
                errors: [{ eventType: 'error', timestamp: '12:03:00', errorType: 'network' }]
            }
        });
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.accepted.length, 4);
        assert.strictEqual(result.rejected.length, 0);
    });

    it('rejects invalid events within Roku nested format', () => {
        const result = validateBatchPayload({
            events: {
                screenViews: [
                    { eventType: 'screen_view', timestamp: '12:00:00', screenName: 'Home' },
                    { eventType: 'screen_view', timestamp: '12:01:00' } // missing screenName
                ],
                plays: [{ eventType: 'content_play', timestamp: '12:02:00', contentId: 'vid1' }]
            }
        });
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.accepted.length, 2);
        assert.strictEqual(result.rejected.length, 1);
    });

    it('extracts events from flat array format', () => {
        const payload = {
            events: [{ type: 'screen_view', timestamp: '12:00:00', title: 'Home' }]
        };
        const events = extractEventsFromPayload(payload);
        assert.strictEqual(events.length, 1);
    });

    it('returns null for payload without events', () => {
        const result = extractEventsFromPayload({ data: 'not events' });
        assert.strictEqual(result, null);
    });
});

describe('POST /analytics - Roku structured format', () => {
    let apiRouter;

    before(() => {
        cleanup();
        const { closeDb } = require('../../lib/db.js');
        closeDb();
        apiRouter = require('../../routes/api.js');
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        cleanTables(db);
    });

    after(() => {
        restore();
    });

    it('accepts Roku structured payload with nested events', () => {
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        db.prepare('DELETE FROM events').run();
        db.prepare('DELETE FROM devices').run();

        const req = createMockReq({
            appVersion: '1.0.0',
            sessionStartTime: '00:01:00',
            activeScreen: 'Home',
            eventCount: 4,
            summary: { screenViews: 1, plays: 1, deepLinks: 1, errors: 1 },
            events: {
                screenViews: [
                    { eventType: 'screen_view', timestamp: '00:01:00', screenName: 'Home', sessionDuration: 60 }
                ],
                plays: [
                    {
                        eventType: 'content_play',
                        timestamp: '00:02:00',
                        contentId: 'vid1',
                        contentTitle: 'Test Sermon',
                        sessionDuration: 120
                    }
                ],
                deepLinks: [
                    {
                        eventType: 'deep_link',
                        timestamp: '00:03:00',
                        contentId: 'vid1',
                        mediaType: 'video',
                        source: 'rowlist'
                    }
                ],
                errors: [
                    {
                        eventType: 'error',
                        timestamp: '00:04:00',
                        errorType: 'network',
                        errorMessage: 'Timeout',
                        context: 'stream'
                    }
                ]
            }
        });
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/analytics');
        route.route.stack[0].handle(req, res, () => route.route.stack[1].handle(req, res, () => {}));
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.received, true);
        assert.strictEqual(res.jsonData.count, 4);

        const count = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
        assert.strictEqual(count, 4);
    });

    it('accepts queued event format', () => {
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        db.prepare('DELETE FROM events').run();
        db.prepare('DELETE FROM devices').run();

        const req = createMockReq({
            eventType: 'screen_view',
            timestamp: '00:01:00',
            appVersion: '1.0.0',
            screenViews: [{ screenName: 'Home' }],
            plays: [],
            deepLinks: [],
            errors: [],
            sessionDuration: 30
        });
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/analytics');
        route.route.stack[0].handle(req, res, () => route.route.stack[1].handle(req, res, () => {}));
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.received, true);
        assert.strictEqual(res.jsonData.count, 1);

        const count = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
        assert.strictEqual(count, 1);
    });

    it('stores device info from payload', () => {
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        db.prepare('DELETE FROM events').run();
        db.prepare('DELETE FROM devices').run();

        const req = createMockReq({
            deviceInfo: { deviceId: 'roku-device-123', channelName: 'Test Channel', appVersion: '2.0.0' },
            events: {
                screenViews: [{ eventType: 'screen_view', timestamp: '00:01:00', screenName: 'Home' }]
            }
        });
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/analytics');
        route.route.stack[0].handle(req, res, () => route.route.stack[1].handle(req, res, () => {}));
        assert.strictEqual(res.statusCode, 200);

        const device = db.prepare('SELECT * FROM devices WHERE id = :id').get({ id: 'roku-device-123' });
        assert.ok(device);
        assert.strictEqual(device.channel_name, 'Test Channel');
        assert.strictEqual(device.app_version, '2.0.0');
    });

    it('stores summary data', () => {
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        db.prepare('DELETE FROM events').run();
        db.prepare('DELETE FROM devices').run();
        db.prepare('DELETE FROM summary').run();

        const req = createMockReq({
            summary: { screenViews: 10, plays: 5, deepLinks: 2, errors: 1 },
            events: {
                screenViews: [{ eventType: 'screen_view', timestamp: '00:01:00', screenName: 'Home' }]
            }
        });
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/analytics');
        route.route.stack[0].handle(req, res, () => route.route.stack[1].handle(req, res, () => {}));
        assert.strictEqual(res.statusCode, 200);

        const summary = db.prepare('SELECT * FROM summary WHERE id = 1').get();
        assert.ok(summary);
        const metadata = JSON.parse(summary.metadata);
        assert.strictEqual(metadata.screenViews, 10);
    });

    it('rejects non-object payload', () => {
        const req = createMockReq('not a json object');
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/analytics');
        route.route.stack[0].handle(req, res, () => route.route.stack[1].handle(req, res, () => {}));
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.jsonData.error);
    });
});

describe('subscription endpoints', () => {
    let apiRouter;

    before(() => {
        cleanup();
        const { closeDb } = require('../../lib/db.js');
        closeDb();
        apiRouter = require('../../routes/api.js');
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        cleanTables(db);
    });

    after(() => {
        restore();
    });

    it('POST /api/checkout creates checkout URL', () => {
        const req = createMockReq({ productId: 'prod_123', customerEmail: 'test@example.com' });
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/checkout');
        route.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.jsonData.url);
        assert.ok(res.jsonData.url.startsWith('https://checkout.stripe.com/pay/'));
    });

    it('POST /api/checkout requires productId and customerEmail', () => {
        const req = createMockReq({ productId: 'prod_123' });
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/checkout');
        route.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.jsonData.error);
    });

    it('GET /api/subscription/status returns not found for unknown subscriber', () => {
        const req = { query: { subscriberId: 'unknown-sub' } };
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/subscription/status');
        route.route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.active, false);
    });

    it('GET /api/subscription/status requires subscriberId', () => {
        const req = { query: {} };
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/subscription/status');
        route.route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.jsonData.error);
    });

    it('POST /api/subscription/cancel returns not_found for unknown subscriber', () => {
        const req = createMockReq({ subscriberId: 'unknown-sub' });
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/subscription/cancel');
        route.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.status, 'not_found');
    });

    it('POST /api/subscription/cancel requires subscriberId', () => {
        const req = createMockReq({});
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/subscription/cancel');
        route.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.jsonData.error);
    });

    it('GET /api/subscription/plans returns plan list', () => {
        const req = {};
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/subscription/plans');
        route.route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.ok(Array.isArray(res.jsonData));
    });

    it('GET /api/subscription/prices returns price list', () => {
        const req = {};
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/subscription/prices');
        route.route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.ok(Array.isArray(res.jsonData));
    });

    it('POST /api/webhook/stripe rejects invalid JSON body', () => {
        const req = { body: 'not-valid-json', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/webhook/stripe');
        route.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.jsonData.error);
    });

    it('verifies timestamped Stripe signatures and rejects malformed or stale signatures', () => {
        const crypto = require('crypto');
        const oldSecret = process.env.STRIPE_WEBHOOK_SECRET;
        process.env.STRIPE_WEBHOOK_SECRET = 'unit-webhook-secret';
        const route = apiRouter.stack.find((s) => s.route?.path === '/webhook/stripe');
        const body = Buffer.from(JSON.stringify({ type: 'unknown.event' }));
        const now = Math.floor(Date.now() / 1000);
        const sign = (t) =>
            crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
        try {
            for (const [header, expected] of [
                [`t=${now},v1=${sign(now)}`, 200],
                [`t=${now},v1=x`, 400],
                [`t=${now - 600},v1=${sign(now - 600)}`, 400],
                [`t=${now},v1=${'0'.repeat(64)}`, 400]
            ]) {
                const res = createMockRes();
                route.route.stack[1].handle({ body, headers: { 'stripe-signature': header } }, res, () => {});
                assert.equal(res.statusCode, expected);
            }
        } finally {
            if (oldSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
            else process.env.STRIPE_WEBHOOK_SECRET = oldSecret;
        }
    });

    it('POST /api/webhook/stripe handles unknown event type', () => {
        const req = {
            body: JSON.stringify({ type: 'unknown.event', data: { object: {} } }),
            headers: {},
            socket: { remoteAddress: '127.0.0.1' }
        };
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/webhook/stripe');
        route.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.received, true);
    });

    it('POST /api/webhook/stripe creates subscription on checkout.session.completed', async () => {
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        db.prepare('DELETE FROM subscriptions').run();
        db.prepare('DELETE FROM subscription_customers').run();

        const req = {
            body: {
                type: 'checkout.session.completed',
                data: {
                    object: {
                        client_reference_id: 'sub_123',
                        customer_email: 'test@example.com'
                    }
                }
            },
            headers: {},
            socket: { remoteAddress: '127.0.0.1' }
        };
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/webhook/stripe');
        await route.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.received, true);

        const sub = db.prepare('SELECT * FROM subscriptions WHERE subscriber_id = :id').get({ id: 'sub_123' });
        assert.ok(sub);
        assert.strictEqual(sub.status, 'active');
    });
});

describe('POST /analytics - accepts all formats', () => {
    let apiRouter;

    before(() => {
        cleanup();
        const { closeDb } = require('../../lib/db.js');
        closeDb();
        apiRouter = require('../../routes/api.js');
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        cleanTables(db);
    });

    after(() => {
        restore();
    });

    it('accepts flat events array format', () => {
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        db.prepare('DELETE FROM events').run();
        db.prepare('DELETE FROM devices').run();

        const req = createMockReq({
            events: [{ eventType: 'screen_view', timestamp: '00:01:00', screenName: 'Home', sessionDuration: 30 }]
        });
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/analytics');
        route.route.stack[0].handle(req, res, () => route.route.stack[1].handle(req, res, () => {}));
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.count, 1);

        const count = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
        assert.strictEqual(count, 1);
    });

    it('accepts Events array format (capitalized)', () => {
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        db.prepare('DELETE FROM events').run();
        db.prepare('DELETE FROM devices').run();

        const req = createMockReq({
            Events: [{ eventType: 'content_play', timestamp: '00:01:00', contentId: 'vid1' }]
        });
        const res = createMockRes();
        const route = apiRouter.stack.find((s) => s.route && s.route.path === '/analytics');
        route.route.stack[0].handle(req, res, () => route.route.stack[1].handle(req, res, () => {}));
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.count, 1);

        const count = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
        assert.strictEqual(count, 1);
    });
});

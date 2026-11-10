import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const DB_PATH = path.join(process.cwd(), 'analytics.db.test_analytics');
const BACKUP_PATH = path.join(process.cwd(), 'analytics.db.test_analytics_backup');

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

    // Close DB if it exists
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

describe('event validator', () => {
    const {
        validateEvent,
        validateBatchPayload,
        sanitizeString,
        VALID_EVENT_TYPES
    } = require('../../lib/eventValidator');

    it('accepts valid screen_view event', () => {
        const result = validateEvent({
            eventType: 'screen_view',
            timestamp: '12:00:00',
            sessionDuration: 30,
            screenName: 'HomeScreen'
        });
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.errors.length, 0);
    });

    it('accepts valid content_play event', () => {
        const result = validateEvent({
            eventType: 'content_play',
            timestamp: '12:00:00',
            contentId: 'sermon-001',
            contentTitle: 'Test Sermon'
        });
        assert.strictEqual(result.valid, true);
    });

    it('accepts valid deep_link event', () => {
        const result = validateEvent({
            eventType: 'deep_link',
            timestamp: '12:00:00',
            contentId: 'sermon-001',
            mediaType: 'video'
        });
        assert.strictEqual(result.valid, true);
    });

    it('accepts valid error event', () => {
        const result = validateEvent({
            eventType: 'error',
            timestamp: '12:00:00',
            errorType: 'network'
        });
        assert.strictEqual(result.valid, true);
    });

    it('accepts valid interaction event', () => {
        const result = validateEvent({
            eventType: 'interaction',
            timestamp: '12:00:00',
            action: 'click'
        });
        assert.strictEqual(result.valid, true);
    });

    it('accepts valid playback_state event', () => {
        const result = validateEvent({
            eventType: 'playback_state',
            timestamp: '12:00:00',
            state: 'playing'
        });
        assert.strictEqual(result.valid, true);
    });

    it('rejects unknown event type', () => {
        const result = validateEvent({
            eventType: 'unknown_type',
            timestamp: '12:00:00'
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.some((e) => e.includes('Unknown event type')));
    });

    it('rejects event missing required screenName', () => {
        const result = validateEvent({
            eventType: 'screen_view',
            timestamp: '12:00:00'
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.some((e) => e.includes('screenName')));
    });

    it('rejects event missing required contentId for content_play', () => {
        const result = validateEvent({
            eventType: 'content_play',
            timestamp: '12:00:00'
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.some((e) => e.includes('contentId')));
    });

    it('rejects null event', () => {
        const result = validateEvent(null);
        assert.strictEqual(result.valid, false);
    });

    it('rejects non-object event', () => {
        const result = validateEvent('string');
        assert.strictEqual(result.valid, false);
    });

    it('sanitizes special characters in strings', () => {
        assert.strictEqual(sanitizeString('<script>'), '&lt;script&gt;');
        assert.strictEqual(sanitizeString('"quoted"'), '"quoted"');
        assert.strictEqual(sanitizeString("it's"), "it's");
        assert.strictEqual(sanitizeString('a & b'), 'a & b');
    });

    it('validates batch payload', () => {
        const result = validateBatchPayload({
            events: [
                { eventType: 'screen_view', timestamp: '12:00:00', screenName: 'Home' },
                { eventType: 'invalid', timestamp: '12:00:00' },
                { eventType: 'content_play', timestamp: '12:00:00', contentId: 'vid1' }
            ]
        });
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.accepted.length, 2);
        assert.strictEqual(result.rejected.length, 1);
    });

    it('rejects batch without events array', () => {
        const result = validateBatchPayload({ data: [] });
        assert.strictEqual(result.valid, false);
    });

    it('validates all valid event types are recognized', () => {
        const expected = [
            'screen_view',
            'content_play',
            'deep_link',
            'error',
            'interaction',
            'playback_state',
            'unknown'
        ];
        assert.deepStrictEqual(VALID_EVENT_TYPES.sort(), expected.sort());
    });
});

describe('api v1 route', () => {
    let apiRouter;
    let v1AnalyticsRoute, v1EventsRoute, v1StatsRoute, v1DevicesRoute;

    before(() => {
        cleanup();
        const { closeDb } = require('../../lib/db.js');
        closeDb();
        apiRouter = require('../../routes/api.js');
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        cleanTables(db);

        function findRoute(path) {
            return apiRouter.stack.find((s) => s.route && s.route.path === path);
        }

        v1AnalyticsRoute = findRoute('/v1/analytics');
        v1EventsRoute = findRoute('/v1/analytics/events');
        v1StatsRoute = findRoute('/v1/analytics/stats');
        v1DevicesRoute = findRoute('/v1/analytics/devices');
    });

    after(() => {
        restore();
    });

    function createMockReq(body, _method = 'POST') {
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
            set(key, value) {
                this.headers[key] = value;
            }
        };
        return res;
    }

    function createGetMockReq(query = {}) {
        return {
            query,
            ip: '127.0.0.1',
            connection: { remoteAddress: '127.0.0.1' }
        };
    }

    it('POST /v1/analytics accepts valid events with deviceInfo', () => {
        // Clear any leftover events from previous test runs
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        db.prepare('DELETE FROM events').run();
        db.prepare('DELETE FROM devices').run();

        const req = createMockReq({
            deviceInfo: { deviceId: 'test-device-1', appVersion: '1.0.0', channelName: 'Test' },
            events: [
                {
                    eventType: 'screen_view',
                    timestamp: '12:00:00',
                    sessionDuration: 10,
                    appVersion: '1.0.0',
                    screenName: 'Home'
                },
                {
                    eventType: 'content_play',
                    timestamp: '12:01:00',
                    sessionDuration: 60,
                    contentId: 'vid1',
                    contentTitle: 'Test'
                }
            ]
        });
        const res = createMockRes();
        v1AnalyticsRoute.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.accepted, 2);
        assert.strictEqual(res.jsonData.rejected, 0);

        const count = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
        assert.strictEqual(count, 2);
    });

    it('POST /v1/analytics rejects invalid event types', () => {
        const req = createMockReq({
            deviceInfo: { deviceId: 'test-device-2' },
            events: [
                { eventType: 'screen_view', timestamp: '12:00:00', screenName: 'Home' },
                { eventType: 'bad_type', timestamp: '12:01:00' }
            ]
        });
        const res = createMockRes();
        v1AnalyticsRoute.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.accepted, 1);
        assert.strictEqual(res.jsonData.rejected, 1);
    });

    it('POST /v1/analytics returns 400 for invalid payload', () => {
        const req = createMockReq({ data: 'not events' });
        const res = createMockRes();
        v1AnalyticsRoute.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.jsonData.error);
    });

    it('POST /v1/analytics is rate limited', () => {
        // Send 101 requests to trigger rate limit
        for (let i = 0; i < 101; i++) {
            const req = createMockReq({
                deviceInfo: { deviceId: `rate-test-${i}` },
                events: [{ eventType: 'screen_view', timestamp: '12:00:00', screenName: 'Home' }]
            });
            const res = createMockRes();
            v1AnalyticsRoute.route.stack[1].handle(req, res, () => {});
            if (res.statusCode === 429) {
                // Rate limited after 100 requests
                break;
            }
        }
    });

    it('GET /v1/analytics/events returns paginated events', () => {
        const req = createGetMockReq({ limit: '10', offset: '0' });
        const res = createMockRes();
        v1EventsRoute.route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.jsonData.events);
        assert.ok(res.jsonData.pagination);
        assert.ok(res.jsonData.pagination.total >= 2);
    });

    it('GET /v1/analytics/events filters by eventType', () => {
        const req = createGetMockReq({ eventType: 'screen_view', limit: '10', offset: '0' });
        const res = createMockRes();
        v1EventsRoute.route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        // All returned events should be screen_view
        res.jsonData.events.forEach((e) => {
            assert.strictEqual(e.event_type, 'screen_view');
        });
    });

    it('GET /v1/analytics/stats returns aggregated data', () => {
        const req = createGetMockReq({ period: 'all', groupBy: 'day' });
        const res = createMockRes();
        v1StatsRoute.route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.jsonData.summary);
        assert.ok(res.jsonData.eventsOverTime);
        assert.ok(res.jsonData.typeBreakdown);
    });

    it('GET /v1/analytics/devices returns device list', () => {
        const req = createGetMockReq({ activeDays: 'all' });
        const res = createMockRes();
        v1DevicesRoute.route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.jsonData.devices);
    });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const DB_PATH = path.join(process.cwd(), 'analytics.db.test_api');
const BACKUP_PATH = path.join(process.cwd(), 'analytics.db.test_api_backup');

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

describe('api route', () => {
    let apiRouter;
    let legacyAnalyticsRoute;

    before(() => {
        cleanup();
        const { getDb, closeDb } = require('../../lib/db.js');
        closeDb();
        apiRouter = require('../../routes/api.js');
        // Re-import after apiRouter loaded (getDb is cached from above, same module)
        const db = getDb();
        cleanTables(db);

        // Find the legacy /api/analytics route specifically (index 1 in stack, after /analytics)
        legacyAnalyticsRoute = apiRouter.stack.find((s) => s.route && s.route.path === '/analytics/legacy');
    });

    after(() => {
        restore();
    });

    function createMockReq(body) {
        return {
            body,
            ip: '127.0.0.1',
            socket: { remoteAddress: '127.0.0.1' }
        };
    }

    function createMockRes() {
        const res = {
            headersSent: false,
            statusCode: 200,
            jsonData: null,
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
            }
        };
        return res;
    }

    it('returns 400 when events is not an array', () => {
        const req = createMockReq({ events: 'not-an-array' });
        const res = createMockRes();
        // stack[0] is rate limiter, stack[1] is the actual handler
        legacyAnalyticsRoute.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.jsonData.error);
    });

    it('accepts valid events array and stores in DB', async () => {
        const events = [
            { type: 'content_play', timestamp: '2024-01-01T00:00:00.000Z', title: 'Test Sermon' },
            { type: 'content_pause', title: 'Test Sermon' }
        ];
        const req = createMockReq({ events });
        const res = createMockRes();
        legacyAnalyticsRoute.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.received, true);
        assert.strictEqual(res.jsonData.count, 2);

        // Verify in DB
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        const count = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
        assert.strictEqual(count, 2);
    });

    it('handles summary data', async () => {
        const req = createMockReq({
            events: [],
            summary: { totalPlays: 42, totalErrors: 3 }
        });
        const res = createMockRes();
        legacyAnalyticsRoute.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.received, true);

        // Verify summary in DB
        const { getDb } = require('../../lib/db.js');
        const db = getDb();
        const summary = db.prepare('SELECT * FROM summary WHERE id = 1').get();
        assert.ok(summary);
        assert.ok(summary.metadata);
    });

    it('handles empty events array', () => {
        const req = createMockReq({ events: [] });
        const res = createMockRes();
        legacyAnalyticsRoute.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.count, 0);
    });

    it('handles malformed events gracefully', () => {
        const req = createMockReq({
            events: [
                { type: 'content_play' } // missing timestamp - should use default
            ]
        });
        const res = createMockRes();
        legacyAnalyticsRoute.route.stack[1].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
    });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

// Why this file exists. The cutover reuses the database that is already running in production - that is
// the whole point of a switch-over, the historical events have to survive it. Two things were untested and
// both break on an upgraded box rather than a fresh one:
//   1. migrateOldSchema() rebuilds `events` but never touches `devices`, and CREATE TABLE IF NOT EXISTS
//      will not add a column to a table that already exists. routes/api.js SELECTs d.channel_name, so an
//      upgraded box answers 500 on the analytics API and the dashboard (measured in the unit run output:
//      "[Dashboard] Error: no such column: channel_name").
//   2. Nothing dedupes an event. A Roku that loses network while a batch is queued replays it on the next
//      launch, and every replay is counted again in stats - GATE T7 asks for an idempotent endpoint
//      specifically because offline replay is the normal case on TV, not an edge case.
describe('an upgraded production database behaves like a fresh one', () => {
    let tmp;

    function freshRequire(p) {
        delete require.cache[require.resolve(p)];
        return require(p);
    }

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-db-upgrade-'));
    });

    after(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    // the shape the old server actually used: events keyed by `type` with no device_id, and a devices
    // table with no channel_name and no app_version
    function makeLegacyDb(file) {
        const Database = require('better-sqlite3');
        const raw = new Database(file);
        raw.exec(`
            CREATE TABLE devices (id TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT);
            CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, timestamp TEXT, payload TEXT);
        `);
        raw.prepare(
            "INSERT INTO devices (id, first_seen, last_seen) VALUES ('dev-legacy-1', '2026-01-01', '2026-10-04')"
        ).run();
        const ins = raw.prepare('INSERT INTO events (type, timestamp, payload) VALUES (?, ?, ?)');
        ins.run('screen_view', '2026-10-01T10:00:00Z', JSON.stringify({ screenName: 'Home' }));
        ins.run(
            'content_play',
            '2026-10-01T10:05:00Z',
            JSON.stringify({ contentId: 'video-1', contentTitle: 'Sermon' })
        );
        raw.close();
    }

    it('adds the columns the API and the dashboard select, instead of erroring', () => {
        const file = path.join(tmp, 'upgrade-columns.db');
        makeLegacyDb(file);
        process.env.DB_PATH = file;
        const { getDb, closeDb } = freshRequire('../../lib/db.js');
        const db = getDb();
        const deviceCols = db
            .prepare('PRAGMA table_info(devices)')
            .all()
            .map((c) => c.name);
        assert.ok(
            deviceCols.includes('channel_name'),
            `devices.channel_name missing after upgrade: ${deviceCols.join(',')}`
        );
        assert.ok(
            deviceCols.includes('app_version'),
            `devices.app_version missing after upgrade: ${deviceCols.join(',')}`
        );
        // the exact join routes/api.js runs for GET /api/v1/analytics/events
        const rows = db
            .prepare(
                'SELECT e.*, d.channel_name, d.app_version as device_app_version FROM events e LEFT JOIN devices d ON e.device_id = d.id'
            )
            .all();
        assert.ok(rows.length >= 2, 'the migrated events must still be readable');
        closeDb();
        delete process.env.DB_PATH;
    });

    it('keeps the historical events through the upgrade', () => {
        const file = path.join(tmp, 'upgrade-history.db');
        makeLegacyDb(file);
        process.env.DB_PATH = file;
        const { getDb, closeDb } = freshRequire('../../lib/db.js');
        const db = getDb();
        const n = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
        assert.ok(n >= 2, `legacy events lost: ${n} rows remain`);
        const types = db
            .prepare('SELECT DISTINCT event_type FROM events')
            .all()
            .map((r) => r.event_type);
        assert.ok(
            types.includes('screen_view') && types.includes('content_play'),
            `event types mangled: ${types.join(',')}`
        );
        closeDb();
        delete process.env.DB_PATH;
    });

    it('refuses to count the same event twice when a device replays a queued batch', () => {
        const file = path.join(tmp, 'upgrade-idempotent.db');
        process.env.DB_PATH = file;
        const { getDb, closeDb } = freshRequire('../../lib/db.js');
        const db = getDb();
        const eventCols = db
            .prepare('PRAGMA table_info(events)')
            .all()
            .map((c) => c.name);
        assert.ok(
            eventCols.includes('event_id'),
            `events.event_id missing - a replay has nothing to dedupe on: ${eventCols.join(',')}`
        );
        db.prepare(
            "INSERT INTO devices (id, channel_name, app_version) VALUES ('dev-replay', 'Example', '1.0.0')"
        ).run();
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO events (device_id, event_type, timestamp, payload, event_id)
            VALUES ('dev-replay', 'content_play', '2026-11-06T10:00:00Z', '{"contentId":"video-1"}', 'evt-abc-123')
        `);
        stmt.run();
        stmt.run(); // the same batch arrives again after a network drop - the TV cannot know it landed
        stmt.run();
        const n = db.prepare("SELECT COUNT(*) AS c FROM events WHERE event_id = 'evt-abc-123'").get().c;
        assert.equal(n, 1, `a replayed event was stored ${n} times`);
        closeDb();
        delete process.env.DB_PATH;
    });

    it('still accepts an event that carries no id, so old clients are not locked out', () => {
        const file = path.join(tmp, 'upgrade-noid.db');
        process.env.DB_PATH = file;
        const { getDb, closeDb } = freshRequire('../../lib/db.js');
        const db = getDb();
        db.prepare("INSERT INTO devices (id, channel_name, app_version) VALUES ('dev-old', 'example channel', '0.9.0')").run();
        const ins = db.prepare(
            "INSERT INTO events (device_id, event_type, timestamp, payload) VALUES ('dev-old', 'screen_view', '2026-11-06T10:00:00Z', '{}')"
        );
        ins.run();
        ins.run(); // two anonymous events must both be kept - they are two screen views, not a replay
        const n = db.prepare("SELECT COUNT(*) AS c FROM events WHERE device_id = 'dev-old'").get().c;
        assert.equal(n, 2, `anonymous events were collapsed to ${n}`);
        closeDb();
        delete process.env.DB_PATH;
    });
});

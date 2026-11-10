const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'analytics.db');
let db = null;

function getDb() {
    if (db) return db;

    // Ensure directory exists
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    try {
        db = new Database(DB_PATH);
    } catch (err) {
        console.error('[DB] Failed to open database:', err.message);
        throw err;
    }
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Migrate old events table if it exists
    migrateOldSchema();

    // Create new devices table
    db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            channel_name TEXT,
            app_version TEXT,
            first_seen TEXT DEFAULT (datetime('now')),
            last_seen TEXT DEFAULT (datetime('now'))
        )
    `);

    // Create new events table
    db.exec(`
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            event_type TEXT NOT NULL CHECK(event_type IN ('screen_view', 'content_play', 'deep_link', 'error', 'interaction', 'playback_state', 'unknown')),
            timestamp TEXT NOT NULL,
            session_duration INTEGER,
            app_version TEXT,
            payload TEXT NOT NULL,
            received_at TEXT DEFAULT (datetime('now')),
            event_id TEXT,
            FOREIGN KEY(device_id) REFERENCES devices(id)
        )
    `);

    // An already-installed analytics.db is not rebuilt by CREATE TABLE IF NOT EXISTS, so every column

    // the current code selects must be added explicitly. A cutover reuses the production database, and

    // the failure mode otherwise is a fresh box that works and an upgraded box that answers 500.

    upgradeTable('events', 'event_id', 'TEXT');

    upgradeTable('devices', 'channel_name', 'TEXT');

    upgradeTable('devices', 'app_version', 'TEXT');

    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id)');

    // Create indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
        CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id);
    `);

    // Create summary table for backward compat
    db.exec(`
        CREATE TABLE IF NOT EXISTS summary (
            id INTEGER PRIMARY KEY,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            metadata TEXT
        )
    `);

    // Create subscription tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS subscription_customers (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            product_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id TEXT,
            subscriber_id TEXT NOT NULL,
            product_id TEXT,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'cancelled', 'expired', 'pending')),
            started_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT,
            cancelled_at TEXT,
            FOREIGN KEY(customer_id) REFERENCES subscription_customers(id)
        )
    `);

    // Create indexes for subscriptions
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON subscriptions(subscriber_id);
        CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
    `);

    // Create plans table
    db.exec(`
        CREATE TABLE IF NOT EXISTS plans (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            interval TEXT CHECK(interval IN ('month', 'year')),
            active INTEGER DEFAULT 1
        )
    `);

    // Create prices table
    db.exec(`
        CREATE TABLE IF NOT EXISTS prices (
            id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            amount_cents INTEGER NOT NULL,
            currency TEXT DEFAULT 'usd',
            interval TEXT CHECK(interval IN ('month', 'year')),
            active INTEGER DEFAULT 1,
            FOREIGN KEY(plan_id) REFERENCES plans(id)
        )
    `);

    // Seed default plans
    db.exec(`
        INSERT OR IGNORE INTO plans (id, name, description, interval, active) VALUES
            ('plan_monthly', 'Monthly', 'Monthly subscription', 'month', 1),
            ('plan_yearly', 'Yearly', 'Annual subscription (save 20%)', 'year', 1)
    `);

    // Seed default prices
    db.exec(`
        INSERT OR IGNORE INTO prices (id, plan_id, amount_cents, currency, interval, active) VALUES
            ('price_monthly', 'plan_monthly', 999, 'usd', 'month', 1),
            ('price_yearly', 'plan_yearly', 9999, 'usd', 'year', 1)
    `);

    return db;
}

// Add a column if it is missing. Cheap, idempotent, and it keeps a long-lived analytics.db usable by
// code that expects the current schema.
function upgradeTable(table, column, type) {
    const cols = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
    if (!cols.includes(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        console.log(`[DB] Upgraded ${table}: added ${column}`);
    }
}

function migrateOldSchema() {
    try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        const tableNames = tables.map((t) => t.name);

        if (!tableNames.includes('events')) return;

        const oldColNames = db
            .prepare('PRAGMA table_info(events)')
            .all()
            .map((c) => c.name);

        // Check if already migrated (new schema has device_id column)
        if (oldColNames.includes('device_id')) return;

        console.log('[DB] Migrating old events schema to new schema...');

        // Save old data before any mutations
        const oldEvents = db.prepare('SELECT * FROM events').all();

        // Wrap migration in a transaction for atomicity - if any step fails,
        // the old table is preserved and no partial state is left behind.
        const migrate = db.transaction(() => {
            // Rename old table
            db.exec('ALTER TABLE events RENAME TO events_old');

            // Create new schema
            db.exec(`
                CREATE TABLE events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    event_type TEXT NOT NULL CHECK(event_type IN ('screen_view', 'content_play', 'deep_link', 'error', 'interaction', 'playback_state', 'unknown')),
                    timestamp TEXT NOT NULL,
                    session_duration INTEGER,
                    app_version TEXT,
                    payload TEXT NOT NULL,
                    received_at TEXT DEFAULT (datetime('now')),
                    FOREIGN KEY(device_id) REFERENCES devices(id)
                )
            `);
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
                CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
                CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
            `);

            // The migrated rows are attributed to a placeholder device, so that device must exist before they

            // are inserted or the foreign key rejects every row and the whole migration rolls back silently.

            db.exec("INSERT OR IGNORE INTO devices (id) VALUES ('legacy')");
            // the label is nice to have, not required: on a legacy database devices.channel_name does not
            // exist yet, so it is set after the column is added rather than in the migration itself
            try {
                db.prepare(
                    "UPDATE devices SET channel_name = 'legacy (migrated)' WHERE id = 'legacy' AND channel_name IS NULL"
                ).run();
            } catch {
                // no channel_name column yet - the upgrade adds it and the label stays NULL, which is fine
            }

            // Migrate old events (map old columns to new)
            if (oldEvents.length > 0) {
                const insert = db.prepare(`
                    INSERT INTO events (device_id, event_type, timestamp, session_duration, app_version, payload, received_at)
                    VALUES (@device_id, @event_type, @timestamp, @session_duration, @app_version, @payload, @received_at)
                `);
                const insertMany = db.transaction((rows) => {
                    for (const row of rows) {
                        insert.run({
                            device_id: 'legacy',
                            event_type: row.type || 'unknown',
                            timestamp: row.timestamp || new Date().toISOString(),
                            session_duration: null,
                            app_version: null,
                            payload: row.metadata
                                ? JSON.stringify(row.metadata)
                                : JSON.stringify({ title: row.title, errorMessage: row.error }),
                            received_at: new Date().toISOString()
                        });
                    }
                });
                insertMany(oldEvents);
            }

            // Drop old table (only after data is safely migrated)
            db.exec('DROP TABLE IF EXISTS events_old');
        });

        migrate();
        console.log(`[DB] Migrated ${oldEvents.length} events from old schema.`);
    } catch (err) {
        console.error('[DB] Migration error:', err.message);
    }
}

function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

/**
 * The cutoff for "active in the last N days", written in the exact UTC text format `devices.last_seen` is
 * stored in (`datetime('now')`), so a plain string comparison is the right comparison.
 *
 * Both device callers used to hand SQLite a *modifier* (`-7 days`) as the whole argument of `datetime(?)`,
 * and `datetime('-7 days')` is NULL - SQLite wants a time-value base, as in `datetime('now', '-7 days')`.
 * Measured 2026-11-09: a device row seen one second ago was absent from `/devices` (the page said "No
 * devices found") and from `GET /api/v1/analytics/devices` at its default window, while `?activeDays=all`
 * - which passes a literal timestamp, not a modifier - listed it. So the operator's device list was empty
 * for every window except "All time", and nothing anywhere raised an error. The cutoff is computed once,
 * here, because the same three lines sit in two callers, which is how one SQLite mistake became two.
 */
function activeSince(days) {
    const value = Number.parseInt(days, 10);
    const safe = Number.isFinite(value) && value >= 0 ? value : 7;
    return new Date(Date.now() - safe * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { getDb, closeDb, activeSince };

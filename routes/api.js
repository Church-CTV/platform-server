const express = require('express');
const fs = require('fs-extra');
const router = express.Router();
const path = require('path');

const { getDb, activeSince } = require('../lib/db');
const { validateBatchPayload, sanitizePayload, validateEvent } = require('../lib/eventValidator');
const { getRateLimitMiddleware } = require('../middleware/rateLimit');
const { rateLimitValue } = require('../lib/rateLimits');
const { createExperimentalBillingGuard } = require('../middleware/experimentalBilling');

router.use(['/checkout', '/subscription', '/webhook/stripe'], createExperimentalBillingGuard());

// Rate limit analytics ingestion (budget + the measurement that sized it: `lib/rateLimits.js`)
const analyticsRateLimit = getRateLimitMiddleware(rateLimitValue('analytics'), 60000, 'analytics');
const heartbeatRateLimit = getRateLimitMiddleware(rateLimitValue('heartbeat'), 60000, 'heartbeat');

// Cached prepared statements for analytics queries
let stmtCache = null;

function getStmtCache() {
    if (stmtCache) return stmtCache;
    const db = getDb();
    stmtCache = {
        selectEvents: db.prepare(`
            SELECT e.*, d.channel_name, d.app_version as device_app_version
            FROM events e LEFT JOIN devices d ON e.device_id = d.id
            WHERE 1=1
        `),
        // the count must join the same tables the row query joins: a filter on d.channel_name is only
        // satisfiable if the count query can see devices, otherwise search renders an empty page while the
        // rows are sitting right there (the dashboard swallows the SQL error and shows nothing).
        countEvents: db.prepare(
            'SELECT COUNT(*) as total FROM events e LEFT JOIN devices d ON e.device_id = d.id WHERE 1=1'
        ),
        selectDistinctEventTypes: db.prepare('SELECT DISTINCT event_type FROM events ORDER BY event_type'),
        upsertDevice: db.prepare(`
            INSERT INTO devices (id, channel_name, app_version, first_seen, last_seen)
            VALUES (@id, @channel_name, @app_version, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
                channel_name = COALESCE(excluded.channel_name, channel_name),
                app_version = COALESCE(excluded.app_version, app_version),
                last_seen = datetime('now')
        `),
        insertEvent: db.prepare(`
            -- OR IGNORE: the unique index on event_id is the idempotency guard. A TV that never received its
            -- acknowledgement sends the same event again on the next launch, and that replay must be invisible
            -- in the numbers instead of counted a second time.
            INSERT OR IGNORE INTO events (device_id, event_type, timestamp, session_duration, app_version, payload, received_at, event_id)
            VALUES (@device_id, @event_type, @timestamp, @session_duration, @app_version, @payload, datetime('now'), @event_id)
        `),
        upsertSummary: db.prepare(`
            INSERT INTO summary (id, timestamp, metadata)
            VALUES (1, @timestamp, @metadata)
            ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, metadata = excluded.metadata
        `),
        upsertLegacyDevice: db.prepare(`
            INSERT INTO devices (id, channel_name, app_version, first_seen, last_seen)
            VALUES ('legacy', 'Legacy Client', null, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now')
        `),
        selectActiveSubscriptions: db.prepare(`
            SELECT id, subscriber_id, product_id, status, started_at, expires_at
            FROM subscriptions
            WHERE subscriber_id = @subscriberId AND status = 'active'
            ORDER BY started_at DESC LIMIT 1
        `),
        updateSubscriptions: db.prepare(`
            UPDATE subscriptions
            SET status = 'cancelled', cancelled_at = datetime('now')
            WHERE subscriber_id = @subscriberId AND status = 'active'
        `),
        selectExistingSubscription: db.prepare(`
            SELECT id FROM subscriptions
            WHERE subscriber_id = @subscriberId AND status IN ('active', 'pending')
        `),
        insertSubscription: db.prepare(`
            INSERT INTO subscriptions (subscriber_id, product_id, status, started_at, expires_at)
            VALUES (@subscriberId, @productId, 'active', datetime('now'), @expiresAt)
        `),
        updateSubscriptionActive: db.prepare(`
            UPDATE subscriptions
            SET status = 'active', started_at = datetime('now')
            WHERE id = @id
        `),
        updateSubscriptionStatus: db.prepare(`
            UPDATE subscriptions
            SET status = @status, expires_at = @expiresAt
            WHERE subscriber_id = @subscriberId
        `),
        selectSubscriptions: db.prepare(`
            SELECT id, subscriber_id, product_id, status, started_at, expires_at
            FROM subscriptions
            WHERE subscriber_id = @subscriberId
            AND status = 'active'
            ORDER BY started_at DESC
            LIMIT 1
        `),
        selectPlans: db.prepare(`
            SELECT id, name, description, interval, active
            FROM plans
            WHERE active = 1
            ORDER BY name
        `),
        selectPrices: db.prepare(`
            SELECT id, plan_id, amount_cents, currency, interval, active
            FROM prices
            WHERE active = 1
            ORDER BY plan_id, amount_cents
        `),
        upsertCustomer: db.prepare(`
            INSERT INTO subscription_customers (id, email, product_id, created_at)
            VALUES (@id, @email, @product_id, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
                email = excluded.email,
                product_id = COALESCE(excluded.product_id, product_id),
                updated_at = datetime('now')
        `),
        selectDevices: db.prepare(`
            SELECT id, channel_name, app_version, first_seen, last_seen,
                   (SELECT COUNT(*) FROM events e WHERE e.device_id = d.id) as event_count
            FROM devices d
            WHERE last_seen >= ?
            ORDER BY last_seen DESC
        `),
        countEventsByType: db.prepare('SELECT COUNT(*) as count FROM events WHERE event_type = ?'),
        selectEventsByType: db.prepare(`
            SELECT json_extract(payload, '$.contentTitle') as title, COUNT(*) as count
            FROM events WHERE event_type = ? GROUP BY title ORDER BY count DESC LIMIT 10
        `),
        selectErrorsByType: db.prepare(`
            SELECT timestamp, json_extract(payload, '$.errorType') as errorType, json_extract(payload, '$.errorMessage') as error
            FROM events WHERE event_type = ? ORDER BY timestamp DESC LIMIT 20
        `),
        selectEventsByTypeAndTime: db.prepare(`
            SELECT COUNT(*) as count FROM events WHERE event_type = ? AND received_at >= datetime(?)
        `),
        selectEventsByTime: db.prepare('SELECT COUNT(*) as count FROM events WHERE received_at >= datetime(?)'),
        selectDistinctDevices: db.prepare(
            'SELECT COUNT(DISTINCT device_id) as count FROM events WHERE received_at >= datetime(?)'
        )
    };
    return stmtCache;
}

// Helper: extract device_id from payload
function getDeviceId(payload) {
    if (payload.deviceInfo && typeof payload.deviceInfo === 'object') {
        return payload.deviceInfo.deviceId || payload.deviceInfo.device_id || 'roku-client';
    }
    // A client that names itself at the top level is not anonymous. Until 2026-11-09 only `deviceInfo`
    // was read, so every payload shaped `{deviceId, screenViews: [...]}` - the queued export the shipped
    // clients post - was filed under one shared `roku-client` row, and a channel with a hundred televisions
    // looked like one television with a hundred sessions. GATE T7 counts devices; the name has to be read.
    if (typeof payload.deviceId === 'string' && payload.deviceId) return payload.deviceId;
    if (typeof payload.device_id === 'string' && payload.device_id) return payload.device_id;
    return 'roku-client';
}

// Helper: store a single event to DB
function storeEvent(cache, deviceId, event) {
    const eventType = event.eventType || event.event_type || 'unknown';
    const payloadObj = {
        eventType: event.eventType || event.event_type
    };
    const skipFields = ['eventType', 'event_type', 'timestamp', 'Timestamp', 'sessionDuration', 'session_duration'];
    for (const [key, value] of Object.entries(event)) {
        if (!skipFields.includes(key)) {
            payloadObj[key] = value;
        }
    }

    cache.insertEvent.run({
        // the client's own id, when it has one; anonymous events stay NULL and are never
        // deduped against each other, because two identical screen views are two real views
        event_id: event.eventId || event.event_id || event.id || null,
        device_id: deviceId,
        event_type: eventType,
        timestamp: event.timestamp || event.Timestamp || new Date().toISOString(),
        session_duration:
            event.sessionDuration !== undefined && event.sessionDuration !== null
                ? Number(event.sessionDuration)
                : null,
        app_version: event.appVersion || null,
        payload: JSON.stringify(sanitizePayload(payloadObj))
    });
}

/**
 * Collect the candidate events from any of the four payload shapes a shipped client has ever sent,
 * in order, so the endpoint can say what it stored and what it refused.
 */
const EVENT_CATEGORIES = ['screenViews', 'plays', 'deepLinks', 'errors'];

function collectCandidateEvents(payload) {
    // Queued export container. Since 2026-11-09 this shape is a CONTAINER, not a leaf: a shipped client
    // sends `{eventType, timestamp, appVersion, sessionDuration, screenViews: [], plays: [], deepLinks: [],
    // errors: []}`, where the categories hold the actual events (measured in `source/AnalyticsExport.brs`
    // of the Roku template, and modelled by `tests/unit/test-analytics-export.mjs`). Treating the
    // container as one event stored a single row whose payload was the wrapper, so `screenName` and
    // `contentId` - the two fields the contract requires - never reached the database, and a session with
    // six screen views counted as one.
    //
    // The categories, not the wrapper's `eventType`, are what make it a container. The first version of
    // this branch was gated on `payload.eventType` being a string, so the same export without that field -
    // which is what the Android TV/Fire TV client sends, and what the stage measured on 2026-11-09 - fell
    // through every branch and was answered `{received:true,count:0,refused:[]}`: events in, nothing
    // stored, nothing named.
    const wrapped = EVENT_CATEGORIES.filter((name) => Array.isArray(payload[name]));
    if (wrapped.length > 0) {
        const carrier = { ...payload };
        for (const name of EVENT_CATEGORIES) delete carrier[name];
        const flat = [];
        let index = 0;
        for (const name of EVENT_CATEGORIES) {
            const items = payload[name];
            if (!Array.isArray(items)) continue;
            for (const item of items) {
                if (item && typeof item === 'object') flat.push({ event: { ...carrier, ...item }, index: index++ });
            }
        }
        return { events: flat, recognised: true };
    }
    // A payload that is itself one event (no categories anywhere) is still a legitimate delivery.
    if (typeof payload.eventType === 'string') return { events: [{ event: payload, index: 0 }], recognised: true };
    // Roku structured payload: { events: { screenViews: [], plays: [], deepLinks: [], errors: [] } }
    if (payload.events && typeof payload.events === 'object' && !Array.isArray(payload.events)) {
        const flat = [];
        let index = 0;
        for (const category of EVENT_CATEGORIES) {
            const items = payload.events[category];
            if (Array.isArray(items)) {
                for (const item of items) {
                    if (item && typeof item === 'object') flat.push({ event: item, index: index++ });
                }
            }
        }
        return { events: flat, recognised: true };
    }
    // An empty queue is a delivery that carries nothing, and is answered as one - not a refusal.
    if (Array.isArray(payload.events))
        return { events: payload.events.map((event, index) => ({ event, index })), recognised: true };
    if (Array.isArray(payload.Events))
        return { events: payload.Events.map((event, index) => ({ event, index })), recognised: true };
    return { events: [], recognised: false };
}

// POST /analytics - Roku client analytics export endpoint
// Accepts the Roku client's structured payload format:
// { appVersion, sessionStartTime, activeScreen, eventCount, summary: {...}, events: { screenViews: [...], plays: [...], deepLinks: [...], errors: [...] } }
// Also accepts queued event format: { eventType, timestamp, appVersion, screenViews, plays, deepLinks, errors, sessionDuration }
router.post('/analytics', analyticsRateLimit, (req, res) => {
    try {
        const payload = req.body;
        if (!payload || typeof payload !== 'object') {
            return res.status(400).json({ error: 'Expected JSON payload' });
        }

        const cache = getStmtCache();
        const db = getDb();
        const deviceId = getDeviceId(payload);
        const channelName = payload.deviceInfo?.channelName || null;
        const appVersion = payload.deviceInfo?.appVersion || payload.appVersion || null;

        // The event contract is enforced HERE, on the endpoint every shipped client actually posts to
        // (`analytics.exportUrl` in the published configuration names this route). Until 2026-11-09 this
        // handler inserted whatever arrived: one event whose type sat outside the schema tripped the
        // database's own CHECK, the transaction rolled back inside the outer catch, and the client was
        // answered `{received:true,count:2}` with zero rows stored - lost rows no reconciliation could
        // find. `/api/v1/analytics` already validated; the busier sibling did not.
        const { events: candidates, recognised } = collectCandidateEvents(payload);
        const accepted = [];
        const refused = [];
        if (!recognised) {
            // Fail closed by naming it. The reconciliation GATE T7 promises is emitted = stored + refused,
            // and a body that was never an event batch satisfies it only if somebody says so.
            refused.push({ index: null, eventType: null, reasons: ['no-event-shape-recognised'] });
        }
        for (const { event, index } of candidates) {
            const verdict = validateEvent(event);
            if (verdict.valid) {
                accepted.push(event);
            } else {
                refused.push({
                    index,
                    eventType: typeof event?.eventType === 'string' ? event.eventType : (event?.event_type ?? null),
                    reasons: verdict.errors
                });
            }
        }

        // Upsert device
        cache.upsertDevice.run({
            id: deviceId,
            channel_name: channelName || null,
            app_version: appVersion || null
        });

        let storedCount = 0;
        if (accepted.length > 0) {
            const insertMany = db.transaction((eventsToInsert) => {
                for (const event of eventsToInsert) {
                    storeEvent(cache, deviceId, event);
                }
            });
            insertMany(accepted);
            storedCount = accepted.length;
        }

        // Store summary if present
        if (payload.summary && typeof payload.summary === 'object') {
            cache.upsertSummary.run({
                timestamp: new Date().toISOString(),
                metadata: JSON.stringify(sanitizePayload(payload.summary))
            });
        }

        if (refused.length > 0) {
            console.warn(
                `[Analytics] refused ${refused.length}/${candidates.length} event(s) from ${deviceId}: ` +
                    refused.map((entry) => entry.reasons.join('; ')).join(' | ')
            );
        }

        // A refused event is acknowledged, not retried: a client that cannot build a legal event will
        // never build one, and its durable queue is bounded. The reason travels with the answer, and
        // `count` stays exactly the number of rows stored, so emitted = stored + refused and the GATE
        // T7 reconciliation has something true to add up.
        res.json({ received: true, count: storedCount, refused });
    } catch (err) {
        // A failure here is the server's, not the client's: answer 500 so a client with a durable queue
        // keeps the batch instead of acknowledging it.
        console.error('[Analytics] Error:', err.message);
        res.status(500).json({ error: 'Failed to store analytics' });
    }
});

// Legacy endpoint: POST /api/analytics/legacy (backward compatible flat-array format)
// Distinct from the Roku client endpoint above, which is also POST /analytics.
router.post('/analytics/legacy', analyticsRateLimit, (req, res) => {
    try {
        const { events, summary } = req.body;
        if (!events || !Array.isArray(events)) {
            return res.status(400).json({ error: 'Expected events array' });
        }

        const cache = getStmtCache();
        const db = getDb();

        // Ensure legacy device exists for foreign key
        cache.upsertLegacyDevice.run();

        const validTypes = ['screen_view', 'content_play', 'deep_link', 'error', 'interaction', 'playback_state'];
        const insertMany = db.transaction((eventsToInsert) => {
            for (const event of eventsToInsert) {
                const payloadObj = {};
                if (event.title) payloadObj.contentTitle = event.title;
                if (event.error) payloadObj.errorMessage = event.error;
                if (event.metadata) payloadObj.context = event.metadata;

                const eventType = validTypes.includes(event.type) ? event.type : 'unknown';
                const sanitized = sanitizePayload(payloadObj);

                cache.insertEvent.run({
                    // the client's own id, when it has one; anonymous events stay NULL and are never
                    // deduped against each other, because two identical screen views are two real views
                    event_id: event.eventId || event.event_id || event.id || null,
                    device_id: 'legacy',
                    event_type: eventType,
                    timestamp: event.timestamp || new Date().toISOString(),
                    session_duration: null,
                    app_version: null,
                    payload: JSON.stringify(sanitized)
                });
            }
        });

        insertMany(events);

        if (summary) {
            cache.upsertSummary.run({
                timestamp: new Date().toISOString(),
                metadata: JSON.stringify(sanitizePayload(summary))
            });
        }
        res.json({ received: true, count: events.length });
    } catch (err) {
        console.error('[Analytics] Error:', err.message);
        res.status(500).json({ error: 'Failed to store analytics' });
    }
});

// POST /api/v1/analytics - Full event ingestion
router.post('/v1/analytics', analyticsRateLimit, (req, res) => {
    try {
        const payload = req.body;
        const validation = validateBatchPayload(payload);

        if (!validation.valid) {
            return res.status(400).json({ error: 'Invalid payload', details: validation.errors });
        }

        const cache = getStmtCache();
        const db = getDb();

        // Upsert device
        const deviceId = payload.deviceInfo?.deviceId || 'unknown';
        const deviceInfo = payload.deviceInfo || {};

        cache.upsertDevice.run({
            id: deviceId,
            channel_name: deviceInfo.channelName || null,
            app_version: deviceInfo.appVersion || null
        });

        // Insert validated events
        const insertMany = db.transaction((eventsToInsert) => {
            for (const { event, eventType } of eventsToInsert) {
                const sanitized = sanitizePayload(event);
                cache.insertEvent.run({
                    // the client's own id, when it has one; anonymous events stay NULL and are never
                    // deduped against each other, because two identical screen views are two real views
                    event_id: event.eventId || event.event_id || event.id || null,
                    device_id: deviceId,
                    event_type: eventType,
                    timestamp: event.timestamp || event.Timestamp || new Date().toISOString(),
                    session_duration:
                        event.sessionDuration !== undefined && event.sessionDuration !== null
                            ? Number(event.sessionDuration)
                            : null,
                    app_version: event.appVersion || null,
                    payload: JSON.stringify(sanitized)
                });
            }
        });

        insertMany(validation.accepted.map((a) => a));

        res.json({
            accepted: validation.accepted.length,
            rejected: validation.rejected.length
        });
    } catch (err) {
        console.error('[Analytics] Error:', err.message);
        res.status(500).json({ error: 'Failed to store analytics' });
    }
});

// GET /api/v1/analytics/events - Query events with filters
router.get('/v1/analytics/events', (req, res) => {
    try {
        const cache = getStmtCache();
        const { eventType, deviceId, startDate, endDate, limit = 100, offset = 0 } = req.query;

        const params = {
            limit: parseInt(limit, 10),
            offset: parseInt(offset, 10)
        };

        let query = cache.selectEvents.source;
        let countQuery = cache.countEvents.source;
        const countParams = {};

        if (eventType) {
            query += ' AND e.event_type = @eventType';
            params.eventType = eventType;
            countQuery += ' AND event_type = @eventType';
            countParams.eventType = eventType;
        }

        if (deviceId) {
            query += ' AND e.device_id = @deviceId';
            params.deviceId = deviceId;
            countQuery += ' AND device_id = @deviceId';
            countParams.deviceId = deviceId;
        }

        if (startDate) {
            query += ' AND datetime(e.received_at) >= datetime(@startDate)';
            params.startDate = startDate;
            countQuery += ' AND datetime(received_at) >= datetime(@startDate)';
            countParams.startDate = startDate;
        }

        if (endDate) {
            query += ' AND datetime(e.received_at) <= datetime(@endDate)';
            params.endDate = endDate;
            countQuery += ' AND datetime(received_at) <= datetime(@endDate)';
            countParams.endDate = endDate;
        }

        query += ' ORDER BY e.received_at DESC LIMIT @limit OFFSET @offset';

        const db = getDb();
        const events = db.prepare(query).all(params);

        // Parse JSON payload for display
        const parsed = events.map((e) => {
            let parsedPayload = null;
            if (e.payload) {
                try {
                    parsedPayload = JSON.parse(e.payload);
                } catch (err) {
                    console.error('[API] Failed to parse event payload:', err.message);
                }
            }
            return { ...e, payload: parsedPayload };
        });

        const total = db.prepare(countQuery).get(countParams).total;

        res.json({
            events: parsed,
            pagination: {
                total,
                limit: parseInt(limit, 10),
                offset: parseInt(offset, 10)
            }
        });
    } catch (err) {
        console.error('[Analytics] Error querying events:', err.message);
        res.status(500).json({ error: 'Failed to query events' });
    }
});

// GET /api/v1/analytics/stats - Aggregated stats
router.get('/v1/analytics/stats', (req, res) => {
    try {
        const db = getDb();
        const { period = '7d', groupBy = 'day' } = req.query;

        // Whitelist period values to prevent SQL injection
        const validPeriods = ['7d', '30d', '90d', 'all'];
        const validatedPeriod = validPeriods.includes(period) ? period : '7d';

        // Whitelist groupBy values to prevent SQL injection
        const validGroups = ['day', 'week', 'month'];
        const validatedGroup = validGroups.includes(groupBy) ? groupBy : 'day';

        // Calculate date range - values are whitelisted so direct interpolation is safe
        const dateFilters = {
            '7d': "datetime('now', '-7 days')",
            '30d': "datetime('now', '-30 days')",
            '90d': "datetime('now', '-90 days')",
            all: "'1970-01-01 00:00:00'"
        };
        const dateFilter = dateFilters[validatedPeriod];

        // Build date grouping expression (safe - whitelist validated above)
        const groupExpressions = {
            day: "strftime('%Y-%m-%d', received_at)",
            week: "strftime('%Y-%W', received_at)",
            month: "strftime('%Y-%m', received_at)"
        };
        const dateGroupExpr = groupExpressions[validatedGroup];

        // NOTE: dateFilter values are SQL expressions (datetime('now', '-7 days')),
        // not literal values. Parameterized ? treats them as literal strings, so we
        // must interpolate directly. Values are whitelisted above - safe from injection.
        const df = dateFilter;

        // Event type breakdown
        const typeBreakdown = db
            .prepare(
                `SELECT event_type, COUNT(*) as count FROM events WHERE received_at >= ${df} GROUP BY event_type ORDER BY count DESC`
            )
            .all();

        // Time series data
        /* eslint-disable-next-line no-unused-vars */
        const _timeSeries = db
            .prepare(
                `SELECT ${dateGroupExpr} as period, COUNT(*) as count FROM events WHERE received_at >= ${df} GROUP BY period ORDER BY period ASC`
            )
            .all();

        // Distinct device count
        /* eslint-disable-next-line no-unused-vars */
        const _distinctDevices = db
            .prepare(`SELECT COUNT(DISTINCT device_id) as count FROM events WHERE received_at >= ${df}`)
            .get();

        // Top videos by plays
        /* eslint-disable-next-line no-unused-vars */
        const _topVideos = db
            .prepare(
                `SELECT json_extract(payload, '$.contentTitle') as title, COUNT(*) as count FROM events WHERE event_type = 'content_play' AND received_at >= ${df} AND json_extract(payload, '$.contentTitle') IS NOT NULL GROUP BY title ORDER BY count DESC LIMIT 10`
            )
            .all();

        // Recent errors
        /* eslint-disable-next-line no-unused-vars */
        const _recentErrors = db
            .prepare(
                `SELECT timestamp, json_extract(payload, '$.errorType') as errorType, json_extract(payload, '$.errorMessage') as errorMessage FROM events WHERE event_type = 'error' AND received_at >= ${df} ORDER BY timestamp DESC LIMIT 20`
            )
            .all();

        // Events over time (for chart)
        const eventsOverTime = db
            .prepare(
                `SELECT ${dateGroupExpr} as period, COUNT(*) as count FROM events WHERE received_at >= ${df} GROUP BY period ORDER BY period`
            )
            .all();

        // Unique devices
        const uniqueDevices = db
            .prepare(`SELECT COUNT(DISTINCT device_id) as count FROM events WHERE received_at >= ${df}`)
            .get();

        // Top screens viewed
        const topScreens = db
            .prepare(
                `SELECT json_extract(payload, '$.screenName') AS screen_name, json_extract(payload, '$.contentTitle') AS content_title, json_extract(payload, '$.screen_name') AS screen_name_alt, COUNT(*) as count FROM events WHERE event_type = 'screen_view' AND received_at >= ${df} GROUP BY screen_name, content_title, screen_name_alt ORDER BY count DESC LIMIT 10`
            )
            .all();

        // Top content played
        const topContent = db
            .prepare(
                `SELECT json_extract(payload, '$.contentTitle') AS content_title, json_extract(payload, '$.contentId') AS content_id, COUNT(*) as count FROM events WHERE event_type = 'content_play' AND received_at >= ${df} GROUP BY content_title, content_id ORDER BY count DESC LIMIT 10`
            )
            .all();

        // Error breakdown
        const errorBreakdown = db
            .prepare(
                `SELECT json_extract(payload, '$.errorType') AS error_type, json_extract(payload, '$.context') AS context, COUNT(*) as count FROM events WHERE event_type = 'error' AND received_at >= ${df} GROUP BY error_type, context ORDER BY count DESC LIMIT 20`
            )
            .all();

        // Total events
        const totalEvents = db.prepare(`SELECT COUNT(*) as count FROM events WHERE received_at >= ${df}`).get();

        // Parse extracted fields for display
        const formatTopScreens = (row) => ({
            screenName: row.screen_name || row.screen_name_alt || 'Unknown',
            contentTitle: row.content_title || null,
            count: row.count
        });

        const formatTopContent = (row) => ({
            contentTitle: row.content_title || row.content_id || 'Unknown',
            contentId: row.content_id || null,
            count: row.count
        });

        const formatErrorBreakdown = (row) => ({
            errorType: row.error_type || 'Unknown',
            context: row.context || null,
            count: row.count
        });

        res.json({
            period: validatedPeriod,
            groupBy: validatedGroup,
            summary: {
                totalEvents: totalEvents.count,
                uniqueDevices: uniqueDevices.count
            },
            eventsOverTime: eventsOverTime.map((e) => ({ period: e.period, count: e.count })),
            typeBreakdown,
            topScreens: topScreens.map(formatTopScreens),
            topContent: topContent.map(formatTopContent),
            errorBreakdown: errorBreakdown.map(formatErrorBreakdown)
        });
    } catch (err) {
        console.error('[Analytics] Error computing stats:', err.message);
        res.status(500).json({ error: 'Failed to compute stats' });
    }
});

// GET /api/v1/analytics/devices - List devices
router.get('/v1/analytics/devices', (req, res) => {
    try {
        const cache = getStmtCache();
        const { activeDays = 7 } = req.query;

        // An absolute UTC timestamp, not a SQLite modifier: `datetime('-7 days')` is NULL and silently
        // matched no device at all (see `lib/db.js#activeSince`).
        const dateFilter = activeDays === 'all' ? '1970-01-01 00:00:00' : activeSince(activeDays);

        const devices = cache.selectDevices.all(dateFilter);

        res.json({ devices });
    } catch (err) {
        console.error('[Analytics] Error listing devices:', err.message);
        res.status(500).json({ error: 'Failed to list devices' });
    }
});

// POST /api/checkout - Subscription checkout
router.post('/checkout', analyticsRateLimit, (req, res) => {
    try {
        const cache = getStmtCache();
        const { productId, customerEmail } = req.body || {};
        if (!productId || !customerEmail) {
            return res.status(400).json({ error: 'productId and customerEmail are required' });
        }

        // Upsert customer
        cache.upsertCustomer.run({
            id: `cust_${productId}_${customerEmail.replace(/[^a-zA-Z0-9]/g, '_')}`,
            email: customerEmail,
            product_id: productId
        });

        // Generate checkout URL (simulated Stripe URL)
        const checkoutUrl = `https://checkout.stripe.com/pay/${Buffer.from(`${productId}:${Date.now()}`).toString('base64').substring(0, 24)}`;

        res.json({ url: checkoutUrl });
    } catch (err) {
        console.error('[Subscription] Checkout error:', err.message);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// GET /api/subscription/status - Check subscription status
router.get('/subscription/status', (req, res) => {
    try {
        const cache = getStmtCache();
        const { subscriberId } = req.query;
        if (!subscriberId) {
            return res.status(400).json({ error: 'subscriberId query parameter is required' });
        }

        // Check for active subscription
        const subscription = cache.selectActiveSubscriptions.get({ subscriberId });

        if (!subscription) {
            return res.json({ active: false, subscriberId });
        }

        const isActive = new Date(subscription.expires_at) > new Date();
        res.json({
            active: isActive,
            subscriberId: subscription.subscriber_id,
            productId: subscription.product_id,
            startedAt: subscription.started_at,
            expiresAt: subscription.expires_at
        });
    } catch (err) {
        console.error('[Subscription] Status error:', err.message);
        res.status(500).json({ error: 'Failed to get subscription status' });
    }
});

// POST /api/subscription/cancel - Cancel subscription
router.post('/subscription/cancel', analyticsRateLimit, (req, res) => {
    try {
        const cache = getStmtCache();
        const { subscriberId } = req.body || {};
        if (!subscriberId) {
            return res.status(400).json({ error: 'subscriberId is required' });
        }

        // Update active subscriptions to cancelled
        const updateResult = cache.updateSubscriptions.run({ subscriberId });

        if (updateResult.changes > 0) {
            res.json({ status: 'cancelled', subscriberId });
        } else {
            res.json({ status: 'not_found', subscriberId });
        }
    } catch (err) {
        console.error('[Subscription] Cancel error:', err.message);
        res.status(500).json({ error: 'Failed to cancel subscription' });
    }
});

// POST /api/webhook/stripe - Stripe webhook handler
router.post('/webhook/stripe', analyticsRateLimit, (req, res) => {
    try {
        const sig = req.headers['stripe-signature'];
        // Handle both raw string (from express.raw) and parsed object (from express.json)
        let body;
        if (typeof req.body === 'string') {
            body = req.body;
        } else if (Buffer.isBuffer(req.body)) {
            body = req.body.toString('utf8');
        } else {
            // Already parsed by express.json() - stringify for signature validation
            body = JSON.stringify(req.body);
        }

        // Validate Stripe webhook signature if secret is configured
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        if (webhookSecret && sig) {
            const crypto = require('crypto');
            const sigParts = sig.split(',');
            const timestamp = sigParts.find((part) => part.startsWith('t='))?.slice(2);
            const expectedSig = crypto.createHmac('sha256', webhookSecret).update(`${timestamp}.${body}`).digest('hex');
            const validSignature = sigParts
                .filter((part) => part.startsWith('v1='))
                .some((part) => {
                    const candidate = part.slice(3);
                    return (
                        /^[a-f0-9]{64}$/.test(candidate) &&
                        crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(candidate))
                    );
                });
            if (
                !/^\d+$/.test(timestamp || '') ||
                Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
                !validSignature
            ) {
                return res.status(400).json({ error: 'Invalid webhook signature' });
            }
        } else if (webhookSecret && !sig) {
            return res.status(400).json({ error: 'Missing Stripe signature' });
        }

        let parsedEvent;
        try {
            parsedEvent = typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : JSON.parse(body);
        } catch (err) {
            console.error('[API] Stripe webhook JSON parse error:', err.message);
            return res.status(400).json({ error: 'Invalid JSON body' });
        }

        const event = parsedEvent;
        const eventType = event.type;
        const cache = getStmtCache();

        if (eventType === 'checkout.session.completed') {
            const session = event.data?.object;
            if (session) {
                // Find or create subscription record
                const existing = cache.selectExistingSubscription.get({
                    subscriberId: session.client_reference_id || session.customer_email || 'unknown'
                });

                if (!existing) {
                    cache.insertSubscription.run({
                        subscriberId: session.client_reference_id || session.customer_email || 'unknown',
                        productId:
                            session.metadata?.product_id || session.metadata?.plan_id || session.mode || 'standard',
                        expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null
                    });
                } else {
                    cache.updateSubscriptionActive.run({ id: existing.id });
                }
            }
        } else if (eventType === 'customer.subscription.updated') {
            const subscription = event.data?.object;
            if (subscription) {
                cache.updateSubscriptionStatus.run({
                    status: subscription.status === 'active' ? 'active' : 'cancelled',
                    expiresAt: subscription.current_period_end
                        ? new Date(subscription.current_period_end * 1000).toISOString()
                        : null,
                    subscriberId: subscription.customer || 'unknown'
                });
            }
        } else if (eventType === 'customer.subscription.deleted') {
            const subscription = event.data?.object;
            if (subscription) {
                cache.updateSubscriptions.run({
                    subscriberId: subscription.customer || 'unknown'
                });
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error('[Stripe Webhook] Error:', err.message);
        res.status(500).json({ error: 'Failed to process webhook' });
    }
});

// GET /api/subscription/plans - List active subscription plans
router.get('/subscription/plans', (req, res) => {
    try {
        const cache = getStmtCache();
        const plans = cache.selectPlans.all();
        res.json(plans);
    } catch (err) {
        console.error('[Subscription] Plans error:', err.message);
        res.status(500).json({ error: 'Failed to list plans' });
    }
});

// GET /api/subscription/prices - List active subscription prices
router.get('/subscription/prices', (req, res) => {
    try {
        const cache = getStmtCache();
        const prices = cache.selectPrices.all();
        res.json(prices);
    } catch (err) {
        console.error('[Subscription] Prices error:', err.message);
        res.status(500).json({ error: 'Failed to list prices' });
    }
});

// GET /api/schedule - Service schedule for Roku calendar display
// Supports ?year=&month= query params to filter by month/year
// Returns season-aware schedule with auto-switching between summer/winter times
router.get('/schedule', async (req, res) => {
    try {
        const config = await fs.readJson(path.join(__dirname, '..', 'config.json')).catch(() => ({}));

        // Extract query params for month/year filtering
        const year = req.query.year ? parseInt(req.query.year) : new Date().getFullYear();
        const month = req.query.month ? parseInt(req.query.month) : new Date().getMonth() + 1;

        // Determine if we're in summer (June-September) or winter (October-May)
        const isSummer = month >= 6 && month <= 9;

        // Get the church config - defaults to Example Channel
        const churchConfig = config.churches?.find((c) => c.id === 'example-channel') || {};
        const channelName = churchConfig.name || 'Example Channel';

        // Season-based service times
        const serviceTimes = isSummer
            ? { startHour: 10, endHour: 11, label: 'Summer Schedule (10:00 AM – 11:30 AM)' }
            : { startHour: 9, endHour: 10, label: 'Non-Summer Schedule (9:00 AM – 10:30 AM)' };

        // Build services for the requested month
        const daysInMonth = new Date(year, month, 0).getDate();
        const services = [];
        let serviceId = 1;

        // Sundays are the main service day (dayOfWeek=0 in JS)
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month - 1, day);
            if (date.getDay() === 0) {
                // Sunday
                const startDate = new Date(year, month - 1, day, serviceTimes.startHour, 0, 0);
                const endDate = new Date(year, month - 1, day, serviceTimes.endHour, 30, 0);

                services.push({
                    id: `svc-${serviceId++}`,
                    name: 'Sunday Service',
                    date: startDate.toISOString().split('T')[0], // YYYY-MM-DD
                    startTime: startDate.toISOString(),
                    endTime: endDate.toISOString(),
                    description: `${channelName} Sunday Service`,
                    location: 'Sanctuary',
                    type: 'live_stream',
                    isLive: false // Updated by Roku client based on current time
                });
            }
        }

        const scheduleData = {
            church: channelName,
            season: isSummer ? 'summer' : 'non-summer',
            seasonLabel: serviceTimes.label,
            services: services,
            lastUpdated: new Date().toISOString(),
            metadata: {
                year,
                month,
                isSummerSchedule: isSummer,
                totalServices: services.length
            }
        };

        res.json(scheduleData);
    } catch (err) {
        console.error('[Schedule] Error:', err.message);
        res.status(500).json({ error: 'Failed to load schedule', message: err.message });
    }
});

// GET /api/heartbeat - the health ping the published Android TV / Fire TV client sends with no body.
// Measured 2026-11-09 in the edge request log (`GET /api/heartbeat 200 okhttp/4.12.0`) and on the live
// origin, which answers `{"ok":true}` in 11 bytes. On the new server this route was inside the `/api`
// default-reject, so the swap would have turned a working health ping into HTTP 403 for an app we are
// not rebuilding in this cutover. The body shape is the published contract, byte for byte.
router.get('/heartbeat', heartbeatRateLimit, (req, res) => {
    res.json({ ok: true });
});

// POST /api/heartbeat - Heartbeat telemetry endpoint for Roku client
// Receives periodic telemetry data from Heartbeat.brs
router.post('/heartbeat', analyticsRateLimit, (req, res) => {
    try {
        const payload = req.body;

        if (!payload || typeof payload !== 'object') {
            return res.status(400).json({ error: 'Expected JSON payload' });
        }

        // Store heartbeat data in analytics DB as an event
        const cache = getStmtCache();

        // Use a generic device ID for heartbeat data
        const deviceId = 'heartbeat-client';

        // Upsert device record
        cache.upsertDevice.run({
            id: deviceId,
            channel_name: 'Heartbeat Telemetry',
            app_version: null
        });

        // Store heartbeat as an event with full payload
        cache.insertEvent.run({
            // the client's own id when it has one; anonymous events stay NULL and are never
            // deduped against each other, because two identical screen views are two real views
            event_id: null,
            device_id: deviceId,
            event_type: 'interaction',
            timestamp: payload.timestamp || new Date().toISOString(),
            session_duration: payload.sessionDuration || null,
            app_version: null,
            payload: JSON.stringify(
                sanitizePayload({
                    eventType: 'heartbeat',
                    ...payload
                })
            )
        });

        res.json({ received: true });
    } catch (err) {
        console.error('[Heartbeat] Error:', err.message);
        // Don't fail the heartbeat - just log and acknowledge
        res.json({ received: true, error: 'logged' });
    }
});

router.getStmtCache = getStmtCache;
module.exports = router;

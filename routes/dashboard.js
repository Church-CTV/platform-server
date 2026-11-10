const express = require('express');
const router = express.Router();

const { getDb, activeSince } = require('../lib/db');
const { getStmtCache } = require('./api');
const { authUnlessFlagged } = require('../middleware/adminAuth');

/**
 * These three pages are one surface - the operator's own numbers - so they carry one gate. Until
 * 2026-11-09 they carried none, and `GET /` / `/events` / `/devices` answered 200 to the whole internet on
 * both live origins, event payloads included (what a household watched, and which television watched it),
 * while `/api/v1/analytics/*` - the same rows as JSON - correctly answered 401. The gate is per route and
 * never `router.use`, because this router is mounted at `'/'`: a blanket gate here would 302 `/feed`,
 * `/privacy` and the monitor's health check into the login page as well. That is what the anonymous
 * control block in `tests/integration/test-dashboard-exposure.mjs` exists to keep true.
 */
const operatorSurface = authUnlessFlagged('ADMIN_DASHBOARD_PUBLIC');

// Re-export the cache getter so dashboard can use it
module.exports = router;

// GET / - Dashboard overview
router.get('/', operatorSurface, (req, res) => {
    try {
        const cache = getStmtCache();
        const db = getDb();

        // Today's stats
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayStr = todayStart.toISOString();

        const eventsToday = cache.selectEventsByTime.get(todayStr);

        // Active devices (last 24 hours)
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString();

        const activeDevices = cache.selectDistinctDevices.get(yesterdayStr);

        // Error rate (last 24 hours)
        const errorCount = cache.selectEventsByTypeAndTime.get(['error', yesterdayStr]);

        const totalCount24h = cache.selectEventsByTime.get(yesterdayStr);

        const errorRate = totalCount24h.count > 0 ? ((errorCount.count / totalCount24h.count) * 100).toFixed(1) : '0.0';

        // Most viewed screen
        const mostViewedScreen = db
            .prepare(
                `
            SELECT payload, COUNT(*) as count
            FROM events
            WHERE event_type = 'screen_view' AND received_at >= datetime(?)
            GROUP BY payload
            ORDER BY count DESC
            LIMIT 1
        `
            )
            .get(todayStr);

        // Parse screen name from payload
        let screenName = 'N/A';
        if (mostViewedScreen && mostViewedScreen.payload) {
            try {
                const p = JSON.parse(mostViewedScreen.payload);
                screenName = p.screenName || p.screen_name || p.previousScreen || 'Unknown';
            } catch (err) {
                console.error('[Dashboard] Failed to parse screen name payload:', err.message);
                screenName = 'Unknown';
            }
        }

        res.render('dashboard/overview', {
            eventsToday: eventsToday.count || 0,
            activeDevices: activeDevices.count || 0,
            errorRate,
            mostViewedScreen: screenName
        });
    } catch (err) {
        console.error('[Dashboard] Error:', err.message);
        res.render('dashboard/overview', {
            eventsToday: 0,
            activeDevices: 0,
            errorRate: '0.0',
            mostViewedScreen: 'N/A',
            error: err.message
        });
    }
});

// GET /events - Events browser
router.get('/events', operatorSurface, (req, res) => {
    try {
        const cache = getStmtCache();
        const db = getDb();
        const { eventType, deviceId, limit = 50, offset = 0, search } = req.query;

        let query = cache.selectEvents.source;
        let countQuery = cache.countEvents.source;
        const params = {
            limit: parseInt(limit, 10),
            offset: parseInt(offset, 10)
        };
        const countParams = {};

        if (eventType) {
            query += ' AND e.event_type = @eventType';
            params.eventType = eventType;
            countQuery += ' AND e.event_type = @eventType';
            countParams.eventType = eventType;
        }

        if (deviceId) {
            query += ' AND e.device_id = @deviceId';
            params.deviceId = deviceId;
            countQuery += ' AND e.device_id = @deviceId';
            countParams.deviceId = deviceId;
        }

        if (search) {
            query += ' AND (e.payload LIKE @search OR d.channel_name LIKE @search)';
            params.search = '%' + search.replace(/[_%]/g, (c) => '\\' + c) + '%';
            countQuery += ' AND (e.payload LIKE @search OR d.channel_name LIKE @search)';
            countParams.search = '%' + search.replace(/[_%]/g, (c) => '\\' + c) + '%';
        }

        query += ' ORDER BY e.received_at DESC LIMIT @limit OFFSET @offset';

        const events = db.prepare(query).all(params);

        // Use payloads as-is from DB (already sanitized at ingestion)
        const parsedEvents = events.map((e) => {
            return { ...e, payload: e.payload };
        });

        const total = db.prepare(countQuery).get(countParams).total;

        // Get event types for filter dropdown
        const eventTypes = cache.selectDistinctEventTypes.all();

        res.render('dashboard/events', {
            events: parsedEvents,
            total,
            limit: parseInt(limit, 10),
            offset: parseInt(offset, 10),
            selectedEventType: eventType,
            selectedDeviceId: deviceId,
            searchQuery: search,
            eventTypes: eventTypes.map((e) => e.event_type)
        });
    } catch (err) {
        console.error('[Dashboard] Error:', err.message);
        res.render('dashboard/events', {
            events: [],
            total: 0,
            limit: 50,
            offset: 0,
            selectedEventType: null,
            selectedDeviceId: null,
            searchQuery: null,
            eventTypes: [],
            error: err.message
        });
    }
});

// GET /devices - Devices list
router.get('/devices', operatorSurface, (req, res) => {
    try {
        const cache = getStmtCache();
        const { activeDays = 7 } = req.query;

        // An absolute UTC timestamp, not a SQLite modifier: `datetime('-7 days')` is NULL, so the operator
        // saw "No devices found" for every window except "All time" (`lib/db.js#activeSince`).
        const dateFilter = activeDays === 'all' ? '1970-01-01 00:00:00' : activeSince(activeDays);

        const devices = cache.selectDevices.all(dateFilter);

        res.render('dashboard/devices', {
            devices,
            activeDays: activeDays === 'all' ? 'all' : parseInt(activeDays, 10)
        });
    } catch (err) {
        console.error('[Dashboard] Error:', err.message);
        res.render('dashboard/devices', {
            devices: [],
            activeDays: 7,
            error: err.message
        });
    }
});

module.exports = router;

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

// The dashboard swallows its own SQL errors (console.error, then render with an empty list), so a broken
// query does not fail a test that only checks for HTTP 200 - it just shows nobody any results. Search is
// exactly that case: the row query joins devices and can filter on d.channel_name, while the count query
// did not, so typing a channel name logged "[Dashboard] Error: no such column: channel_name" and rendered
// an empty page. Measured 2026-11-06 in the unit run output.
describe('dashboard search actually searches', () => {
    let tmp;

    function freshRequire(p) {
        for (const k of Object.keys(require.cache)) {
            if (k.includes('lib/db.js') || k.includes('routes/dashboard')) delete require.cache[k];
        }
        return require(p);
    }

    function eventsHandler() {
        const router = freshRequire('../../routes/dashboard');
        const layer = router.stack.find((l) => l.route?.path === '/events' && l.route.methods.get);
        if (!layer) throw new Error('GET /events (dashboard) route not found');
        return layer.route.stack.at(-1).handle;
    }

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-dash-'));
        process.env.DB_PATH = path.join(tmp, 'analytics.db');
        const { getDb } = freshRequire('../../lib/db.js');
        const db = getDb();
        db.prepare(
            "INSERT INTO devices (id, channel_name, app_version) VALUES ('dev-dash', 'Example Channel', '1.2.0')"
        ).run();
        const ins = db.prepare(
            "INSERT INTO events (device_id, event_type, timestamp, payload, event_id) VALUES (?, 'screen_view', ?, ?, ?)"
        );
        ins.run('dev-dash', '2026-11-06T10:00:00Z', JSON.stringify({ screenName: 'Home' }), 'dash-1');
        ins.run('dev-dash', '2026-11-06T10:01:00Z', JSON.stringify({ screenName: 'Sermons' }), 'dash-2');
        freshRequire('../../lib/db.js').closeDb();
    });

    after(() => {
        try {
            freshRequire('../../lib/db.js').closeDb();
        } catch {}
        delete process.env.DB_PATH;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function renderEvents(query) {
        const handler = eventsHandler();
        const req = { query, ip: '127.0.0.1', headers: {}, connection: { remoteAddress: '127.0.0.1' } };
        let rendered = null;
        const res = {
            render(view, data) {
                rendered = { view, data };
            },
            status(c) {
                this.statusCode = c;
                return this;
            },
            json(d) {
                rendered = { view: 'json', data: d };
            }
        };
        handler(req, res);
        assert.ok(rendered, 'the route rendered nothing');
        return rendered;
    }

    it('finds events by channel name, and says how many there are', () => {
        const { data } = renderEvents({ search: 'Example' });
        const events = data.events || [];
        assert.ok(
            events.length >= 2,
            `searching the channel name returned ${events.length} events - the count query is broken`
        );
        assert.ok(
            Number(data.total ?? data.count ?? data.totalCount ?? events.length) >= 2,
            'the count must agree with the rows it rendered'
        );
    });

    it('does not pretend the database is empty when a query fails', () => {
        const { data } = renderEvents({ search: 'Example' });
        assert.ok(!data.error, `the route hid an error from the operator: ${data.error}`);
    });
});

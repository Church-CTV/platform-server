import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

// A Roku keeps events in memory while it plays, and the network on a TV is not dependable: the normal
// failure is a batch that was delivered but not acknowledged, so the next launch sends it again. If the
// endpoint counts the replay, every watch-time and finish number is inflated by an unknown factor, and the
// owner is charged for analytics he cannot trust. GATE T7 asks for an idempotent ingest for that reason.
describe('POST /analytics tolerates an offline replay', () => {
    let tmp;
    let dbFile;

    function freshRequire(p) {
        for (const k of Object.keys(require.cache)) {
            if (k.includes('lib/db.js') || k.includes('routes/api.js') || k.includes('lib/eventValidator.js'))
                delete require.cache[k];
        }
        return require(p);
    }

    function postHandler() {
        const router = freshRequire('../../routes/api.js');
        const layer = router.stack.find((l) => l.route?.path === '/analytics' && l.route.methods.post);
        if (!layer) throw new Error('POST /analytics route not found - the ingest path moved');
        return layer.route.stack.at(-1).handle;
    }

    function req(body) {
        return {
            body,
            ip: '127.0.0.1',
            headers: {},
            socket: { remoteAddress: '127.0.0.1' },
            connection: { remoteAddress: '127.0.0.1' }
        };
    }

    function res() {
        return {
            headersSent: false,
            statusCode: 200,
            jsonData: null,
            headers: {},
            json(a, b) {
                this.headersSent = true;
                if (typeof a === 'number') {
                    this.statusCode = a;
                    this.jsonData = b;
                } else {
                    this.jsonData = a;
                }
                return this;
            },
            status(c) {
                this.statusCode = c;
                return this;
            },
            set() {
                return this;
            }
        };
    }

    function countEvents(deviceId) {
        const { getDb } = freshRequire('../../lib/db.js');
        return getDb().prepare('SELECT COUNT(*) AS c FROM events WHERE device_id = ?').get(deviceId).c;
    }

    function closeDb() {
        try {
            freshRequire('../../lib/db.js').closeDb();
        } catch {}
    }

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-idem-'));
        dbFile = path.join(tmp, 'analytics.db');
        process.env.DB_PATH = dbFile;
    });

    after(() => {
        closeDb();
        delete process.env.DB_PATH;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('stores a replayed batch exactly once', async () => {
        const handler = postHandler();
        const batch = {
            deviceInfo: { deviceId: 'dev-idem', channelName: 'Example Channel', appVersion: '1.2.0' },
            events: [
                {
                    eventType: 'content_play',
                    timestamp: '2026-11-06T10:00:00.000Z',
                    contentId: 'video-sermon-one',
                    contentTitle: 'Sermon one',
                    eventId: 'dev-idem-2026-11-06T10-00-00-content_play-video-sermon-one'
                }
            ]
        };
        const first = res();
        await handler(req(batch), first);
        assert.equal(first.statusCode, 200, `first post failed: ${JSON.stringify(first.jsonData)}`);
        const afterFirst = countEvents('dev-idem');
        const second = res();
        await handler(req(batch), second); // the ack was lost, the device sent it again
        assert.equal(second.statusCode, 200, `replay was rejected outright: ${JSON.stringify(second.jsonData)}`);
        const afterSecond = countEvents('dev-idem');
        assert.equal(afterFirst, 1, `expected 1 stored event, saw ${afterFirst}`);
        assert.equal(afterSecond, 1, `a replay was counted twice: ${afterFirst} -> ${afterSecond}`);
        closeDb();
    });

    it('still stores two different events from the same device', async () => {
        const handler = postHandler();
        const base = {
            deviceInfo: { deviceId: 'dev-distinct', channelName: 'example channel', appVersion: '1.2.0' },
            events: [
                {
                    eventType: 'screen_view',
                    timestamp: '2026-11-06T11:00:00.000Z',
                    screenName: 'Home',
                    eventId: 'evt-a'
                }
            ]
        };
        await handler(req(base), res());
        const secondEvent = {
            deviceInfo: base.deviceInfo,
            events: [
                {
                    eventType: 'screen_view',
                    timestamp: '2026-11-06T11:00:30.000Z',
                    screenName: 'Sermons',
                    eventId: 'evt-b'
                }
            ]
        };
        await handler(req(secondEvent), res());
        assert.equal(countEvents('dev-distinct'), 2, 'two distinct events must both survive');
        closeDb();
    });

    it('does not collapse anonymous events, because an old client sends no id', async () => {
        const handler = postHandler();
        const body = {
            deviceInfo: { deviceId: 'dev-anon', channelName: 'example channel', appVersion: '0.9.0' },
            events: [{ eventType: 'screen_view', timestamp: '2026-11-06T12:00:00.000Z', screenName: 'Home' }]
        };
        await handler(req(body), res());
        await handler(req(body), res());
        assert.equal(countEvents('dev-anon'), 2, 'identical anonymous events are two real screen views');
        closeDb();
    });
});

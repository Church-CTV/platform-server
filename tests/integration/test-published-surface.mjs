/** Isolated compatibility checks using two temporary local server instances. */

import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'ctv-published-surface-'));

// The measured peak minute of /feed traffic at one origin (edge log, above). The test fires this many
// requests in one window and demands no refusal: today's 30/min cap refuses the 31st.
const MEASURED_PEAK_PER_MIN = 27;

const PORT_A = Number(process.env.PUBLISHED_SURFACE_PORT || 3116);
const PORT_B = Number(process.env.PUBLISHED_SURFACE_LIMIT_PORT || 3117);

// A slice of the live Example feed: two real month groups, real ids, real field set. `url` is the v1
// top-level key, `releaseDateObj` is the legacy key v1 refuses, both are kept here so the assertions
// below are about the endpoint, not about the fixture.
const feedDocument = {
    providerName: 'Example Channel',
    lastUpdated: '2026-11-08T10:30:55.737Z',
    language: 'en',
    feedVersion: '1',
    'November 2026': [
        {
            id: 'live_stream_0',
            title: 'Live Broadcast - Example Channel',
            shortDescription: 'Latest live stream.',
            thumbnail: 'http://127.0.0.1:PORT/output/thumbnails/MC-Live.png',
            releaseDate: '2026-11-08',
            genres: ['Religious', 'Live'],
            content: {
                duration: 0,
                videos: [{ url: 'https://stream.example.invalid/live.m3u8', quality: 'HD', videoType: 'HLS' }]
            },
            dateAdded: '2026-11-08T10:30:55.737Z',
            isLive: true
        }
    ],
    'October 2026': [
        {
            id: 'video147',
            title: 'Living for the Applause of Heaven: 1st Service w/ Baptisms | Pastor Ken Bushey | January 11, 2026',
            shortDescription: 'For sermon notes, announcements, and links.',
            thumbnail: 'http://127.0.0.1:PORT/output/thumbnails/probe.jpg',
            releaseDate: '2026-01-11',
            genres: ['Religious'],
            content: {
                duration: 1836,
                videos: [{ url: 'http://127.0.0.1:PORT/stream/probe.mp4', quality: 'FHD', videoType: 'MP4' }]
            },
            url: 'http://127.0.0.1:PORT/stream/probe.mp4',
            dateAdded: '2026-10-11T12:00:00Z'
        }
    ]
};

const clientConfig = (base) => ({
    version: '1.0.0',
    channel: { name: 'Example Channel', description: 'MC Meets Here!', language: 'en' },
    content: { sourceUrl: `${base}/feed` },
    features: { analytics: true },
    analytics: { enabled: true, exportUrl: `${base}/analytics` },
    server: { baseUrl: base }
});

/** Build one organisation's content root and the server profile that points at it. */
function organisation({ port, extraProfile = {} }) {
    const dir = path.join(temp, `org-${port}`);
    const videos = path.join(dir, 'Videos');
    const output = path.join(dir, 'output');
    const thumbnails = path.join(output, 'thumbnails');
    const images = path.join(dir, 'images');
    for (const d of [videos, thumbnails, images]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(videos, 'probe.mp4'), Buffer.alloc(4096, 7));
    writeFileSync(path.join(thumbnails, 'MC-Live.png'), Buffer.alloc(120, 9));
    writeFileSync(path.join(thumbnails, 'probe.jpg'), Buffer.alloc(90, 8));
    const base = `http://127.0.0.1:${port}`;
    const stringify = (value) => JSON.parse(JSON.stringify(value).replace(/http:\/\/127\.0\.0\.1:PORT/g, base));
    const feedPath = path.join(output, 'roku_feed.json');
    writeFileSync(feedPath, JSON.stringify(stringify(feedDocument)));
    const channelStore = path.join(dir, 'channel-config.json');
    writeFileSync(channelStore, JSON.stringify(clientConfig(base)));
    const profile = {
        version: 1,
        environment: 'stage',
        publicOrigin: base,
        port,
        contentRoot: 'Videos',
        feedPath: 'output/roku_feed.json',
        imagesDir: 'images',
        dbPath: 'analytics.db',
        clientConfig: clientConfig(base)
    };
    Object.assign(profile, extraProfile);
    const profilePath = path.join(dir, 'server-profile.json');
    writeFileSync(profilePath, JSON.stringify(profile));
    return {
        dir,
        videos,
        output,
        thumbnails,
        images,
        feedPath,
        channelStore,
        profilePath,
        dbFile: path.join(dir, profile.dbPath),
        base,
        profile
    };
}

function boot(org) {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            CTV_SERVER_PROFILE: org.profilePath,
            CTV_CHANNEL_CONFIG: org.channelStore,
            ADMIN_PASSWORD: 'local-contract-test-only',
            SESSION_SECRET: 'local-contract-test-session-only',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    return {
        child,
        get log() {
            return log;
        }
    };
}

async function waitHealthy(base, run) {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
        try {
            if ((await fetch(base + '/health')).ok) return;
        } catch {}
        if (run.child.exitCode !== null) throw new Error(`server-exited(${run.child.exitCode}):${run.log}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('server-start-timeout:' + run.log);
}

async function probePort(port) {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
}

const orgA = organisation({ port: PORT_A });
const orgB = organisation({
    port: PORT_B,
    extraProfile: { rateLimits: { feed: 5, search: 5, analytics: 5, live: 5 } }
});
let runA, runB;

async function get(pathname, options = {}) {
    const r = await fetch(orgA.base + pathname, options);
    const text = await r.text();
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        value = text;
    }
    return { status: r.status, body: value, headers: Object.fromEntries(r.headers), text };
}

before(async () => {
    await probePort(PORT_A);
    await probePort(PORT_B);
    runA = boot(orgA);
    await waitHealthy(orgA.base, runA);
});

after(() => {
    for (const run of [runA, runB]) if (run && run.child.exitCode === null) run.child.kill('SIGKILL');
    rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the content the published client reads

test('the published /feed endpoint serves the channel the profile names, not the repository default', async () => {
    const r = await get('/feed');
    assert.equal(r.status, 200);
    assert.equal(r.body.providerName, 'Example Channel');
    assert.equal(r.body.feedVersion, '1');
    const groups = Object.keys(r.body).filter((key) => Array.isArray(r.body[key]));
    assert.ok(groups.length >= 2, 'month groups survive');
    const items = groups.flatMap((key) => r.body[key]);
    assert.equal(items.length, 2);
    // every field a published loader reads, and the media the app plays, are present and playable
    for (const item of items) {
        for (const field of ['id', 'title', 'shortDescription', 'thumbnail', 'releaseDate', 'genres']) {
            assert.ok(item[field] !== undefined, `${item.id} is missing ${field}`);
        }
        assert.ok(Array.isArray(item.content.videos) && item.content.videos.length > 0);
        assert.match(item.content.videos[0].url, /^https?:\/\//);
    }
    // ids are the anchor for dedup, resume and the cutover shrink gate
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
});

test('GET /search reads the same profiled feed', async () => {
    const r = await get('/search?q=baptisms&limit=3');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body), 'search answers an array, as the published origin does');
    assert.equal(r.body.length, 1, 'the profiled feed is what search reads');
    assert.equal(r.body[0].id, 'video147');
});

test('the organisation thumbnails are served from the profiled output directory', async () => {
    const r = await fetch(orgA.base + '/output/thumbnails/MC-Live.png');
    assert.equal(r.status, 200, 'a channel with no art is a blank television');
    assert.equal(Number(r.headers.get('content-length')), 120);
});

test('GET /stream answers a Range request the way the published origin does', async () => {
    const r = await fetch(orgA.base + '/stream/probe.mp4', { headers: { range: 'bytes=0-1023' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-range'), 'bytes 0-1023/4096');
    assert.equal((await r.arrayBuffer()).byteLength, 1024);
});

// ---------------------------------------------------------------- the client endpoints that must stay open

test('GET /api/heartbeat answers the published Android TV/Fire TV client with the body it expects', async () => {
    const r = await get('/api/heartbeat');
    assert.equal(r.status, 200, `the published client health-pings this path today: ${r.status} ${r.text}`);
    assert.deepEqual(r.body, { ok: true });
});

test('POST /api/analytics stays public, stores what the contract allows and refuses the rest by name', async () => {
    const batch = {
        deviceInfo: {
            deviceId: 'surface-probe-1',
            channelName: 'Example Channel',
            appVersion: '2.0.8362026'
        },
        events: [
            {
                eventId: 'surface-evt-1',
                eventType: 'screen_view',
                timestamp: '2026-11-09T00:00:00.000Z',
                screenName: 'grid'
            },
            {
                eventId: 'surface-evt-2',
                eventType: 'content_play',
                timestamp: '2026-11-09T00:00:01.000Z',
                contentId: 'video147'
            }
        ]
    };
    const send = (body) =>
        fetch(orgA.base + '/api/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    const first = await send(batch);
    assert.equal(first.status, 200, `a Roku client cannot hold a secret: ${first.status} ${await first.text()}`);
    const replay = await send(batch);
    assert.equal(replay.status, 200);
    // the read surface behind that query needs an operator session, and this test is about what the
    // endpoint wrote, so the durable store is read directly (the same way `test-v2-contract.mjs` does)
    const db = new Database(orgA.dbFile, { readonly: true });
    try {
        for (const id of ['surface-evt-1', 'surface-evt-2']) {
            assert.equal(
                db.prepare('SELECT COUNT(*) AS n FROM events WHERE event_id = ?').get(id).n,
                1,
                `${id} was counted twice across two deliveries of one batch`
            );
        }
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM devices WHERE id = 'surface-probe-1'").get().n, 1);
    } finally {
        db.close();
    }

    // A batch with one event outside the vocabulary must not lose the other one, and must not claim a
    // row it did not write: `count` is rows stored, `refused` names the reason.
    const mixed = await send({
        deviceInfo: { deviceId: 'surface-probe-2' },
        events: [
            {
                eventId: 'surface-evt-3',
                eventType: 'interaction',
                timestamp: '2026-11-09T00:00:02.000Z',
                action: 'focus'
            },
            {
                eventId: 'surface-evt-4',
                eventType: 'play',
                timestamp: '2026-11-09T00:00:03.000Z',
                contentId: 'video147'
            }
        ]
    });
    assert.equal(mixed.status, 200);
    const verdict = await mixed.json();
    assert.equal(verdict.received, true);
    assert.equal(verdict.count, 1, 'a legal event is not collateral damage next to an illegal one');
    assert.equal(verdict.refused.length, 1);
    assert.equal(verdict.refused[0].eventType, 'play');
    assert.match(verdict.refused[0].reasons.join(' '), /Unknown event type/);
    const db2 = new Database(orgA.dbFile, { readonly: true });
    try {
        assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id = 'surface-evt-3'").get().n, 1);
        assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id = 'surface-evt-4'").get().n, 0);
    } finally {
        db2.close();
    }
});

test('GET /privacy keeps the page the store listings quote', async () => {
    const r = await get('/privacy');
    assert.equal(r.status, 200, 'the store submissions quote this URL: ' + r.status);
    assert.match(String(r.headers['content-type']), /text\/html/);
    // the headings are HTML-escaped, so compare on unescaped text
    const text = r.text
        .replace(/&#39;|&apos;|&rsquo;|&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
    assert.match(text, /Example Channel/);
    for (const heading of ['Privacy Policy', 'Data We Collect', 'Data We Do NOT Collect', "Children's Privacy"]) {
        assert.ok(text.includes(heading), `the store asks for a section about ${heading}`);
    }
    assert.ok(!/undefined|\[object|PLACEHOLDER|TODO/.test(text), 'a legal page may not ship a placeholder');
});

test("an organisation's own privacy.html is served instead of the generated page", async () => {
    const file = path.join(orgA.output, 'privacy.html');
    writeFileSync(file, '<!DOCTYPE html><html><body><h1>Example writes its own words</h1></body></html>');
    try {
        const r = await get('/privacy');
        assert.equal(r.status, 200);
        assert.match(r.text, /Example writes its own words/);
        // an empty legal page is refused, not served: a blank page is not a privacy policy
        writeFileSync(file, '   ');
        const empty = await get('/privacy');
        assert.equal(empty.status, 500);
        assert.equal(empty.body.error, 'privacy-file-empty');
    } finally {
        rmSync(file, { force: true });
    }
});

// ---------------------------------------------------------------- the budget a service adds to

test(`one minute at the measured peak (${MEASURED_PEAK_PER_MIN} /feed requests from one peer) is refused zero times`, async () => {
    const statuses = [];
    for (let i = 0; i < MEASURED_PEAK_PER_MIN; i++) {
        const r = await fetch(orgA.base + '/feed');
        statuses.push(r.status);
    }
    const refused = statuses.filter((status) => status === 429).length;
    assert.equal(
        refused,
        0,
        `the whole audience plus monitoring arrives at the origin as one peer address; ${refused}/${statuses.length} were refused (measured peak ${MEASURED_PEAK_PER_MIN}/min)`
    );
});

test('a configured cap still refuses past itself, in a machine-readable way', async () => {
    runB = boot(orgB);
    await waitHealthy(orgB.base, runB);
    const seen = [];
    for (let i = 0; i < 7; i++) seen.push((await fetch(orgB.base + '/feed')).status);
    assert.deepEqual(seen.slice(0, 5), [200, 200, 200, 200, 200], 'the configured cap is 5');
    assert.equal(seen[5], 429, 'the cap is a cap: ' + JSON.stringify(seen));
    assert.equal(seen[6], 429);
    const refusal = await fetch(orgB.base + '/feed');
    assert.equal(refusal.status, 429);
    const body = await refusal.json();
    assert.equal(body.error, 'Too many requests');
    assert.ok(Number(refusal.headers.get('retry-after')) > 0, 'the client must learn when to come back');
});

test('a rate limit the profile cannot express is refused at boot, not ignored', async () => {
    const bad = organisation({ port: PORT_B + 1, extraProfile: { rateLimits: { feed: 'plenty' } } });
    const run = boot(bad);
    const until = Date.now() + 15000;
    while (Date.now() < until && run.child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.notEqual(run.child.exitCode, null, 'a server with a cap it cannot parse must not serve');
    assert.match(run.log, /invalid-server-profile/);
    if (run.child.exitCode === null) run.child.kill('SIGKILL');
});

test('every batch the analytics endpoint is given is accounted for: a category container is flattened, a body with no events is refused by name', async () => {
    const send = (body) =>
        fetch(orgA.base + '/api/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'okhttp/4.12.0' },
            body: JSON.stringify(body)
        });

    // The queued container a shipped client exports carries its categories at the top level. It does not
    // always carry a wrapper `eventType`, and until 2026-11-09 the container branch was gated on one:
    // a batch like this was answered `{received:true,count:0,refused:[]}` - two events in, nothing
    // stored, nothing named, and no reconciliation on earth could find the difference (measured on the
    // stage against the real example channel configuration at 13:2x UTC, `/api/analytics` answered count:0).
    const container = await send({
        deviceId: 'surface-container-1',
        appVersion: '2.0.8362026',
        sessionDuration: 412,
        screenViews: [
            {
                eventId: 'surface-evt-10',
                eventType: 'screen_view',
                timestamp: '2026-11-09T00:10:00.000Z',
                screenName: 'grid'
            }
        ],
        plays: [
            {
                eventId: 'surface-evt-11',
                eventType: 'content_play',
                timestamp: '2026-11-09T00:10:05.000Z',
                contentId: 'video147'
            }
        ]
    });
    assert.equal(container.status, 200);
    const containerBody = await container.json();
    assert.equal(
        containerBody.count,
        2,
        `a container without a wrapper eventType must still land: ${JSON.stringify(containerBody)}`
    );
    assert.deepEqual(containerBody.refused, []);
    const db = new Database(orgA.dbFile, { readonly: true });
    try {
        // The two fields the contract requires are stored inside the event's `payload` JSON: the events
        // table has no screen_name/content_id column, which is exactly why a container that kept them in
        // the wrapper was invisible to every reader rather than merely ugly.
        const rows = db
            .prepare(
                "SELECT event_id, event_type, payload FROM events WHERE device_id = 'surface-container-1' ORDER BY event_id"
            )
            .all()
            .map((r) => {
                const p = JSON.parse(r.payload);
                return [r.event_id, r.event_type, p.screenName ?? null, p.contentId ?? null];
            });
        assert.deepEqual(
            rows,
            [
                ['surface-evt-10', 'screen_view', 'grid', null],
                ['surface-evt-11', 'content_play', null, 'video147']
            ],
            'the fields the contract requires must survive the container, not sit in the wrapper'
        );
    } finally {
        db.close();
    }

    // An empty queue is not an error, and must not be reported as one.
    const empty = await send({ deviceId: 'surface-empty-1', events: [] });
    assert.equal(empty.status, 200);
    const emptyBody = await empty.json();
    assert.equal(emptyBody.count, 0);
    assert.deepEqual(emptyBody.refused, [], `an empty batch names nothing: ${JSON.stringify(emptyBody)}`);

    // A body the event contract cannot speak about at all must be *named*, because the invariant the
    // whole GATE T7 reconciliation rests on is emitted = stored + refused. Answering
    // `{received:true,count:0,refused:[]}` to a body that was never an event batch is how rows go
    // missing without a trace.
    const shapeless = await send({
        deviceId: 'surface-shapeless-1',
        deviceInfo: { deviceId: 'surface-shapeless-1' },
        summary: { sessionDuration: 12 }
    });
    assert.equal(shapeless.status, 200, 'the client is still told to stop retrying');
    const shapelessBody = await shapeless.json();
    assert.equal(shapelessBody.count, 0);
    assert.equal(shapelessBody.refused.length, 1, `the refusal must be named: ${JSON.stringify(shapelessBody)}`);
    assert.deepEqual(shapelessBody.refused[0].reasons, ['no-event-shape-recognised']);
});

test('a deployment still running the legacy channel store is refused by every v2 endpoint in machine-readable form, not as an HTML stack trace', async () => {
    // The condition is a real one, not a fixture trick: both production origins run a `config.json` in the
    // legacy shape, and that is the store the stage booted with. Measured 2026-11-09 at 13:3x UTC against
    // the real example channel configuration - `/api/v2/config` answered a machine-readable 400
    // (`missing-required:content.sourceUrl`) while `/api/v2/feed`, same condition, answered
    // `500` + `text/html` with a stack trace naming `/example/...`. A television should never be sent
    // the server's install directory, and a monitor cannot parse an HTML page.
    const legacyStore = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
    const clean = readFileSync(orgA.channelStore, 'utf8');
    writeFileSync(orgA.channelStore, JSON.stringify(legacyStore));
    try {
        for (const p of ['/api/v2/feed', '/api/v2/search?q=live']) {
            const res = await fetch(orgA.base + p);
            const text = await res.text();
            assert.notEqual(res.status, 500, `${p} must not fall through to the framework: ${text.slice(0, 200)}`);
            assert.equal(res.status, 400, `${p} refuses a store the contract cannot merge: ${text.slice(0, 200)}`);
            assert.match(res.headers.get('content-type') || '', /json/, `${p} answers in JSON`);
            assert.doesNotMatch(text, /at\s+\//, `${p} leaked a stack trace: ${text.slice(0, 200)}`);
            assert.doesNotMatch(text, /opt\/t3code/, `${p} disclosed the install path`);
            const body = JSON.parse(text);
            assert.equal(body.error, 'invalid-server-config');
            assert.equal(typeof body.reason, 'string', 'the refusal is named, not implied');
            assert.ok(Array.isArray(body.refusedKeys));
        }
        // The feed refusal points at the document the client can actually read.
        const feed = await fetch(orgA.base + '/api/v2/feed');
        assert.equal((await feed.json()).fallback, '/feed');
        // And the process is still alive: before 2026-11-09 the search refusal was thrown out of a
        // `res.json` callback, the Node process exited, and the whole origin went down on one request.
        const survivor = await fetch(orgA.base + '/feed');
        assert.equal(survivor.status, 200, 'a refused v2 search must not take the published feed with it');
    } finally {
        writeFileSync(orgA.channelStore, clean);
    }
    const healthy = await fetch(orgA.base + '/api/v2/feed');
    assert.equal(healthy.status, 200, 'the refusal was the store, not the route');
});

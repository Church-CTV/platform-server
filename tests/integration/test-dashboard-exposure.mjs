/**
 * Who may see the operator's analytics pages, over real HTTP (2026-11-09).
 *
 * Asked by the owner in the context of hosting the admin publicly: "our admin page needs auth, only the
 * authed user can edit a channel". The *edit* half was already true and is pinned here as a control
 * (`POST /admin/config` with no session never reaches the store). The *see* half was not: measured the same
 * day on both live origins, `GET /`, `GET /events` and `GET /devices` answered **200 to an anonymous
 * visitor** and rendered the channel's real analytics - event counts, device ids, and the payload of every
 * event, which carries what was watched (`/events?search=` is an anonymous LIKE over those payloads).
 * `routes/AGENTS.md` calls them "Public dashboard pages" while `README.md`'s own diagram draws
 * `Dashboard --> Auth`: the code and the documentation disagreed, and neither view showed it.
 *
 * The policy this file pins:
 *  - the operator's own numbers are an authenticated surface by default (fail closed, per `../CONFIGURATION.md`);
 *  - an operator who wants a public status page says so out loud with `ADMIN_DASHBOARD_PUBLIC=true`;
 *  - the television, the monitor and the store listing keep their anonymous paths - the gate is three
 *    routes, not the mount point, because a `router.use` gate under `'/'` would 302 `/feed` as well;
 *  - an anonymous refusal carries no row of data, and says why in a header as well as a redirect;
 *  - a session cookie is flagged `Secure` when the visitor's own transport is https (honouring
 *    `TRUST_PROXY`, which is how TLS ends at an edge), and is still issued when it is not, so no operator
 *    is ever locked out of their own panel by a flag their browser cannot honour;
 *  - the operator who signs in can actually see the data, which is how a second, unrelated defect surfaced
 *    here: the device windows handed SQLite a bare modifier (`datetime('-7 days')` is NULL), so every
 *    window except "All time" listed no television at all.
 *
 * Four processes, because these facts are fixed at startup (the cookie policy from the configured `URL`
 * and `TRUST_PROXY`, the public flag from the environment) and one process cannot hold both. Every port is
 * probe-bound before placement, per the ports.md rule.
 */

import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const adminAuthLib = require(path.join(root, 'lib/adminAuth.js'));

const temp = mkdtempSync(path.join(tmpdir(), 'ctv-dashboard-exposure-'));
const hashFile = path.join(root, '.admin_password_hash');
const password = 'local-dashboard-test-only';
const deviceId = 'anon-probe-9f3c';
const payloadMarker = 'anon-payload-marker-6d21';
const restored = [];
const running = [];

function fixture(port) {
    const dir = path.join(temp, `p${port}`);
    mkdirSync(path.join(dir, 'output'), { recursive: true });
    mkdirSync(path.join(dir, 'media'), { recursive: true });
    writeFileSync(
        path.join(dir, 'channel-config.json'),
        JSON.stringify({
            version: '1.0.0',
            channel: { name: 'Exposure Church', description: 'Sermons', language: 'en', copyright: '(c) 2026' },
            content: { sourceUrl: `http://127.0.0.1:${port}/api/v2/feed` },
            branding: { colors: { accent: '0xE8B931' } }
        })
    );
    const feed = {
        providerName: 'Exposure Church',
        lastUpdated: '2026-11-09T00:00:00.000Z',
        language: 'en',
        feedVersion: '1',
        'November 2026': []
    };
    writeFileSync(path.join(dir, 'feed.json'), JSON.stringify(feed));
    writeFileSync(path.join(dir, 'output', 'roku_feed.json'), JSON.stringify(feed));
    return { dir, dbPath: path.join(dir, 'analytics.db') };
}

async function start({ port, url, env = {} }) {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', () => reject(new Error(`port ${port} is already taken - pick another`)));
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });

    const { dir, dbPath } = fixture(port);
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            URL: url,
            DB_PATH: dbPath,
            CTV_V2_FEED_PATH: path.join(dir, 'feed.json'),
            CTV_FEED_OUTPUT_DIR: path.join(dir, 'output'),
            CTV_VIDEOS_DIR: path.join(dir, 'media'),
            CTV_VIDEOS_METADATA: path.join(dir, 'videos.json'),
            CTV_AUDIT_DIR: path.join(dir, 'audit'),
            CTV_CHANNEL_CONFIG: path.join(dir, 'channel-config.json'),
            ADMIN_PASSWORD: password,
            SESSION_SECRET: 'local-dashboard-session-only',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    running.push(child);
    let log = '';
    child.stdout.on('data', (chunk) => (log += chunk));
    child.stderr.on('data', (chunk) => (log += chunk));

    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 120 && !up; i += 1) {
        try {
            up = (await fetch(`${base}/api/v2/health`)).status === 200;
        } catch {
            /* not listening yet */
        }
        if (!up && child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${log.slice(0, 800)}`);
        if (!up) await new Promise((done) => setTimeout(done, 250));
    }
    if (!up) throw new Error(`server never became healthy: ${log.slice(0, 800)}`);

    /** One cookie jar = one visitor. Anonymous tests and signed-in tests must not share one. */
    function session() {
        const jar = new Map();
        async function request(route, { method = 'GET', body, headers = {} } = {}) {
            const res = await fetch(base + route, {
                method,
                body,
                redirect: 'manual',
                headers: {
                    ...(jar.size ? { cookie: [...jar.values()].join('; ') } : {}),
                    'content-type': 'application/x-www-form-urlencoded',
                    ...headers
                }
            });
            for (const entry of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
                const pair = entry.split(';')[0]; // name=value is all a Cookie header carries
                jar.set(pair.slice(0, pair.indexOf('=')), pair);
            }
            return {
                status: res.status,
                text: await res.text(),
                headers: Object.fromEntries(res.headers),
                setCookie: res.headers.get('set-cookie') || ''
            };
        }
        async function login() {
            const page = await request('/admin/login');
            const token = (/name="_csrf"[^>]*value="([^"]*)"/.exec(page.text) || [])[1] || '';
            const res = await request('/admin/login', {
                method: 'POST',
                body: new URLSearchParams({ password, _csrf: token })
            });
            assert.equal(res.status, 302, `login did not redirect: ${res.status} ${res.text.slice(0, 200)}`);
            return res;
        }
        return { request, login };
    }

    // Seed one television and one event through the ingestion route a real client uses, not through SQL:
    // the analytics schema is opened lazily by the process, so the first POST is what creates it, and a
    // fixture written beside a half-started server is how the first run of this file managed to be red for
    // the wrong reason. `contentId` is the payload field GATE T7 counts, so the dashboard has a real row.
    const seeder = session();
    let seeded = null;
    for (let i = 0; i < 40 && seeded?.status !== 200; i += 1) {
        seeded = await seeder.request('/api/v2/analytics', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                deviceInfo: { deviceId, channelName: 'Exposure Church' },
                events: [
                    {
                        eventType: 'content_play',
                        contentId: payloadMarker,
                        screenName: 'VideoScreen',
                        timestamp: new Date().toISOString()
                    }
                ]
            })
        });
        if (seeded?.status !== 200) await new Promise((done) => setTimeout(done, 250));
    }
    assert.equal(
        seeded?.status,
        200,
        `seeding one event failed: ${seeded?.status} ${seeded?.text} | ${log.slice(0, 400)}`
    );

    return { base, port, session, dbPath, log: () => log };
}

// The reserved quiet 31xx band (ports.md); each port is probe-bound before placement by `start` itself.
const A = Number(process.env.DASHBOARD_EXPOSURE_PORT || 3168); // default policy, plain-http URL
const B = Number(process.env.DASHBOARD_EXPOSURE_PORT_B || 3169); // URL=https://, operator arrives over http
const C = Number(process.env.DASHBOARD_EXPOSURE_PORT_C || 3170); // ADMIN_DASHBOARD_PUBLIC=true
const D = Number(process.env.DASHBOARD_EXPOSURE_PORT_D || 3171); // URL=https:// behind its own TLS proxy

let a;
let b;
let c;
let d;

before(async () => {
    if (existsSync(hashFile)) {
        restored.push(readFileSync(hashFile));
        rmSync(hashFile, { force: true });
    }
    writeFileSync(hashFile, adminAuthLib.hashPassword(password));
    a = await start({ port: A, url: `http://127.0.0.1:${A}` });
    b = await start({ port: B, url: 'https://studio.example.org' });
    c = await start({ port: C, url: `http://127.0.0.1:${C}`, env: { ADMIN_DASHBOARD_PUBLIC: 'true' } });
    d = await start({
        port: D,
        url: 'https://studio.example.org',
        env: { TRUST_PROXY: 'true' }
    });
});

after(() => {
    for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
    if (restored.length) writeFileSync(hashFile, restored[0]);
    else rmSync(hashFile, { force: true });
});

test('the operator analytics pages refuse an anonymous visitor with a login redirect, not a page', async () => {
    const anon = a.session();
    for (const route of ['/', '/events', '/devices']) {
        const r = await anon.request(route);
        assert.equal(r.status, 302, `GET ${route} answered ${r.status}: the operators numbers were public`);
        assert.match(r.headers.location || '', /\/admin\/login/, `GET ${route} did not aim at the login page`);
        assert.equal(
            r.headers['x-ctv-denied'],
            'auth-required',
            `GET ${route} refused without naming the reason in a machine-readable header`
        );
    }
});

test('the anonymous refusal carries no row of the channel data', async () => {
    const anon = a.session();
    const events = await anon.request('/events');
    assert.ok(!events.text.includes(payloadMarker), 'the refusal body carries an event payload');
    const devices = await anon.request('/devices');
    assert.ok(!devices.text.includes(deviceId), 'the devices refusal names a stored television');
    const overview = await anon.request('/');
    assert.ok(!overview.text.includes('Events Today'), 'the refusal body still renders the dashboard cards');
});

test('an anonymous LIKE search over event payloads is no longer an open enumeration', async () => {
    const anon = a.session();
    const r = await anon.request(`/events?search=${payloadMarker}`);
    assert.equal(r.status, 302, `anonymous search answered ${r.status}`);
    assert.ok(!r.text.includes(payloadMarker), 'anonymous search still returned the matching row');
});

test('gating the pages costs the operator nothing to use: intent survives, then the data is there', async () => {
    const operator = a.session();
    const bounced = await operator.request('/events');
    assert.equal(bounced.status, 302);
    await operator.login();
    const overview = await operator.request('/');
    assert.equal(overview.status, 200, 'a signed-in operator cannot reach the dashboard');
    assert.match(overview.text, /Events Today/);
    const events = await operator.request('/events');
    assert.equal(events.status, 200);
    assert.ok(events.text.includes(payloadMarker), 'the signed-in events page does not carry the stored payload');
    const devices = await operator.request('/devices');
    assert.equal(devices.status, 200);
    assert.ok(devices.text.includes(deviceId), 'the signed-in devices page does not list the stored television');
});

test('the device window is a cutoff and not a NULL, so the signed-in operator can list their televisions', async () => {
    // Found while proving the gate is worth having: `datetime('-7 days')` is NULL in SQLite, so every
    // device window except "All time" matched nothing and the operator's device list was empty.
    const operator = a.session();
    await operator.login();
    const listed = await operator.request('/api/v1/analytics/devices', { headers: { accept: 'application/json' } });
    assert.equal(listed.status, 200);
    const body = JSON.parse(listed.text);
    assert.ok(Array.isArray(body.devices), 'the device list is not an array');
    assert.ok(
        body.devices.some((device) => device.id === deviceId),
        `the default 7-day window does not list the television seen right now: ${listed.text.slice(0, 200)}`
    );
    const allTime = await operator.request('/api/v1/analytics/devices?activeDays=all', {
        headers: { accept: 'application/json' }
    });
    assert.ok(
        JSON.parse(allTime.text).devices.some((device) => device.id === deviceId),
        'the all-time window does not list it either'
    );
});

test('only the authed user edits a channel: an anonymous config POST never reaches the store', async () => {
    const anon = a.session();
    const edit = await anon.request('/admin/config', {
        method: 'POST',
        body: new URLSearchParams({ channelName: 'Anonymous Was Here' })
    });
    assert.equal(edit.status, 302, `an anonymous POST /admin/config was not refused: ${edit.status}`);
    const served = await (await fetch(`${a.base}/api/v2/config`)).json();
    assert.notEqual(served.channel?.name, 'Anonymous Was Here', 'the anonymous POST moved the channel name');
});

test('the television, the monitor and the store listing keep their anonymous paths', async () => {
    const anon = a.session();
    for (const route of [
        '/feed',
        '/feed/',
        '/api/v2/feed',
        '/api/v2/config',
        '/api/v2/health',
        '/api/heartbeat',
        '/privacy',
        '/admin/login'
    ]) {
        const r = await anon.request(route);
        assert.equal(r.status, 200, `GET ${route} -> ${r.status}: the gate reached outside the operator surface`);
    }
    const ingest = await anon.request('/api/v2/analytics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            deviceInfo: { deviceId: 'anon-ingest-1' },
            events: [{ eventType: 'screen_view', screenName: 'MainScene', timestamp: '2026-11-09T12:00:00.000Z' }]
        })
    });
    assert.equal(ingest.status, 200, `anonymous ingestion was refused: ${ingest.status} ${ingest.text.slice(0, 200)}`);

    // Analytics *reads* were already session-gated; this pins that they answer 401, not a browser redirect.
    const reads = await anon.request('/api/v1/analytics/events', { headers: { accept: 'application/json' } });
    assert.equal(reads.status, 401, `an anonymous JSON analytics read answered ${reads.status}, expected 401`);
});

test('a session cookie is marked Secure exactly when the visitor really is on https', async () => {
    // The case every hosted channel has: TLS ends at the edge, the edge says so in `X-Forwarded-Proto`, the
    // operator said `TRUST_PROXY=true`, and the configured origin is https. The cookie that carries the
    // right to edit a channel must be flagged `Secure` here.
    const proxied = d.session();
    const viaTls = await proxied.request('/admin/login');
    const token = (/name="_csrf"[^>]*value="([^"]*)"/.exec(viaTls.text) || [])[1] || '';
    const login = await proxied.request('/admin/login', {
        method: 'POST',
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' },
        body: new URLSearchParams({ password, _csrf: token })
    });
    assert.equal(
        login.status,
        302,
        `login through the TLS proxy did not redirect: ${login.status} ${login.text.slice(0, 200)}`
    );
    assert.match(
        login.setCookie,
        /;\s*Secure/i,
        `a https visitor on an https-configured deployment got a non-Secure session cookie: ${login.setCookie}`
    );
    assert.equal(
        (await proxied.request('/events', { headers: { 'x-forwarded-proto': 'https' } })).status,
        200,
        'the Secure-flagged cookie came back, so the operator stayed signed in'
    );
});

test('a plain-http visit to an https-configured box still gets a cookie it can send back', async () => {
    // The trap `'auto'` avoids, recorded so nobody "simplifies" it to `true`: express-session refuses to
    // send a Secure cookie over a transport it judges insecure, so deriving `true` from `URL` alone locks
    // an operator out of their own panel the moment someone browses the box over http.
    const lan = b.session();
    const login = await lan.login();
    assert.ok(login.setCookie.includes('connect.sid'), `no session cookie was issued at all: ${login.setCookie}`);
    assert.doesNotMatch(login.setCookie, /;\s*Secure/i, `an http visitor got a Secure cookie: ${login.setCookie}`);
    assert.equal((await lan.request('/')).status, 200, 'the http visitor was locked out by their own cookie flag');

    // `X-Forwarded-Proto` counts only when the operator declared the proxy: a forged header must not be
    // able to change what the box considers its own transport.
    const forging = b.session();
    const page = await forging.request('/admin/login', { headers: { 'x-forwarded-proto': 'https' } });
    const token = (/name="_csrf"[^>]*value="([^"]*)"/.exec(page.text) || [])[1] || '';
    const forged = await forging.request('/admin/login', {
        method: 'POST',
        headers: { 'x-forwarded-proto': 'https' },
        body: new URLSearchParams({ password, _csrf: token })
    });
    assert.doesNotMatch(
        forged.setCookie,
        /;\s*Secure/i,
        `an untrusted forwarded-proto header set Secure: ${forged.setCookie}`
    );
    assert.equal((await forging.request('/')).status, 200, 'the untrusted-header operator was locked out');
});

test('a plain-http LAN deployment keeps a working cookie and no Secure flag', async () => {
    const operator = a.session();
    const login = await operator.login();
    assert.ok(login.setCookie.includes('connect.sid'), 'no session cookie was issued at all');
    assert.doesNotMatch(login.setCookie, /;\s*Secure/i, `a LAN deployment got a Secure cookie: ${login.setCookie}`);
    const overview = await operator.request('/');
    assert.equal(overview.status, 200, 'the LAN operator was locked out by their own cookie flag');
});

test('a public status page is an operator decision, not an accident of mounting', async () => {
    const anon = c.session();
    const overview = await anon.request('/');
    assert.equal(overview.status, 200, 'ADMIN_DASHBOARD_PUBLIC=true did not publish the page');
    assert.equal(
        overview.headers['x-ctv-dashboard'],
        'public-by-flag',
        'the published page does not say so in a header a stranger can check'
    );
    assert.match(overview.text, /Events Today/);
    const events = await anon.request('/events');
    assert.equal(events.status, 200, 'ADMIN_DASHBOARD_PUBLIC=true did not publish /events');
    assert.ok(events.text.includes(payloadMarker), 'the published page does not carry the seeded payload');
});

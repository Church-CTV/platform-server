import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
    Database = require('better-sqlite3');
const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'ctv-v2-contract-'));
const dbPath = path.join(temp, 'analytics.db'),
    fixture = path.join(temp, 'feed.json');
const port = Number(process.env.V2_TEST_PORT || 3113),
    base = 'http://127.0.0.1:' + port;
let child,
    log = '';
const media = path.join(temp, 'media');
mkdirSync(media);
writeFileSync(path.join(media, 'probe.mp4'), '0123456789');
// The operator store is part of the contract now, so the harness owns its own copy instead of
// inheriting whatever `config.json` happens to sit in the repo next to a running suite.
const operatorStore = path.join(temp, 'operator-config.json');
writeFileSync(operatorStore, '{}');
const profile = {
    version: '1.0.0',
    channel: { name: 'Example TV' },
    content: { sourceUrl: base + '/feed' },
    features: { analytics: true },
    analytics: { enabled: true, exportUrl: base + '/analytics' },
    server: { baseUrl: base }
};
writeFileSync(
    fixture,
    JSON.stringify({
        providerName: 'Contract fixture',
        lastUpdated: '2026-11-07T00:00:00Z',
        config: profile,
        'November 2026': []
    })
);
async function request(url, body, headers = {}) {
    const r = await fetch(base + url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await r.text();
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        value = text;
    }
    return { status: r.status, body: value, headers: Object.fromEntries(r.headers) };
}
before(async () => {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
    child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            URL: base,
            DB_PATH: dbPath,
            CTV_V2_FEED_PATH: fixture,
            CTV_VIDEOS_DIR: media,
            CTV_CHANNEL_CONFIG: operatorStore,
            ADMIN_PASSWORD: 'local-contract-test-only',
            SESSION_SECRET: 'local-contract-test-session-only',
            STRIKESAFE: 'false',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (data) => (log += data));
    child.stderr.on('data', (data) => (log += data));
    const until = Date.now() + 30000;
    while (Date.now() < until) {
        try {
            if ((await fetch(base + '/health')).ok) return;
        } catch {}
        if (child.exitCode !== null) throw new Error('server-start-failed:' + log);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('server-start-timeout:' + log);
});
after(async () => {
    if (child && child.exitCode === null) {
        await new Promise((resolve) => {
            child.once('exit', resolve);
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        });
    }
    rmSync(temp, { recursive: true, force: true });
});
test('v2 advertises versioned config and preserves legacy feed availability', async () => {
    const f = await request('/api/v2/feed');
    assert.equal(f.status, 200);
    assert.equal(f.body.apiVersion, 2);
    assert.equal(f.body.config.analytics.exportUrl, base + '/api/v2/analytics');
    assert.equal((await request('/api/v2/feed', undefined, { 'If-None-Match': f.headers.etag })).status, 304);
    const c = await request('/api/v2/config');
    assert.equal(c.status, 200);
    assert.equal(c.body.apiVersion, 2);
    assert.equal(typeof c.body.configVersion, 'string');
    assert.equal((await request('/feed')).status, 200);
    assert.equal((await request('/api/v2/not-a-route')).status, 404);
});
test('v2 ingest dedupes replays, refuses unknown fields, and keeps reads private', async () => {
    const payload = {
        deviceInfo: { deviceId: 'contract-v2', channelName: 'Example TV' },
        events: [
            { eventType: 'screen_view', timestamp: '2026-11-07T00:00:00Z', screenName: 'Home', eventId: 'contract-one' }
        ]
    };
    for (let i = 0; i < 2; i++) assert.equal((await request('/api/v2/analytics', payload)).status, 200);
    const db = new Database(dbPath, { readonly: true });
    try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE event_id = ?').get('contract-one').n, 1);
    } finally {
        db.close();
    }
    assert.equal((await request('/api/v2/analytics/events')).status, 401);
    payload.events[0].unknownField = true;
    assert.equal((await request('/api/v2/analytics', payload)).body.error, 'unknown-event-field');
    assert.equal((await request('/analytics', payload)).status, 200);
});
test('invalid runtime config is refused without affecting legacy availability', async () => {
    const old = readFileSync(fixture, 'utf8');
    try {
        const x = JSON.parse(old);
        x.config.features.unknownFlag = true;
        writeFileSync(fixture, JSON.stringify(x));
        const r = await request('/api/v2/config');
        assert.equal(r.status, 400);
        assert.equal(r.body.error, 'invalid-server-config');
        assert.equal((await request('/feed')).status, 200);
    } finally {
        writeFileSync(fixture, old);
    }
});

test('versioned streams read the selected channel content root', async () => {
    const response = await fetch(base + '/api/v2/stream/probe.mp4', { headers: { Range: 'bytes=0-3' } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), '0123');
});
test('v2 playback measurements preserve zero and reject invalid numeric values', async () => {
    const payload = {
        deviceInfo: { deviceId: 'playback-contract' },
        events: [
            {
                eventType: 'playback_state',
                state: 'playing',
                timestamp: '2026-11-07T00:00:00Z',
                eventId: 'measurement-zero',
                sessionId: 'session-one',
                timeToFirstFrame: 0.25,
                watchSeconds: 0,
                bufferSeconds: 0,
                measurementSource: 'roku.timeToStartStreaming'
            }
        ]
    };
    assert.equal((await request('/api/v2/analytics', payload)).status, 200);
    payload.events[0].watchSeconds = -1;
    const invalid = await request('/api/v2/analytics', payload);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'invalid-event-measurement');
});
test('the operator store is the configuration a television actually reads', async () => {
    const before = await request('/api/v2/config');
    assert.equal(before.status, 200);
    writeFileSync(
        operatorStore,
        JSON.stringify({ channel: { name: 'Edited In The Admin Panel' }, branding: { colors: { accent: '0x1234AB' } } })
    );
    const after = await request('/api/v2/config');
    assert.equal(after.status, 200);
    assert.equal(
        after.body.config.channel.name,
        'Edited In The Admin Panel',
        'an admin-panel edit still did not reach the client config'
    );
    assert.equal(after.body.config.branding.colors.accent, '0x1234AB');
    assert.equal(
        after.body.config.features.analytics,
        true,
        'the merge deleted a feature flag the operator never touched'
    );
    assert.equal(
        after.body.config.content.sourceUrl,
        base + '/api/v2/feed',
        'the merge lost the origin rewrite that keeps a TV pointed at its own server'
    );
    assert.notEqual(
        after.body.configVersion,
        before.body.configVersion,
        'an edit did not move the version clients compare'
    );
    const feed = await request('/api/v2/feed');
    assert.equal(
        feed.body.config.channel.name,
        'Edited In The Admin Panel',
        'the feed and the config endpoint disagree about who this channel is'
    );
    writeFileSync(operatorStore, JSON.stringify({ branding: { nope: 'not in the contract' } }));
    const refused = await request('/api/v2/config');
    assert.equal(refused.status, 200);
    assert.ok((refused.body.refusedKeys || []).includes('unknown-key:branding.nope'), JSON.stringify(refused.body));
    assert.match(refused.body.configNotice, /store-rejected/);
    assert.equal(
        refused.body.config.channel.name,
        'Example TV',
        'a refused layer still changed what the television was served'
    );
    assert.equal((await request('/feed')).status, 200, 'legacy feed availability is still collateral damage');
});

/**
 * Admin exposure over real HTTP (2026-11-08).
 *
 * `tests/unit/test-lanRestrictExposure.mjs` proves the decision table; this file proves the decision is
 * actually applied, on a real `server.js`, over both address families - which is the whole point, since the
 * defect was that an IPv6 peer reached the admin panel of a box configured "LAN only". Node binds dual-stack
 * here (measured: a socket accepted on `[::1]` reports the peer `::1`), so the two families can be driven
 * against one process without touching a firewall or another tenant's port.
 *
 * Scope asserted on purpose: the restriction belongs to the operator surface. `/health` and `/api/v2/*` stay
 * reachable, because monitoring (the alert router, the blackbox probe) and the televisions must not be
 * locked out by an operator's LAN allow-list.
 */

import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'ctv-exposure-'));
const port = Number(process.env.ADMIN_EXPOSURE_PORT || 3138);
const v4 = `http://127.0.0.1:${port}`;
const v6 = `http://[::1]:${port}`;
let child;
let log = '';

const media = path.join(temp, 'media');
const operatorStore = path.join(temp, 'channel-config.json');
const feedFixture = path.join(temp, 'feed.json');
mkdirSync(media);
writeFileSync(
    operatorStore,
    JSON.stringify({
        version: '1.0.0',
        channel: { name: 'Exposure Church', description: 'Sermons', language: 'en', copyright: '(c) 2026' },
        content: { sourceUrl: `${v4}/feed` },
        branding: { colors: { accent: '0xE8B931' } }
    })
);
writeFileSync(
    feedFixture,
    JSON.stringify({
        providerName: 'Exposure Church',
        lastUpdated: '2026-11-08T00:00:00.000Z',
        language: 'en',
        feedVersion: '1',
        'November 2026': []
    })
);

async function get(base, url, headers = {}) {
    const r = await fetch(base + url, { headers, redirect: 'manual' });
    const text = await r.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }
    return { status: r.status, body, headers: Object.fromEntries(r.headers) };
}

before(async () => {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '::', () => probe.close(resolve));
    });
    child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            URL: v4,
            DB_PATH: path.join(temp, 'analytics.db'),
            CTV_V2_FEED_PATH: feedFixture,
            CTV_VIDEOS_DIR: media,
            CTV_CHANNEL_CONFIG: operatorStore,
            ADMIN_PASSWORD: 'local-exposure-test-only',
            SESSION_SECRET: 'local-exposure-session-only',
            // The LAN, in the family the operator actually configured. No IPv6 network is named, which is
            // exactly the configuration that used to admit every IPv6 visitor.
            ALLOWED_NETWORKS: '127.0.0.1/32',
            STRIKESAFE: 'false',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const until = Date.now() + 30000;
    while (Date.now() < until) {
        try {
            if ((await fetch(v4 + '/health')).ok) return;
        } catch {}
        if (child.exitCode !== null) throw new Error('server-start-failed:' + log);
        await new Promise((r) => setTimeout(r, 100));
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

test('the configured LAN reaches the admin panel', async () => {
    const res = await get(v4, '/admin/', { accept: 'text/html' });
    assert.notEqual(
        res.status,
        403,
        `a configured LAN peer was refused: ${res.status} ${String(res.body).slice(0, 120)}`
    );
    assert.ok(res.status === 200 || res.status === 302, `expected the login page or a redirect, got ${res.status}`);
});

test('an IPv6 peer is refused on the operator surface, with the reason on the response', async () => {
    const html = await get(v6, '/admin/', { accept: 'text/html' });
    assert.equal(
        html.status,
        403,
        `the "LAN only" panel served an IPv6 peer: ${html.status} ${String(html.body).slice(0, 120)}`
    );
    assert.equal(
        html.headers['x-ctv-denied'],
        'address-not-allowed',
        'the HTML refusal has no machine-readable code for a log or a probe'
    );
    assert.match(String(html.body), /LAN/i, 'a person following a link got no explanation');

    const json = await get(v6, '/admin/', { accept: 'application/json' });
    assert.equal(json.status, 403);
    assert.equal(json.body.error, 'lan-restricted', JSON.stringify(json.body));
    assert.equal(json.body.reason, 'address-not-allowed');
    assert.equal(json.body.peer, '::1', `the refusal did not name the peer: ${JSON.stringify(json.body)}`);
    assert.deepEqual(json.body.networks, ['127.0.0.1/32']);
});

test('monitoring and the television surface stay reachable on both families', async () => {
    for (const base of [v4, v6]) {
        const health = await get(base, '/health');
        assert.equal(health.status, 200, `/health was refused from ${base}: ${health.status}`);
        const v2 = await get(base, '/api/v2/health');
        assert.equal(v2.status, 200, `/api/v2/health was refused from ${base}: ${v2.status}`);
    }
    const feed = await get(v6, '/api/v2/feed');
    assert.equal(feed.status, 200, 'a television on the site IPv6 could not fetch its feed');
});

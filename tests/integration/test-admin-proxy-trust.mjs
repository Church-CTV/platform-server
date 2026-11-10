/**
 * Who the LAN restriction thinks the client is, behind a reverse proxy (2026-11-08).
 *
 * `ALLOWED_NETWORKS` only protects the operator surface if the address it judges is the visitor's address.
 * On the deployment this product actually ships to - Caddy in front of the node process on one box - the
 * socket peer *is* the proxy, so every visitor on the internet arrives as `127.0.0.1` and a "LAN only"
 * admin panel is open to everyone. Express learns the real client only when `trust proxy` is set, and
 * nothing in this app used to set it: `lib/adminAuth.js` and `middleware/rateLimit.js` already read a
 * `TRUST_PROXY` environment variable, so the login lockout could key on the forwarded address while
 * `req.ip` - the address the LAN gate judges - stayed the proxy's. Two answers to one question.
 *
 * Booted twice, on ports handed over by `../tools/port-check.sh`: once with the switch on (the proxied
 * deployment) and once with it off (a directly-bound self-host box). Both behaviours are pinned, because
 * the dangerous one is the silent fail-open, not the refusal.
 */

import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'ctv-proxy-'));
const baseStore = path.join(temp, 'channel-config.json');
const feedFixture = path.join(temp, 'feed.json');
mkdirSync(path.join(temp, 'media'));

function configUrl(port) {
    return `http://127.0.0.1:${port}`;
}

writeFileSync(
    baseStore,
    JSON.stringify({
        version: '1.0.0',
        channel: { name: 'Proxy Church', description: 'Sermons', language: 'en', copyright: '(c) 2026' },
        content: { sourceUrl: 'http://127.0.0.1:1/feed' },
        branding: { colors: { accent: '0xE8B931' } }
    })
);
writeFileSync(
    feedFixture,
    JSON.stringify({
        providerName: 'Proxy Church',
        lastUpdated: '2026-11-08T00:00:00.000Z',
        language: 'en',
        feedVersion: '1',
        'November 2026': []
    })
);

async function freePort(port) {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
}

async function boot(port, extraEnv) {
    await freePort(port);
    const base = configUrl(port);
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            URL: base,
            DB_PATH: path.join(temp, `analytics-${port}.db`),
            CTV_V2_FEED_PATH: feedFixture,
            CTV_VIDEOS_DIR: path.join(temp, 'media'),
            CTV_VIDEOS_METADATA: path.join(temp, `videos-${port}.json`),
            CTV_FEED_OUTPUT_DIR: path.join(temp, `output-${port}`),
            CTV_CHANNEL_CONFIG: baseStore,
            CTV_UPLOADS_DIR: path.join(temp, `uploads-${port}`),
            CTV_AUDIT_DIR: path.join(temp, `audit-${port}`),
            ADMIN_PASSWORD: 'local-proxy-test-only',
            SESSION_SECRET: 'local-proxy-session-only',
            ALLOWED_NETWORKS: '127.0.0.1/32',
            STRIKESAFE: 'false',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
            ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const until = Date.now() + 40000;
    while (Date.now() < until) {
        try {
            if ((await fetch(base + '/health')).ok) return { child, base, log: () => log };
        } catch {}
        if (child.exitCode !== null) throw new Error(`server-start-failed on ${port}: ${log}`);
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server-start-timeout on ${port}: ${log}`);
}

async function get(base, url, headers = {}) {
    const res = await fetch(base + url, { headers, redirect: 'manual' });
    const text = await res.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }
    return { status: res.status, body, headers: Object.fromEntries(res.headers) };
}

const FORGED = '203.0.113.9'; // TEST-NET-3: an address that is certainly not this LAN
const trusted = { port: Number(process.env.PROXY_TRUST_PORT || 3164) };
const direct = { port: Number(process.env.PROXY_DIRECT_PORT || 3165) };

before(async () => {
    const a = await boot(trusted.port, { TRUST_PROXY: 'true' });
    trusted.child = a.child;
    trusted.base = a.base;
    trusted.log = a.log;
    const b = await boot(direct.port, { TRUST_PROXY: 'false' });
    direct.child = b.child;
    direct.base = b.base;
    direct.log = b.log;
});

after(async () => {
    for (const entry of [trusted, direct]) {
        if (entry.child && entry.child.exitCode === null) {
            await new Promise((resolve) => {
                entry.child.once('exit', resolve);
                entry.child.kill('SIGTERM');
                setTimeout(() => entry.child.kill('SIGKILL'), 5000).unref();
            });
        }
    }
    // /tmp and the checkout are different filesystems here; rm -rf of the tree is enough.
    const { rmSync } = await import('node:fs');
    rmSync(temp, { recursive: true, force: true });
});

test('behind the proxy, the forwarded address is the one the operator surface judges', async () => {
    const res = await get(trusted.base, '/admin/', { accept: 'application/json', 'x-forwarded-for': FORGED });
    assert.equal(
        res.status,
        403,
        `an internet visitor behind the proxy reached the "LAN only" panel: ${res.status} ${String(res.body).slice(0, 160)}\nserver: ${trusted.log().slice(-400)}`
    );
    assert.equal(res.headers['x-ctv-denied'], 'address-not-allowed');
    assert.equal(res.body.peer, FORGED, `the refusal did not name the forwarded client: ${JSON.stringify(res.body)}`);
});

test('a proxy on the box itself still serves the operator', async () => {
    const viaProxy = await get(trusted.base, '/admin/', { accept: 'application/json', 'x-forwarded-for': '127.0.0.1' });
    assert.notEqual(
        viaProxy.status,
        403,
        `the operator behind their own proxy was locked out: ${viaProxy.status} ${String(viaProxy.body).slice(0, 160)}`
    );
    const directPeer = await get(trusted.base, '/admin/', { accept: 'application/json' });
    assert.notEqual(directPeer.status, 403, 'a request with no XFF was refused on a trust-proxy box');
});

test('monitoring is not gated by the forwarded address', async () => {
    const health = await get(trusted.base, '/health', { 'x-forwarded-for': FORGED });
    assert.equal(health.status, 200, 'the alert router probe was refused');
    const v2 = await get(trusted.base, '/api/v2/health', { 'x-forwarded-for': FORGED });
    assert.equal(v2.status, 200, 'a television behind the proxy could not reach the v2 health endpoint');
});

test('without TRUST_PROXY a forged header is ignored and the proxy address is what gets judged', async () => {
    // The failure mode this pins: on a proxied box that never set the switch, the gate sees the proxy
    // (here: loopback) and admits everyone. It is not fixed by code alone; it is a deployment setting, and
    // the honest thing is to keep it measured rather than assumed.
    const forged = await get(direct.base, '/admin/', { accept: 'application/json', 'x-forwarded-for': FORGED });
    assert.notEqual(forged.status, 403, 'an untrusted X-Forwarded-For was acted on');
    assert.notEqual(
        forged.body && forged.body.reason,
        'address-not-allowed',
        `the LAN gate judged the forwarded address without being told to: ${JSON.stringify(forged.body)}`
    );
    // 401 is the pass: the gate let the request through because the socket peer - the proxy - is on the
    // allow-list, and only authentication stopped it. That is the silent fail-open, kept on the record.
    assert.equal(
        forged.status,
        401,
        `expected the gate to pass and authentication to refuse, got ${forged.status} ${JSON.stringify(forged.body).slice(0, 160)}`
    );
});

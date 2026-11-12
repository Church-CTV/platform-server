/**
 * `CACHE-6`: two organizations on one edge must never share a cached body, and nothing in this design may
 * promise that without measuring it. The live topology is exactly this: two origins behind one Caddy, one
 * hostname each, and the edge stores nothing today (`via: 1.1 Caddy` with no `age`/`x-cache` on any response,
 * measured in the private record t2-feed-cache-surface-2026-11-09).
 *
 * What makes cross-org leakage a real hazard rather than a theoretical one is that a validator here is a
 * content digest, and content is not always org-specific: two orgs can publish byte-identical feed files, and
 * then an org-agnostic digest plus an edge that keys on path alone lets one org's `304` answer the other's
 * question - the client keeps rendering the neighbour's document and nothing on the wire says so.
 *
 * So this file measures the two properties that close it, over two real processes with different profiles and
 * the same published bytes:
 *   1. a validator names the org, so one org's `If-None-Match` can never produce a `304` at the other;
 *   2. `Vary` names `Host`, so a shared cache is told to key on the hostname it routed by.
 * Plus the property that makes (1) safe to operate at all: the org identity is derived from configuration, so
 * a restart of the same deployment keeps its digests instead of invalidating every client on the estate.
 */

import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeHttp from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const temp = mkdtempSync(path.join(os.tmpdir(), 'ctv-org-isolation-'));
const running = new Map();

const PORT_A = 3181;
const PORT_B = 3182;

// One feed document, byte-identical in both deployments: the case where an org-agnostic digest is dangerous.
const SHARED_FEED = (() => {
    const feed = {
        providerName: 'Shared Provider',
        lastUpdated: '2026-11-10T00:00:00.000Z',
        language: 'en',
        feedVersion: '1'
    };
    feed['November 2026'] = Array.from({ length: 60 }, (_, i) => ({
        id: `iso-item-${i}`,
        title: `Shared item ${i} ${'the same bytes in both deployments '.repeat(5)}`,
        shortDescription: 'a description identical across orgs so the digests would collide if none named one '.repeat(
            3
        ),
        genres: ['sermon'],
        releaseDate: '2026-11-02',
        length: 1800,
        contentId: `iso-content-${i}`
    }));
    return JSON.stringify(feed);
})();

function fixture({ port, host, name }) {
    const dir = path.join(temp, `p${port}`);
    mkdirSync(path.join(dir, 'output', 'thumbnails'), { recursive: true });
    mkdirSync(path.join(dir, 'media'), { recursive: true });
    writeFileSync(
        path.join(dir, 'channel-config.json'),
        JSON.stringify({
            version: '1.0.0',
            channel: { name, description: `${name} description`, language: 'en', copyright: `(c) 2026 ${name}` },
            content: { sourceUrl: `${host}/api/v2/feed`, maxRows: 12 },
            branding: { colors: { accent: '0xE8B931' } }
        })
    );
    writeFileSync(path.join(dir, 'feed.json'), SHARED_FEED);
    writeFileSync(path.join(dir, 'output', 'roku_feed.json'), SHARED_FEED);
    // A tiny PNG at the name the generated-art policy covers, so `/output/thumbnails/*` is a real response.
    writeFileSync(
        path.join(dir, 'output', 'thumbnails', 'probe.png'),
        Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'
        )
    );
    return { dir, dbPath: path.join(dir, 'analytics.db') };
}

async function freePort(port) {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', () => reject(new Error(`port ${port} is already taken - pick another`)));
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
}

async function start({ port, host, name, env = {} }) {
    await freePort(port);
    const { dir, dbPath } = fixture({ port, host, name });
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            URL: host,
            ADMIN_PASSWORD: 'local-cache-test-only',
            DB_PATH: dbPath,
            CTV_V2_FEED_PATH: path.join(dir, 'feed.json'),
            CTV_FEED_OUTPUT_DIR: path.join(dir, 'output'),
            CTV_VIDEOS_DIR: path.join(dir, 'media'),
            CTV_VIDEOS_METADATA: path.join(dir, 'videos.json'),
            CTV_AUDIT_DIR: path.join(dir, 'audit'),
            CTV_CHANNEL_CONFIG: path.join(dir, 'channel-config.json'),
            SESSION_SECRET: 'local-org-isolation-only',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    running.set(port, child);
    let log = '';
    child.stdout.on('data', (c) => (log += c));
    child.stderr.on('data', (c) => (log += c));

    let up = false;
    for (let i = 0; i < 120 && !up; i += 1) {
        try {
            up = (await fetch(`http://127.0.0.1:${port}/api/v2/health`)).status === 200;
        } catch {
            /* not listening yet */
        }
        if (!up && child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${log.slice(0, 800)}`);
        if (!up) await new Promise((done) => setTimeout(done, 250));
    }
    if (!up) throw new Error(`server never became healthy: ${log.slice(0, 800)}`);
    return child;
}

function stop(port) {
    const child = running.get(port);
    if (!child) return Promise.resolve();
    running.delete(port);
    return new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
        }, 5000).unref();
    });
}

/** Raw `node:http`, because `fetch` discards a 304 body and decompresses gzip (C214). */
function request({ port, path: reqPath, host, headers = {}, method = 'GET' }) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const req = nodeHttp.request(
            { host: '127.0.0.1', port, path: reqPath, method, headers: { Host: host, ...headers } },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks),
                        ms: Date.now() - started
                    })
                );
            }
        );
        req.on('error', reject);
        req.end();
    });
}

const varyNames = (headers) =>
    (Array.isArray(headers.vary) ? headers.vary : [headers.vary || ''])
        .join(',')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);

before(async () => {
    // Same published bytes, two orgs, two hosts: what one Caddy in front of two origins actually is.
    await start({ port: PORT_A, host: `http://127.0.0.1:${PORT_A}`, name: 'Org Alpha' });
    await start({ port: PORT_B, host: `http://127.0.0.1:${PORT_B}`, name: 'Org Beta' });
});

after(async () => {
    for (const port of [...running.keys()]) await stop(port);
    rmSync(temp, { recursive: true, force: true });
});

test('CACHE-6: the two deployments really do publish identical feed bytes (the dangerous case, established)', async () => {
    const a = await request({ port: PORT_A, path: '/feed', host: 'alpha.example' });
    const b = await request({ port: PORT_B, path: '/feed', host: 'beta.example' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(
        a.body.length,
        b.body.length,
        'the fixtures drifted: the bodies must be identical for this test to mean anything'
    );
    assert.ok(a.body.equals(b.body), 'two orgs publishing the same bytes is the case this gate exists for');
});

test('CACHE-6: a validator names its org, so one org cannot 304 the other', async () => {
    const a = await request({ port: PORT_A, path: '/feed', host: 'alpha.example' });
    const b = await request({ port: PORT_B, path: '/feed', host: 'beta.example' });
    const etagA = a.headers.etag;
    const etagB = b.headers.etag;
    assert.ok(etagA && etagB, 'both must send a validator');
    assert.notEqual(
        etagA,
        etagB,
        `identical bytes produced the same validator in both orgs (${etagA}): a shared cache, or a client that moves between hosts, would serve one org's document as the other's`
    );

    // The strongest form of the claim: hand org B the validator org A earned and demand a fresh body.
    const cross = await request({
        port: PORT_B,
        path: '/feed',
        host: 'beta.example',
        headers: { 'If-None-Match': etagA }
    });
    assert.equal(cross.status, 200, `org B answered a 304 to org A's validator - cross-org cache hit on ${etagA})`);
    assert.ok(cross.body.length > 0, 'the full body must ship when the validator belongs to another org');
    assert.ok(cross.body.equals(b.body), 'and it must be org B bytes, not a relabelled org A body');

    // The same-org control: the org key must be stable per deployment, not per request.
    const same = await request({
        port: PORT_A,
        path: '/feed',
        host: 'alpha.example',
        headers: { 'If-None-Match': etagA }
    });
    assert.equal(same.status, 304, "an org's own validator must still revalidate at that org");
    assert.equal(same.body.length, 0);
});

test('CACHE-6: every cached read path names Host in Vary, so a shared cache keys on the hostname', async () => {
    const paths = [
        '/feed',
        '/api/v2/feed',
        '/api/v2/config',
        '/api/v2/health',
        '/privacy',
        '/output/thumbnails/probe.png'
    ];
    for (const reqPath of paths) {
        const res = await request({ port: PORT_A, path: reqPath, host: 'alpha.example' });
        assert.equal(res.status, 200, `${reqPath} must answer 200 for its Vary to matter`);
        const names = varyNames(res.headers);
        assert.ok(names.includes('host'), `${reqPath} Vary="${names.join(', ')}" does not name Host`);
        assert.ok(names.includes('origin'), `${reqPath} Vary must keep naming Origin`);
        assert.ok(
            names.filter((n) => n === 'host').length === 1,
            `${reqPath} names Host twice: a duplicated Vary value is a header bug waiting to be blamed on the cache`
        );
    }
});

test('CACHE-6: the v2 documents differ between orgs and neither revalidates at the other', async () => {
    const a = await request({ port: PORT_A, path: '/api/v2/feed', host: 'alpha.example' });
    const b = await request({ port: PORT_B, path: '/api/v2/feed', host: 'beta.example' });
    assert.notEqual(
        a.body.toString(),
        b.body.toString(),
        'the v2 body rewrites endpoints per origin; identical bodies would mean the fixtures collapsed into one org'
    );
    assert.notEqual(a.headers.etag, b.headers.etag);

    const cfgA = await request({ port: PORT_A, path: '/api/v2/config', host: 'alpha.example' });
    const crossCfg = await request({
        port: PORT_B,
        path: '/api/v2/config',
        host: 'beta.example',
        headers: { 'If-None-Match': cfgA.headers.etag }
    });
    assert.equal(crossCfg.status, 200, "org A's config validator must not revalidate at org B");
    assert.notEqual(crossCfg.headers.etag, cfgA.headers.etag);

    // `CACHE-11` still holds inside each org, which is the property the namespace must not break.
    for (const [port, host] of [
        [PORT_A, 'alpha.example'],
        [PORT_B, 'beta.example']
    ]) {
        const feed = await request({ port, path: '/api/v2/feed', host });
        const cfg = await request({ port, path: '/api/v2/config', host });
        const inBody = JSON.parse(feed.body.toString()).configVersion;
        const published = JSON.parse(cfg.body.toString()).configVersion;
        assert.equal(inBody, published, `the v2 feed at port ${port} does not name the config it embeds`);
    }
});

test('CACHE-6: restarting a deployment keeps its digests - the org key is configuration, not a per-boot value', async () => {
    const first = await request({ port: PORT_A, path: '/feed', host: 'alpha.example' });
    const firstCfg = await request({ port: PORT_A, path: '/api/v2/config', host: 'alpha.example' });
    await stop(PORT_A);
    await start({ port: PORT_A, host: `http://127.0.0.1:${PORT_A}`, name: 'Org Alpha' });

    const again = await request({ port: PORT_A, path: '/feed', host: 'alpha.example' });
    const againCfg = await request({ port: PORT_A, path: '/api/v2/config', host: 'alpha.example' });
    assert.equal(
        again.headers.etag,
        first.headers.etag,
        'a restart changed what the same bytes digest to: every client on the estate just took a forced refetch'
    );
    assert.equal(againCfg.headers.etag, firstCfg.headers.etag, 'same for the config representation');

    // And the other org is still distinct after the restart, so the namespace is not a process-local secret.
    const b = await request({ port: PORT_B, path: '/feed', host: 'beta.example' });
    assert.notEqual(again.headers.etag, b.headers.etag);
});

/**
 * The save loop, end to end, on an isolated server: an operator edit in the configured store has to
 * reach the endpoint a television reads, move the revision, and a refused edit has to change nothing
 * a television can see.
 *
 * Why a second integration file (measured 2026-11-08): `tests/integration/test-v2-contract.mjs`
 * proves the read side over HTTP, and `tests/unit/test-configStore-write-path.mjs` proves the writer
 * in a temp directory. Nothing proved the two meet - which is exactly the split-brain the design
 * calls the single biggest correctness risk, and the defect the M0 write path just fixed. This file
 * runs the real `server.js` on a free port with its own channel store, feed, media and analytics
 * database in a temporary directory: no shared stage (:3105 answers 000 and is the owner's call to
 * restart), no production write, no port hijacked (the project's port-check tooling before placement, and the
 * harness itself refuses a taken port before spawning).
 */

import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'ctv-save-loop-'));
const port = Number(process.env.SAVE_LOOP_PORT || 3124);
const base = 'http://127.0.0.1:' + port;
let child;
let log = '';

const dbPath = path.join(temp, 'analytics.db');
const media = path.join(temp, 'media');
const operatorStore = path.join(temp, 'channel-config.json');
const feedFixture = path.join(temp, 'feed.json');

const storeContents = {
    version: '1.0.0',
    channel: { name: 'Loop Church', description: 'Every sermon we have', language: 'en', copyright: '(c) 2026' },
    content: { sourceUrl: base + '/feed' },
    branding: { colors: { accent: '0xE8B931' } },
    heartbeat: { enabled: true, intervalSeconds: 600, exportUrl: '/api/heartbeat' }
};

mkdirSync(media);
writeFileSync(path.join(media, 'probe.mp4'), '0123456789');
writeFileSync(operatorStore, JSON.stringify(storeContents, null, 2));
// The feed carries no config block, so the operator store is the only thing that can move what a
// television is handed - if it is not, this file fails rather than passing by coincidence.
writeFileSync(
    feedFixture,
    JSON.stringify({
        providerName: 'Loop Church',
        lastUpdated: '2026-11-08T00:00:00.000Z',
        language: 'en',
        feedVersion: '1',
        'November 2026': [
            {
                id: 'loop-1',
                title: 'One sermon',
                shortDescription: '',
                thumbnail: `${base}/output/thumbnails/loop.png`,
                releaseDate: '2026-11-01',
                genres: ['Religious'],
                content: {
                    duration: 600,
                    videos: [{ url: `${base}/stream/loop.mp4`, quality: 'HD', videoType: 'MP4' }]
                }
            }
        ]
    })
);

// Same env the child gets, so the in-process writer and the running reader point at one store.
process.env.CTV_CHANNEL_CONFIG = operatorStore;
const configStore = require('../../lib/configStore.js');

async function get(url) {
    const r = await fetch(base + url);
    const text = await r.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }
    // The published bytes matter as much as the parsed body: "a refusal changed nothing" is a claim
    // about bytes. `routes/feed.js:26` reads the repo's own output feed, which is a different file
    // from the v2 fixture, so its contents are not ours to assert on - its stability is.
    return { status: r.status, body, sha: crypto.createHash('sha256').update(text).digest('hex') };
}

function save(override) {
    const next = { ...structuredClone(storeContents), ...structuredClone(override) };
    configStore.saveConfig(next);
    storeContents.branding = next.branding;
    storeContents.heartbeat = next.heartbeat;
    return next;
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
            CTV_V2_FEED_PATH: feedFixture,
            CTV_VIDEOS_DIR: media,
            CTV_CHANNEL_CONFIG: operatorStore,
            ADMIN_PASSWORD: 'local-save-loop-only',
            SESSION_SECRET: 'local-save-loop-session-only',
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
            if ((await fetch(base + '/health')).ok) return;
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

test('the store the panel writes is the config a television is handed, with the server owning relative endpoints', async () => {
    const res = await get('/api/v2/config');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
        res.body.config.branding.colors.accent,
        '0xE8B931',
        'the operator store never reached the served config'
    );
    assert.equal(res.body.config.channel.name, 'Loop Church');
    assert.equal(
        res.body.config.heartbeat.exportUrl,
        `${base}/api/heartbeat`,
        'the operator wrote a relative heartbeat endpoint and the served config did not absolutize it (decision D-T1-1)'
    );
    assert.match(res.body.configVersion, /^[0-9a-f]{64}$/);
    assert.ok(!res.body.configNotice, `a clean store reported a refusal: ${res.body.configNotice}`);
    const feed = await get('/feed');
    assert.equal(feed.status, 200, 'a valid operator store broke the legacy feed');
    assert.ok(
        typeof feed.body.providerName === 'string' && feed.body.providerName.length > 0,
        `legacy /feed is not a feed: ${JSON.stringify(feed.body).slice(0, 120)}`
    );
    // Not asserted: the rig feed's month-group shape. Measured 2026-11-08, `output/test_feed.json`
    // groups as "2026 11" and carries "LIVE NOW" / "Apple Reference" / "Advanced Tests" rows, which the
    // frozen feed contract refuses outright (`no-month-groups`, four `unknown-key:`s). The legacy route
    // is a compatibility surface; its stability is the invariant tested here, its format is T1's.
});

test('an edit made through the real writer moves the revision the client compares', async () => {
    const before = await get('/api/v2/config');
    save({ branding: { ...storeContents.branding, colors: { accent: '0x22AA55' } } });
    const after = await get('/api/v2/config');
    assert.equal(after.status, 200);
    assert.equal(
        after.body.config.branding.colors.accent,
        '0x22AA55',
        'an edit saved through configStore never reached /api/v2/config'
    );
    assert.notEqual(
        after.body.configVersion,
        before.body.configVersion,
        'configVersion did not move for an edit a television can see'
    );
    const feed = await get('/api/v2/feed');
    assert.equal(feed.status, 200);
    assert.equal(
        feed.body.config.branding.colors.accent,
        '0x22AA55',
        'the feed and the config endpoint disagree about the same channel'
    );
});

test('a refused save changes nothing a television can see, and says why in a machine-readable way', async () => {
    const good = await get('/api/v2/config');
    const goodFeed = await get('/feed');
    const junk = structuredClone(storeContents);
    junk.entitlement = { tier: 'cloud' };
    let failure;
    try {
        configStore.saveConfig(junk);
    } catch (err) {
        failure = err;
    }
    assert.ok(failure, 'an unknown key was accepted by the writer');
    assert.deepEqual(
        failure.reasons,
        ['unknown-key:entitlement'],
        `${failure.message} ${JSON.stringify(failure.reasons)}`
    );
    const after = await get('/api/v2/config');
    assert.equal(after.status, 200);
    assert.equal(after.body.configVersion, good.body.configVersion, 'a refused save moved the served revision');
    assert.deepEqual(after.body.config, good.body.config, 'a refused save changed the served config');
    assert.match(
        readFileSync(operatorStore, 'utf8'),
        /"accent": "0x22AA55"/,
        'the store bytes did not keep the last accepted edit'
    );
    assert.match(readFileSync(operatorStore, 'utf8'), /0x22AA55/, 'the refused edit landed in the store anyway');
    assert.doesNotMatch(readFileSync(operatorStore, 'utf8'), /entitlement/, 'the refused key landed in the store');
    const feed = await get('/feed');
    assert.equal(feed.status, 200, 'a refused config save broke the legacy feed');
    assert.equal(feed.sha, goodFeed.sha, 'a refused config edit disturbed the published feed bytes');
});

test('a corrupt store degrades with a reason instead of taking the channel down', async () => {
    const previous = readFileSync(operatorStore, 'utf8');
    writeFileSync(operatorStore, '{ "channel": ');
    const res = await get('/api/v2/config');
    assert.ok(res.status === 200 || res.status === 400, `unexpected status ${res.status}`);
    const notice = `${JSON.stringify(res.body)}`;
    assert.match(notice, /store-unreadable/, `no machine-readable reason for an unreadable store: ${notice}`);
    const feed = await get('/feed');
    assert.equal(feed.status, 200, 'an unreadable operator store took the published feed down with it');
    writeFileSync(operatorStore, previous);
    const healed = await get('/api/v2/config');
    assert.equal(healed.status, 200);
    assert.equal(
        healed.body.config.branding.colors.accent,
        '0x22AA55',
        'the endpoint did not recover when the store did'
    );
});

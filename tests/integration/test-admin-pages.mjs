/**
 * The admin screens actually render their content (2026-11-08).
 *
 * Measured before this file existed, on a real `server.js` with a real session: `GET /admin/videos/new`
 * answered 200 with 21,795 bytes that contained the page title and the sidebar and **no form at all** - the
 * upload screen's own text ("Supported formats: MP4, MOV, AVI, MKV") was absent - and `GET /admin/config`
 * answered 200 with no Save control. The cause is in `middleware/adminAuth.js`: `renderAdmin` replaces
 * `res.render` for admin views and renders `layout` with `body: locals.body || ''`, while every route calls
 * `res.render('admin/<view>', {...})` with no `body` local, and `views/layout.ejs` prints `<%- body %>`. The
 * view file is therefore never rendered: an operator with the password gets chrome around an empty box, and
 * there is no form to submit, so the CSRF token in the layout locals is moot.
 *
 * Each row below asks for a screen and looks for a string that exists only in that screen's view file, plus
 * the CSRF field for the screens that carry a form. A 200 alone would have passed the broken build.
 */

import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const adminAuthLib = require(path.join(root, 'lib/adminAuth.js'));
const temp = mkdtempSync(path.join(tmpdir(), 'ctv-pages-'));
const port = Number(process.env.ADMIN_PAGES_PORT || 3154);
const base = `http://127.0.0.1:${port}`;
const videosDir = path.join(temp, 'videos');
const metadataFile = path.join(temp, 'videos.json');
const hashFile = path.join(root, '.admin_password_hash');
const password = 'local-pages-test-only';
let child;
let log = '';
let savedHash = null;

mkdirSync(videosDir);
// One video on disk and in the metadata store, so the video list has something to show.
writeFileSync(path.join(videosDir, 'morning-talk.mp4'), 'placeholder');
writeFileSync(
    metadataFile,
    JSON.stringify({
        'morning-talk.mp4': { title: 'Morning Talk', category: 'Sermons', releaseDate: '2026-11-01', duration: 120 }
    })
);

const operatorStore = path.join(temp, 'channel-config.json');
const feedFixture = path.join(temp, 'feed.json');
writeFileSync(
    operatorStore,
    JSON.stringify({
        version: '1.0.0',
        channel: { name: 'Render Church', description: 'Sermons for the test', language: 'en', copyright: '(c) 2026' },
        content: { sourceUrl: `${base}/feed` },
        branding: { colors: { accent: '0xE8B931' } }
    })
);
// The published feed the operator sees on /admin/feed lives in the configured output directory
// (`CTV_FEED_OUTPUT_DIR`), which is a different file from the v2 fixture the television fetches.
const publishedFeed = path.join(temp, 'output', 'roku_feed.json');
mkdirSync(path.join(temp, 'output'), { recursive: true });
writeFileSync(
    publishedFeed,
    JSON.stringify({
        providerName: 'Render Church',
        feedVersion: '1',
        'October 2026': [{ title: 'Last Month Talk', uri: `${base}/videos/morning-talk.mp4` }],
        'November 2026': [{ title: 'Morning Talk', uri: `${base}/videos/morning-talk.mp4` }]
    })
);
writeFileSync(
    feedFixture,
    JSON.stringify({
        providerName: 'Render Church',
        lastUpdated: '2026-11-08T00:00:00.000Z',
        language: 'en',
        feedVersion: '1',
        'November 2026': [{ title: 'Morning Talk', uri: `${base}/videos/morning-talk.mp4`, duration: '00:02:00' }]
    })
);

let cookie = '';
async function request(url, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(base + url, {
        method,
        body,
        headers: { ...(cookie ? { cookie } : {}), ...headers },
        redirect: 'manual'
    });
    for (const entry of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const pair = entry.split(';')[0]; // keep "name=value", that is what a Cookie header carries
        const merged = new Map(
            (cookie || '')
                .split('; ')
                .filter(Boolean)
                .map((p) => [p.slice(0, p.indexOf('=')), p])
        );
        merged.set(pair.slice(0, pair.indexOf('=')), pair);
        cookie = [...merged.values()].join('; ');
    }
    return { status: res.status, text: await res.text(), headers: Object.fromEntries(res.headers) };
}

async function login() {
    const page = await request('/admin/login');
    const token = (/name="_csrf"[^>]*value="([^"]*)"/.exec(page.text) || [])[1] || '';
    const res = await request('/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password, _csrf: token })
    });
    assert.equal(res.status, 302, `login did not redirect: ${res.status} ${res.text.slice(0, 200)}`);
}

const screens = [
    { url: '/admin', marker: 'Total Videos', form: false },
    { url: '/admin/videos', marker: 'Morning Talk', form: false },
    { url: '/admin/videos/new', marker: 'Supported formats', form: true },
    { url: '/admin/videos/morning-talk.mp4/edit', marker: 'Save Changes', form: true },
    { url: '/admin/config', marker: 'Channel Configuration', form: true },
    { url: '/admin/feed', marker: 'Feed Details', form: true },
    { url: '/admin/feed', marker: 'October 2026', form: false },
    { url: '/admin/analytics', marker: 'Top Videos by Plays', form: false },
    { url: '/admin/audit-log', marker: 'total entry', form: true },
    { url: '/admin/settings', marker: 'Change Password', form: true }
];

before(async () => {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
    if (existsSync(hashFile)) {
        savedHash = readFileSync(hashFile);
        rmSync(hashFile, { force: true });
    }
    writeFileSync(hashFile, adminAuthLib.hashPassword(password));
    child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            URL: base,
            DB_PATH: path.join(temp, 'analytics.db'),
            CTV_V2_FEED_PATH: feedFixture,
            CTV_VIDEOS_DIR: videosDir,
            CTV_VIDEOS_METADATA: metadataFile,
            CTV_FEED_OUTPUT_DIR: path.join(temp, 'output'),
            CTV_AUDIT_DIR: path.join(temp, 'audit'),
            CTV_CHANNEL_CONFIG: operatorStore,
            ADMIN_PASSWORD: password,
            SESSION_SECRET: 'local-pages-session-only',
            STRIKESAFE: 'false',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const until = Date.now() + 40000;
    while (Date.now() < until) {
        try {
            if ((await fetch(base + '/health')).ok) return await login();
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
    if (savedHash !== null) writeFileSync(hashFile, savedHash);
    else rmSync(hashFile, { force: true });
    rmSync(temp, { recursive: true, force: true });
});

for (const screen of screens) {
    test(`${screen.url} renders its own content`, async () => {
        const res = await request(screen.url);
        const surfaced = (res.text.match(
            /(?:Error|TypeError|ReferenceError|Cannot read[^<]*|is not a function[^<]*|is not defined[^<]*)[^<]{0,160}/i
        ) || [''])[0].replace(/\s+/g, ' ');
        assert.equal(
            res.status,
            200,
            `${screen.url} returned ${res.status}${surfaced ? ` (${surfaced.slice(0, 200)})` : ''}: ${res.text.slice(0, 160)}`
        );
        assert.match(
            res.text,
            new RegExp(screen.marker.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)),
            `${screen.url} answered 200 without its own content ("${screen.marker}"); the operator sees the sidebar and an empty box. Headline: ${(res.text.match(/<h2[^>]*>[^<]*/g) || []).join(' / ').slice(0, 120)}`
        );
        if (screen.form) {
            assert.match(
                res.text,
                /name="_csrf"/,
                `${screen.url} has a form screen with no CSRF field - its POSTs cannot pass validation`
            );
        }
    });
}

test('the login page still renders standalone (not wrapped in the admin chrome)', async () => {
    cookie = '';
    const res = await request('/admin/login');
    assert.equal(res.status, 200);
    assert.match(res.text, /name="_csrf"/, 'the login form lost its CSRF field');
    assert.ok(!/Logout/.test(res.text), 'the login page rendered the signed-in sidebar');
});

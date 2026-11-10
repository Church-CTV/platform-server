/**
 * The only feed-regeneration mechanism there is: an operator clicking a button (night of 2026-11-09)
 *
 * `C188` measured that nothing regenerates either published feed - no cron, no timer, no in-process job; the last
 * observable regeneration on one origin was 35 days before the measurement. So `POST /admin/feed/regenerate` is
 * not a convenience, it is the mechanism, and any scheduled regeneration the owner approves would run the same
 * code. Until this file, nothing tested it end to end: the generator has unit tests and the published surface has
 * contract tests, but the route that an operator actually presses - through authentication, CSRF and the redirect
 * that renders the result - had none.
 *
 * It runs against a real `server.js` in a temp world: a real two-second ffmpeg-encoded sermon with an
 * authoritative date in its filename, an operator store, a pre-existing published feed so the backup question can
 * be answered, and the repository's own content directories watched for change.
 *
 * `server.js` is started on a probed free port; deployment state the server would otherwise read is copied aside
 * and put back, because /tmp is a different filesystem from the checkout here (measured: rename gives EXDEV).
 *
 * Mutation check (each applied to the shipping code, run, then restored byte-exactly; control `NO-IDENTICAL`):
 *   - G1 publish log names the module default path again: CAUGHT
 *   - G2 the catch block flashes the generic sentence again: CAUGHT
 *   - G4 remove the `.bak` copy: CAUGHT
 *   - control: anchor absent -> NO-IDENTICAL
 * Purity: `sha256sum` over `Videos/`, `output/`, `uploads/` and `config.json`, `videos.json`, `analytics.db`,
 * `.admin_password_hash` is identical before and after the file runs inside `npm run test:all`.
 */

import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const adminAuthLib = require(path.join(root, 'lib/adminAuth.js'));
const { validateFeed } = require(path.join(root, 'lib/feedValidator.js'));

const temp = mkdtempSync(path.join(tmpdir(), 'ctv-regen-'));
const port = Number(process.env.ADMIN_REGEN_PORT || 3147);
const base = `http://127.0.0.1:${port}`;
const videosDir = path.join(temp, 'Videos');
// The validator resolves the content root at call time (`lib/feedValidator.js:134`), so this process has to be
// pointed at the same temp world the server was started with; otherwise it checks the fixture against the
// repository's own `Videos/` directory and reports a sermon that exists as missing.
process.env.CTV_VIDEOS_DIR = videosDir;
const metadataFile = path.join(temp, 'videos.json');
const outputDir = path.join(temp, 'output');
const feedFile = path.join(outputDir, 'roku_feed.json');
const uploadDir = path.join(temp, 'uploads');
const operatorStore = path.join(temp, 'channel-config.json');
const hashFile = path.join(root, '.admin_password_hash');
const password = 'local-regen-test-only';
let child;
let log = '';
const aside = [];

const previousFeed = {
    providerName: 'Regenerate Church',
    lastUpdated: '2026-10-04T10:30:00.000Z',
    language: 'en',
    feedVersion: '1',
    'October 2026': []
};

function copyAside(file) {
    if (!existsSync(file)) return;
    const target = path.join(temp, path.basename(file) + '.aside');
    writeFileSync(target, readFileSync(file));
    rmSync(file, { force: true });
    aside.push([file, target]);
}
function putBack() {
    for (const [file, target] of aside.splice(0).reverse()) {
        try {
            writeFileSync(file, readFileSync(target));
            rmSync(target, { force: true });
        } catch {}
    }
}
function fingerprint(dir) {
    if (!existsSync(dir)) return '<absent>';
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `${entry.name}:${readFileSync(path.join(dir, entry.name)).length}`)
        .sort()
        .join('|');
}

const jars = new Map();
async function request(url, { method = 'GET', body, headers = {}, jar = 'main' } = {}) {
    const cookie = jars.get(jar);
    const res = await fetch(base + url, {
        method,
        body,
        headers: { ...(cookie ? { cookie } : {}), ...headers },
        redirect: 'manual'
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length) {
        const merged = new Map(
            (jars.get(jar) || '')
                .split('; ')
                .filter(Boolean)
                .map((p) => p.split('='))
        );
        for (const entry of setCookies) {
            const [pair] = entry.split(';');
            const idx = pair.indexOf('=');
            merged.set(pair.slice(0, idx), pair.slice(idx));
        }
        jars.set(jar, [...merged.entries()].map(([k, v]) => `${k}${v}`).join('; '));
    }
    const text = await res.text();
    return { status: res.status, text, headers: Object.fromEntries(res.headers) };
}
function csrfFrom(html) {
    const m = /name="_csrf"[^>]*value="([^"]+)"/.exec(html) || /value="([^"]+)"[^>]*name="_csrf"/.exec(html);
    return m ? m[1] : null;
}
async function loginAndCsrf() {
    const page = await request('/admin/login');
    const token = csrfFrom(page.text);
    const body = new URLSearchParams({ password });
    if (token) body.set('_csrf', token);
    const res = await request('/admin/login', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    assert.ok(
        res.status === 302 && !String(res.headers.location).includes('/admin/login'),
        `login did not establish a session (${res.status} -> ${res.headers.location})`
    );
    const panel = await request('/admin/feed');
    return csrfFrom(panel.text);
}

before(async () => {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });

    mkdirSync(videosDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(uploadDir, { recursive: true });
    // A sermon with an authoritative date in its filename: the generator refuses to invent one, so a stub name
    // would test the refusal rather than the success path.
    execFileSync(
        'ffmpeg',
        [
            '-y',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=duration=2:size=320x240:rate=10',
            '-pix_fmt',
            'yuv420p',
            path.join(videosDir, 'Regeneration Sermon November 1 2026.mp4')
        ],
        { stdio: 'pipe' }
    );
    writeFileSync(
        operatorStore,
        JSON.stringify({
            version: '1.0.0',
            channel: { name: 'Regenerate Church', description: 'Sermons', language: 'en', copyright: '(c) 2026' },
            content: { sourceUrl: `${base}/feed` },
            branding: { colors: { accent: '0xE8B931' } }
        })
    );
    // Something already published, so "does a rebuild keep the previous bytes?" is a question with an answer.
    writeFileSync(feedFile, JSON.stringify(previousFeed, null, 2));

    copyAside(hashFile);
    writeFileSync(hashFile, adminAuthLib.hashPassword(password));
    child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            URL: base,
            DB_PATH: path.join(temp, 'analytics.db'),
            CTV_V2_FEED_PATH: feedFile,
            CTV_VIDEOS_DIR: videosDir,
            CTV_UPLOADS_DIR: uploadDir,
            CTV_VIDEOS_METADATA: metadataFile,
            CTV_FEED_OUTPUT_DIR: outputDir,
            CTV_CHANNEL_CONFIG: operatorStore,
            ADMIN_PASSWORD: password,
            SESSION_SECRET: 'local-regen-session-only',
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
            if ((await fetch(base + '/health')).ok) return;
        } catch {}
        if (child.exitCode !== null) throw new Error('server-start-failed:' + log);
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server-start-timeout:' + log);
});

after(() => {
    if (child && child.exitCode === null) {
        child.kill('SIGTERM');
    }
    putBack();
    rmSync(temp, { recursive: true, force: true });
});

const repoWatch = ['/output', '/Videos', '/uploads'].map((p) => path.join(root, p));

test('an operator can regenerate the feed, and the result is the published contract in the configured root', async () => {
    const beforeRepo = repoWatch.map(fingerprint);
    const csrf = await loginAndCsrf();
    assert.ok(csrf, 'the feed panel carries no CSRF token');
    const body = new URLSearchParams({ _csrf: csrf });
    const res = await request('/admin/feed/regenerate', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    assert.equal(
        res.status,
        302,
        `regenerate did not redirect (body: ${res.text.slice(0, 200)}); log: ${log.slice(-400)}`
    );
    assert.match(String(res.headers.location), /\/admin\/feed$/);

    assert.ok(existsSync(feedFile), 'nothing was written under the configured output root');
    const published = JSON.parse(readFileSync(feedFile, 'utf8'));
    const verdict = validateFeed(published);
    assert.ok(verdict.valid, `the regenerated feed fails the shipping validator: ${JSON.stringify(verdict.errors)}`);
    const rows = Object.keys(published).filter((k) => Array.isArray(published[k]));
    const videos = rows.flatMap((row) => published[row]);
    assert.equal(
        videos.length,
        1,
        `expected the one fixture sermon, got ${JSON.stringify(videos.map((v) => v.title))}`
    );
    assert.match(videos[0].title, /Regeneration Sermon/);
    assert.equal(
        published.feedVersion,
        '1',
        'the regenerated envelope carries no version (C191 emitted it, this proves it reaches the route)'
    );
    // `CACHE-11` on the legacy surface, end to end through the button an operator actually presses. The digest
    // is not recomputed here: the child process salts it with its own org identity, so this asserts presence
    // and shape on the wire, and `tests/unit/test-feedGenerator.mjs` pins that the value is the digest of the
    // block actually embedded - in the same process, with the same salt, so the check cannot drift.
    assert.match(
        published.configVersion,
        /^[0-9a-f]{64}$/,
        'a regenerated feed reached the published surface without naming the config it embeds'
    );
    assert.notEqual(
        readFileSync(feedFile, 'utf8'),
        JSON.stringify(previousFeed, null, 2),
        'the published feed did not change'
    );
    assert.deepEqual(repoWatch.map(fingerprint), beforeRepo, 'a repository content directory changed during the run');
});

test('a rebuild keeps the bytes it replaced, so a channel can be rebuilt from stored inputs', () => {
    const bak = `${feedFile}.bak`;
    assert.ok(existsSync(bak), 'no backup of the feed that was replaced: a failed rebuild cannot be rolled back');
    assert.deepEqual(
        JSON.parse(readFileSync(bak, 'utf8')),
        previousFeed,
        'the backup is not the feed that was published before'
    );
});

test('the log says which file was published, not the default one', () => {
    assert.ok(
        log.includes(`Feed published: ${feedFile}`),
        `the publish line does not name the file actually written (${feedFile}); log tail: ${log.slice(-400)}`
    );
});

test('a refusal leaves the published feed alone', async () => {
    const before = readFileSync(feedFile, 'utf8');
    const bakBefore = existsSync(`${feedFile}.bak`) ? readFileSync(`${feedFile}.bak`, 'utf8') : null;
    // A sermon with no authoritative date: the generator refuses to invent one.
    execFileSync(
        'ffmpeg',
        [
            '-y',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=duration=2:size=320x240:rate=10',
            '-pix_fmt',
            'yuv420p',
            path.join(videosDir, 'Undated Sermon.mp4')
        ],
        { stdio: 'pipe' }
    );
    const csrf = await loginAndCsrf();
    const res = await request('/admin/feed/regenerate', {
        method: 'POST',
        body: new URLSearchParams({ _csrf: csrf }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    assert.equal(res.status, 302);
    assert.equal(readFileSync(feedFile, 'utf8'), before, 'a refused regeneration changed the published feed');
    if (bakBefore !== null) {
        assert.equal(readFileSync(`${feedFile}.bak`, 'utf8'), bakBefore, 'a refused regeneration moved the backup');
    }
    assert.ok(!existsSync(`${feedFile}.tmp`), 'a refused regeneration left a partial write behind');
});

test('the operator is told why it was refused, not just that it failed', async () => {
    const csrf = await loginAndCsrf();
    await request('/admin/feed/regenerate', {
        method: 'POST',
        body: new URLSearchParams({ _csrf: csrf }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const panel = await request('/admin/feed');
    const failure = /Feed (generation|regeneration) failed[^<]*/i.exec(panel.text);
    assert.ok(failure, `the panel reports no failure at all: ${panel.text.slice(0, 300)}`);
    assert.match(
        failure[0],
        /(release date|Feed generation failed for)/i,
        `the refusal names no reason the operator can act on: "${failure[0]}" - the reason was thrown with the machine-readable text and dropped on the floor`
    );
});

test('the route is not reachable anonymously, and a forged request is refused before anything is generated', async () => {
    const anon = await request('/admin/feed/regenerate', {
        method: 'POST',
        body: new URLSearchParams({}),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        jar: 'anon'
    });
    assert.ok([302, 401].includes(anon.status), `anonymous regenerate returned ${anon.status}`);
    if (anon.status === 302) {
        assert.match(String(anon.headers.location), /login/, 'an anonymous POST was not sent to the login page');
    }
    const before = readFileSync(feedFile, 'utf8');
    const csrf = await loginAndCsrf();
    const forged = await request('/admin/feed/regenerate', {
        method: 'POST',
        body: new URLSearchParams({ _csrf: csrf + 'x' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    assert.ok([403, 400].includes(forged.status), `a forged CSRF token returned ${forged.status}, expected a refusal`);
    assert.equal(readFileSync(feedFile, 'utf8'), before, 'a forged request still moved the published feed');
});

test('the feed page states a status it actually checked, and ages the feed honestly', async () => {
    // The page used to render a green "Active" badge unconditionally. `C188` measured a 35-day gap between
    // regenerations on a live origin; the badge said "Active" for every one of those days.
    const fresh = await request('/admin/feed');
    assert.match(
        String(fresh.headers['x-ctv-feed-status']),
        /status=fresh/,
        `fresh feed header: ${fresh.headers['x-ctv-feed-status']}`
    );
    assert.match(fresh.text, /data-feed-status="fresh"/, 'the page carries no status it computed');
    assert.doesNotMatch(
        fresh.text,
        /class="badge badge-green">Active<\/span>/,
        'the hardcoded Active badge is still in the page'
    );

    const published = JSON.parse(readFileSync(feedFile, 'utf8'));
    const backdated = { ...published, lastUpdated: new Date(Date.now() - 40 * 86400000).toISOString() };
    writeFileSync(feedFile, JSON.stringify(backdated, null, 2));
    const stale = await request('/admin/feed');
    assert.match(
        String(stale.headers['x-ctv-feed-status']),
        /status=stale; age-days=40/,
        `stale feed header: ${stale.headers['x-ctv-feed-status']}`
    );
    assert.match(stale.text, /data-feed-status="stale"/, 'the page did not carry the stale status');
    assert.match(stale.text, /Stale \(40 days\)/, 'the page did not tell the operator how stale');

    // An unreadable feed is "missing", not "Active" - and the harness puts its own temp world back afterwards.
    const saved = readFileSync(feedFile, 'utf8');
    rmSync(feedFile);
    const gone = await request('/admin/feed');
    assert.match(
        String(gone.headers['x-ctv-feed-status']),
        /status=missing/,
        `missing feed header: ${gone.headers['x-ctv-feed-status']}`
    );
    assert.match(gone.text, /No published feed/, 'a missing feed still read as Active');
    writeFileSync(feedFile, saved);
});

/**
 * Saving the channel from the admin screen, end to end (2026-11-08).
 *
 * Until tonight the config screen never rendered its form (certificate section 15), so the operator's actual
 * save - a urlencoded POST from `views/admin/config.ejs` - had not been exercised as a user action: the
 * save-loop harness (`test-config-save-loop.mjs`) speaks to the store and the served feed, not to the form.
 * This file closes that gap, because the panel is where a church touches anything:
 *
 *  - what the screen shows is what the store holds (a person can see the current answer before changing it);
 *  - a save reaches the television (`/api/v2/config`), not just the file;
 *  - keys the form does not expose survive the save - the form carries channel, colours and images, while the
 *    store also holds `features`, `ui`, `cardStyle`, `content` and `analytics`;
 *  - an incomplete form is refused with the sentence the operator can act on, and the previous bytes stay;
 *  - a store that the published contract refuses stays refused after a panel save, with the machine-readable
 *    code visible on the screen (fail closed in a way the operator can read).
 *
 * The seed is `config.template.json` - the default the product ships and seeds itself with - copied into a
 * temporary store, so nothing here touches deployment state.
 */

import { spawn } from 'node:child_process';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const adminAuthLib = require(path.join(root, 'lib/adminAuth.js'));
const temp = mkdtempSync(path.join(tmpdir(), 'ctv-cfgform-'));
const port = Number(process.env.ADMIN_CONFIG_FORM_PORT || 3191);
const base = `http://127.0.0.1:${port}`;
const store = path.join(temp, 'channel-config.json');
const feedFixture = path.join(temp, 'feed.json');
const hashFile = path.join(root, '.admin_password_hash');
const password = 'local-cfgform-test-only';
let child;
let log = '';
let savedHash = null;

const template = JSON.parse(readFileSync(path.join(root, 'config.template.json'), 'utf8'));
template.channel = { ...template.channel, name: 'Form Church', description: 'Seeded from the shipped default' };
// The shipped default leaves `content.sourceUrl` empty (only this server knows its own origin). That is not
// a value the published contract can accept, so the harness starts with the URL filled in and keeps the
// unconfigured default as its own case at the end of this file - see "the shipped default leaves".
template.content = { ...template.content, sourceUrl: `${base}/feed` };
// `contentRoot.requireVideosDir()` refuses to boot without the media directory (fail closed, by design).
mkdirSync(path.join(temp, 'videos'), { recursive: true });
writeFileSync(store, JSON.stringify(template, null, 2));
writeFileSync(
    feedFixture,
    JSON.stringify({
        providerName: 'Form Church',
        lastUpdated: '2026-11-08T00:00:00.000Z',
        language: 'en',
        feedVersion: '1',
        'November 2026': []
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
        const pair = entry.split(';')[0];
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

function csrfFrom(html) {
    return (/name="_csrf"[^>]*value="([^"]*)"/.exec(html) || [])[1] || null;
}

function storeBytes() {
    return readFileSync(store, 'utf8');
}

async function servedConfig() {
    const res = await fetch(`${base}/api/v2/config`);
    const body = await res.text();
    assert.equal(res.status, 200, `/api/v2/config answered ${res.status}: ${body.slice(0, 500)}`);
    return JSON.parse(body);
}

async function configForm() {
    const res = await request('/admin/config');
    assert.equal(res.status, 200, `/admin/config answered ${res.status}`);
    const csrf = csrfFrom(res.text);
    assert.ok(csrf, 'the config form was rendered without a CSRF token');
    return { csrf, html: res.text };
}

function formBody(fields) {
    return new URLSearchParams(fields);
}

async function submitConfig(csrf, fields) {
    return request('/admin/config', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody({ ...fields, _csrf: csrf })
    });
}

before(async () => {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
    if (require('fs').existsSync(hashFile)) {
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
            CTV_VIDEOS_DIR: path.join(temp, 'videos'),
            CTV_VIDEOS_METADATA: path.join(temp, 'videos.json'),
            CTV_FEED_OUTPUT_DIR: path.join(temp, 'output'),
            CTV_UPLOADS_DIR: path.join(temp, 'uploads'),
            CTV_AUDIT_DIR: path.join(temp, 'audit'),
            CTV_CHANNEL_CONFIG: store,
            ADMIN_PASSWORD: password,
            SESSION_SECRET: 'local-cfgform-session-only',
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

test('the config screen shows the channel that is actually saved', async () => {
    const { html } = await configForm();
    assert.match(
        html,
        /value="Form Church"/,
        `the screen did not show the stored channel name: ${html.slice(0, 200)}\nserver: ${log.slice(-300)}`
    );
    assert.match(html, /Seeded from the shipped default/, 'the stored description was not shown back to the operator');
});

test('a save from the form reaches the television and keeps the keys the form does not expose', async () => {
    const { csrf } = await configForm();
    const before = JSON.parse(storeBytes());
    const beforeBytes = storeBytes();

    const res = await submitConfig(csrf, {
        channelName: 'Saved By Hand Church',
        channelDescription: 'Sermons saved from the panel',
        channelLanguage: 'en',
        channelCopyright: '(c) 2026 Saved',
        colorBackground: '#102030',
        colorSurface: '#203040',
        colorAccent: '#E8B931',
        imageOverhangLogo: '',
        imageBackgroundImage: '',
        imageIconFocus: ''
    });
    assert.equal(res.status, 302, `the save did not redirect: ${res.status} ${res.text.slice(0, 200)}`);
    assert.match(
        String(res.headers.location),
        /\/admin\/config/,
        `the save landed somewhere unexpected: ${res.headers.location}`
    );

    const after = JSON.parse(storeBytes());
    assert.notEqual(storeBytes(), beforeBytes, 'the store did not change at all');
    assert.equal(after.channel.name, 'Saved By Hand Church');
    assert.equal(after.channel.description, 'Sermons saved from the panel');
    assert.equal(after.channel.copyright, '(c) 2026 Saved');
    assert.equal(
        after.branding.colors.background,
        '0x102030',
        `the form sends #RRGGBB and the contract wants 0xRRGGBB: ${JSON.stringify(after.branding.colors)}`
    );

    for (const key of ['features', 'ui', 'cardStyle', 'content', 'analytics']) {
        assert.deepEqual(
            after[key],
            before[key],
            `the form does not expose "${key}" and the save dropped or changed it: ${JSON.stringify({ before: before[key], after: after[key] })}`
        );
    }
    assert.equal(
        after.branding.colors.textPrimary,
        before.branding.colors.textPrimary,
        'a colour the form has no field for was reset by the save'
    );

    const served = await servedConfig();
    const servedText = JSON.stringify(served);
    assert.match(
        servedText,
        /Saved By Hand Church/,
        `the served config still had the old channel: ${servedText.slice(0, 300)}`
    );

    const screen = await configForm();
    assert.match(
        screen.html,
        /value="Saved By Hand Church"/,
        'the screen did not show the saved name back to the operator'
    );
    assert.ok(
        !/is not a setting the television reads/.test(screen.html),
        `the save reported a refusal: ${screen.html.slice(0, 300)}`
    );
});

test('an incomplete form is refused and the previous settings stay byte for byte', async () => {
    const { csrf } = await configForm();
    const beforeBytes = storeBytes();
    const res = await submitConfig(csrf, {
        channelName: 'Cleared By Mistake',
        channelDescription: '',
        channelLanguage: 'en',
        channelCopyright: '',
        colorBackground: '#102030',
        colorSurface: '#203040',
        colorAccent: '#E8B931'
    });
    assert.equal(res.status, 302, `an incomplete save did not redirect: ${res.status}`);
    assert.equal(storeBytes(), beforeBytes, 'a refused save rewrote the store');
    const screen = await configForm();
    assert.match(
        screen.html,
        /required/,
        `the operator was not told what was missing: ${screen.html
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .slice(0, 400)}`
    );
    assert.match(screen.html, /value="Saved By Hand Church"/, 'the screen lost the stored name after a refused save');
});

test('a store the contract refuses stays refused, and the screen quotes the machine-readable reason', async () => {
    const current = JSON.parse(storeBytes());
    writeFileSync(store, JSON.stringify({ ...current, mysterySetting: 'left over from an older build' }, null, 2));
    const beforeBytes = storeBytes();

    const { csrf } = await configForm();
    const res = await submitConfig(csrf, {
        channelName: 'Refused Church',
        channelDescription: 'This save must not land',
        channelLanguage: 'en',
        channelCopyright: '(c) 2026',
        colorBackground: '#102030',
        colorSurface: '#203040',
        colorAccent: '#E8B931'
    });
    assert.equal(res.status, 302, `a refused save did not redirect: ${res.status}`);

    const screen = await configForm();
    assert.match(
        screen.html,
        /\[unknown-key:mysterySetting\]/,
        `the screen did not quote the machine-readable reason: ${screen.html
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .slice(0, 400)}\nserver: ${log.slice(-300)}`
    );
    assert.match(screen.html, /is not a setting the television reads/, 'the operator got a code with no sentence');
    assert.match(screen.html, /value="Saved By Hand Church"/, 'a refused save changed what the screen shows');

    // What a refused store does to the television, recorded as measured: the endpoint goes to 400 and names
    // the offending key, rather than serving the last accepted settings with a notice. The operator-facing
    // sentence promises the set-top box "keeps running the last settings that passed", which is true of the
    // copy the client already holds, not of this response. Whether a refused store should degrade instead of
    // answer 400 is the same open decision as the unconfigured install (the private plan of record D-T1-2), so it is pinned
    // here and left for the owner rather than decided in a test.
    const refused = await fetch(`${base}/api/v2/config`);
    const refusedBody = await refused.text();
    assert.equal(refused.status, 400, `an invalid store still served a config: ${refusedBody.slice(0, 240)}`);
    assert.match(
        refusedBody,
        /store-rejected:unknown-key:mysterySetting/,
        `the 400 did not name the offending key: ${refusedBody.slice(0, 300)}`
    );

    // Clear the offending key and show the operator can get out of it by saving again.
    const cleaned = JSON.parse(beforeBytes);
    delete cleaned.mysterySetting;
    writeFileSync(store, JSON.stringify(cleaned, null, 2));
    const retry = await configForm();
    const again = await submitConfig(retry.csrf, {
        channelName: 'Refused Church',
        channelDescription: 'Now it lands',
        channelLanguage: 'en',
        channelCopyright: '(c) 2026',
        colorBackground: '#102030',
        colorSurface: '#203040',
        colorAccent: '#E8B931'
    });
    assert.equal(again.status, 302);
    const after = JSON.parse(storeBytes());
    assert.equal(
        after.channel.name,
        'Refused Church',
        `the save after clearing the bad key did not land: ${JSON.stringify(after.channel)}\nserver: ${log.slice(-300)}`
    );
    const recovered = await servedConfig();
    assert.equal(
        recovered.config.channel.name,
        'Refused Church',
        'the served config did not come back once the store was valid again'
    );
});
test('the shipped default leaves the television without a config until the feed URL is set', async () => {
    // Evidence for the open T1 decision D-T1-2 ("what does an unconfigured install do?"), measured rather
    // than argued: `config.template.json` ships `content.sourceUrl: ""`, `normalizeEndpoints` drops an empty
    // endpoint, the published contract then refuses the operator layer whole
    // (`missing-required:content.sourceUrl`), and `/api/v2/config` answers 400 - so a fresh box hands a
    // television no config at all. The admin form has no field for that key either: the operator cannot fix
    // it from the screen that exists today. Whether 400 is the right answer, or a degraded config plus
    // `configNotice`, is the owner's call (the private plan of record D-T1-2); this test pins whichever way the code goes, and
    // today it says 400.
    const working = storeBytes();
    const shipped = JSON.parse(working);
    shipped.content = { ...shipped.content, sourceUrl: '' };
    writeFileSync(store, JSON.stringify(shipped, null, 2));

    const res = await fetch(`${base}/api/v2/config`);
    const body = await res.json();
    assert.equal(
        res.status,
        400,
        `an unconfigured install answered ${res.status} instead: ${JSON.stringify(body).slice(0, 300)}`
    );
    assert.equal(body.error, 'invalid-server-config');
    assert.match(
        String(body.reason),
        /missing-required:content\.sourceUrl/,
        `the 400 did not name the missing endpoint: ${JSON.stringify(body).slice(0, 300)}`
    );

    const screen = await configForm();
    assert.match(
        screen.html,
        /name="channelName"/,
        'the config screen could not be opened on an unconfigured install, so the operator cannot fix it there'
    );
    assert.ok(
        !/name="contentSourceUrl"/.test(screen.html),
        'the config screen now has a feed-URL field - update this check and the D-T1-2 note in the private plan of record'
    );

    writeFileSync(store, working);
    const recovered = await servedConfig();
    assert.equal(
        recovered.config.channel.name,
        'Refused Church',
        'the served config did not come back when the feed URL was set again'
    );
});

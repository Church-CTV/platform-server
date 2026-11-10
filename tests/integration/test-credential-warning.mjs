import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const require = createRequire(import.meta.url);

/**
 * The deployment that gates the operator pages must say, out loud, which credential it accepts.
 *
 * Measured on both production origins on 2026-11-10: `ADMIN_PASSWORD` is set in `.env` on each of them and
 * does **not** verify against the `.admin_password_hash` the cutover wrote. That is not a bug in
 * `loadPasswordHash()` - the hash file is meant to win - but it is a contradiction nobody reports, and the
 * next person to type the password in their `.env` will conclude the login is broken. This test pins both
 * halves: the process warns at boot, and the hash really is what logs somebody in.
 *
 * The hash file lives next to `lib/` (the tree root), not in cwd, so the test owns it for the duration and
 * restores or removes it exactly as it found it.
 */

const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HASH_FILE = path.join(TREE, '.admin_password_hash');
const BACKUP = HASH_FILE + '.credential-warning';
const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-credential-'));
const PORT = Number(process.env.CTV_CRED_WARNING_PORT || 3193);
const BASE = `http://127.0.0.1:${PORT}`;

const HASH_PASSWORD = 'ctv-warning-hash-side';
const ENV_PASSWORD = 'ctv-warning-env-side';

function post(pathname, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            `${BASE}${pathname}`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    'content-length': Buffer.byteLength(body)
                }
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

function waitForListening(child, output) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`server did not listen on ${PORT}: ${output.join('')}`)),
            25000
        );
        const probe = () => {
            const req = http.get(`${BASE}/admin/login`, (res) => {
                res.resume();
                clearTimeout(timer);
                resolve();
            });
            req.on('error', () => setTimeout(probe, 250));
            req.setTimeout(500, () => req.destroy());
        };
        probe();
    });
}

let hashExistedBefore = false;
let child = null;
// stdout and stderr both land here, under a name that says so: the exporter's own banner goes to stderr, and
// an earlier version pushed stdout into a variable called `stderr`, which made "not in the log" a smaller
// claim than it read like.
let output = [];
let started = false;

test('setup: a deployment whose two credential sources disagree', async () => {
    const adminAuth = require(TREE + '/lib/adminAuth');
    hashExistedBefore = fs.existsSync(HASH_FILE);
    if (hashExistedBefore) fs.copyFileSync(HASH_FILE, BACKUP);
    fs.writeFileSync(HASH_FILE, await adminAuth.hashPassword(HASH_PASSWORD), 'utf8');

    child = require('node:child_process').spawn(process.execPath, [path.join(TREE, 'server.js')], {
        cwd: TREE,
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: 'test',
            URL: `http://127.0.0.1:${PORT}`,
            SESSION_SECRET: 'ctv-credential-warning-secret',
            ADMIN_PASSWORD: ENV_PASSWORD,
            CTV_VIDEOS_DIR: TEST_DATA,
            DB_PATH: path.join(TEST_DATA, 'analytics.db'),
            CTV_CHANNEL_CONFIG: path.join(TEST_DATA, 'config.json'),
            CTV_AUDIT_DIR: path.join(TEST_DATA, 'audit')
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', (c) => output.push(String(c)));
    child.stdout.on('data', (c) => output.push(String(c)));
    await waitForListening(child, output);
    started = true;
});

test('the boot log names the contradiction and keeps the secret out of the log', async () => {
    assert.ok(started, 'server started');

    // A barrier, not an ordering accident. The first version of this test resolved `waitForListening` on the
    // first HTTP answer and then immediately grepped the pipe: it passed because `verifyPassword` is a
    // synchronous bcrypt compare that blocks the event loop until the warning is already in fd 2. Make
    // `compareSync` async - the obvious next edit - and the warning lands after the first response and the
    // test goes red for a reason unrelated to the rule. So: poll for the line, with a deadline.
    const deadline = Date.now() + 8000;
    let line;
    while (!line && Date.now() < deadline) {
        line = output
            .join('')
            .split('\n')
            .find((l) => /ADMIN_PASSWORD/i.test(l) && /admin_password_hash/.test(l));
        if (!line) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(line, `expected a warning naming both credential sources, got:\n${output.join('').slice(0, 2000)}`);
    assert.match(line, /uses the stored|stored hash/i);

    // "Never prints a secret" is about the whole capture, not just the matched line: the request logger, the
    // audit log and any future boot banner all live in these two streams.
    const everything = output.join('');
    for (const secret of [HASH_PASSWORD, ENV_PASSWORD]) {
        assert.ok(!line.includes(secret), 'the boot warning printed the password itself');
        assert.ok(!everything.includes(secret), 'something in the server output printed the password');
    }
});

test('the stored hash is what logs the operator in, and the .env value is history', async () => {
    const wrong = await post('/admin/login', `password=${encodeURIComponent(ENV_PASSWORD)}`);
    assert.ok(
        /Authentication failed|Invalid|error/i.test(wrong.body) || wrong.status !== 302,
        'the env password must not be accepted'
    );

    const right = await post('/admin/login', `password=${encodeURIComponent(HASH_PASSWORD)}`);
    assert.equal(right.status, 302, 'the password whose hash is stored must be accepted');
    assert.match(
        String(right.headers.location || ''),
        /\/$|\/admin/,
        'a successful login redirects into the operator surface'
    );
    const cookie = String((right.headers['set-cookie'] || [])[0] || '');
    assert.match(cookie, /sid=/, 'the session the login creates has to be sent back to the browser');
    assert.match(cookie, /httponly/i);
});

test('teardown and restore', () => {
    if (child) child.kill('SIGKILL');
    if (hashExistedBefore) {
        if (fs.existsSync(BACKUP)) fs.renameSync(BACKUP, HASH_FILE);
    } else if (fs.existsSync(HASH_FILE)) {
        fs.rmSync(HASH_FILE);
    }
    if (fs.existsSync(BACKUP)) fs.rmSync(BACKUP);
    fs.rmSync(TEST_DATA, { recursive: true, force: true });
});

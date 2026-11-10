import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const HASH_FILE = path.join(process.cwd(), '.admin_password_hash');
const BACKUP_HASH = HASH_FILE + '.backup';

function cleanupHash() {
    if (fs.existsSync(HASH_FILE)) {
        if (fs.existsSync(BACKUP_HASH)) fs.rmSync(BACKUP_HASH);
        fs.renameSync(HASH_FILE, BACKUP_HASH);
    }
}

function restoreHash() {
    if (fs.existsSync(BACKUP_HASH)) {
        fs.renameSync(BACKUP_HASH, HASH_FILE);
    } else if (fs.existsSync(HASH_FILE)) {
        fs.rmSync(HASH_FILE);
    }
}

describe('auth middleware', () => {
    let auth;

    before(() => {
        cleanupHash();
        // Set a known password for testing
        process.env.ADMIN_PASSWORD = 'test-password-123';
        delete require.cache[require.resolve('../../middleware/auth.js')];
        auth = require('../../middleware/auth.js');
    });

    after(() => {
        restoreHash();
        delete process.env.ADMIN_PASSWORD;
    });

    it('hashPassword creates a bcrypt hash', () => {
        const hash = auth.hashPassword('test-password');
        assert.ok(hash);
        assert.ok(hash.startsWith('$2'));
        assert.notStrictEqual(hash, 'test-password');
    });

    it('verifyPassword validates correct password', () => {
        const hash = auth.hashPassword('my-secret');
        assert.ok(auth.verifyPassword('my-secret', hash));
    });

    it('verifyPassword rejects wrong password', () => {
        const hash = auth.hashPassword('my-secret');
        assert.ok(!auth.verifyPassword('wrong-password', hash));
    });

    it('loadPasswordHash loads from env when file missing', () => {
        const hash = auth.loadPasswordHash();
        assert.ok(hash);
        assert.ok(hash.startsWith('$2'));
    });

    it('loadPasswordHash loads from file when it exists', () => {
        const hash1 = auth.loadPasswordHash();
        const hash2 = auth.loadPasswordHash();
        assert.strictEqual(hash1, hash2);
    });

    function createMockReq(session = {}, headers = {}) {
        return {
            session,
            headers,
            xhr: false
        };
    }

    function createMockRes() {
        const res = {
            statusCode: 200,
            redirectPath: null,
            jsonData: null,
            redirect(path) {
                this.redirectPath = path;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(data) {
                this.jsonData = data;
            }
        };
        return res;
    }

    it('requireAuth allows authenticated session', () => {
        let nextCalled = false;
        const req = createMockReq({ adminAuthenticated: true });
        const res = createMockRes();
        auth.requireAuth(req, res, () => {
            nextCalled = true;
        });
        assert.ok(nextCalled);
    });

    it('requireAuth redirects unauthed regular requests to login', () => {
        const req = createMockReq({});
        const res = createMockRes();
        auth.requireAuth(req, res, () => {});
        assert.strictEqual(res.redirectPath, '/admin/login');
    });

    it('requireAuth returns 401 for XHR unauthed requests', () => {
        const req = createMockReq({}, { accept: 'application/json' });
        req.xhr = true;
        const res = createMockRes();
        auth.requireAuth(req, res, () => {});
        assert.strictEqual(res.statusCode, 401);
        assert.ok(res.jsonData.error);
    });

    it('requireAuth returns 401 for JSON accept unauthed requests', () => {
        const req = createMockReq({}, { accept: 'application/json' });
        const res = createMockRes();
        auth.requireAuth(req, res, () => {});
        assert.strictEqual(res.statusCode, 401);
    });
});
describe('credentialStatus: which credential the deployment accepts, said out loud', () => {
    const adminAuth = require('../../lib/adminAuth.js');
    // Both production origins were found on 2026-11-10 with `ADMIN_PASSWORD` set in `.env` and a
    // `.admin_password_hash` written at the cutover that does not match it. The hash is meant to win; what
    // was missing was anybody saying so. These cases pin the four states the function can report.
    const HASH_FILE = path.join(process.cwd(), '.admin_password_hash');

    function withEnvPassword(value, fn) {
        const had = Object.prototype.hasOwnProperty.call(process.env, 'ADMIN_PASSWORD');
        const previous = process.env.ADMIN_PASSWORD;
        if (value === undefined) delete process.env.ADMIN_PASSWORD;
        else process.env.ADMIN_PASSWORD = value;
        return Promise.resolve()
            .then(fn)
            .finally(() => {
                if (had) process.env.ADMIN_PASSWORD = previous;
                else delete process.env.ADMIN_PASSWORD;
            });
    }

    function writeHash(password) {
        const hash = adminAuth.hashPassword(password);
        fs.writeFileSync(HASH_FILE, hash, 'utf8');
        return hash;
    }

    let existed = false;
    before(() => {
        existed = fs.existsSync(HASH_FILE);
        if (existed) fs.copyFileSync(HASH_FILE, HASH_FILE + '.status-probe');
    });
    after(() => {
        if (existed) fs.renameSync(HASH_FILE + '.status-probe', HASH_FILE);
        else if (fs.existsSync(HASH_FILE)) fs.rmSync(HASH_FILE);
    });

    it('names the stored hash as authoritative when both sources exist and disagree', async () => {
        writeHash('status-probe-hash-side');
        const status = await withEnvPassword('status-probe-env-side', () => adminAuth.credentialStatus());
        assert.equal(status.source, 'hash-file');
        assert.equal(status.hashFilePresent, true);
        assert.equal(status.envPasswordPresent, true);
        assert.equal(status.envMatchesStored, false);
        assert.ok(status.warning, 'a contradiction has to come with a sentence somebody can read');
        assert.ok(!status.warning.includes('status-probe-env-side'), 'the warning must not print the password');
    });

    it('reports agreement instead of contradiction when the .env value is the stored one', async () => {
        writeHash('status-probe-shared-value');
        const status = await withEnvPassword('status-probe-shared-value', () => adminAuth.credentialStatus());
        assert.equal(status.envMatchesStored, true);
        assert.equal(status.warning, null);
    });

    it('reports a deployment that has only the stored hash', async () => {
        writeHash('status-probe-hash-only');
        const status = await withEnvPassword(undefined, () => adminAuth.credentialStatus());
        assert.equal(status.source, 'hash-file');
        assert.equal(status.envPasswordPresent, false);
        assert.equal(status.envMatchesStored, null);
        assert.equal(status.warning, null);
    });

    it('says so when the hash file exists but holds no hash, which is the state where login accepts nobody', async () => {
        // Measured while reviewing this commit on 2026-11-10: an empty (or unreadable) `.admin_password_hash`
        // makes `loadPasswordHash()` return '' and therefore refuses every password - and the first version of
        // `credentialStatus()` reported `source: 'env'` with no warning in exactly that state, pointing the
        // operator at the wrong file.
        fs.writeFileSync(HASH_FILE, '   \n', 'utf8');
        const status = await withEnvPassword('status-probe-unusable-case', () => adminAuth.credentialStatus());
        assert.equal(status.hashFilePresent, true);
        assert.equal(status.hashFileUsable, false);
        assert.equal(status.source, 'hash-file');
        assert.equal(status.envMatchesStored, null);
        assert.ok(status.warning, 'a door that accepts nobody has to say so');
        assert.ok(!status.warning.includes('status-probe-unusable-case'), 'and without printing the password');
        // The consequence, from the function the login path actually uses, not from the report:
        assert.equal(adminAuth.loadPasswordHash(), '');
    });

    it('keeps one stable shape across every state, so a caller cannot guess its way past a problem', async () => {
        const keys = [
            'source',
            'hashFilePresent',
            'hashFileUsable',
            'envPasswordPresent',
            'envMatchesStored',
            'warning'
        ];
        writeHash('status-probe-shape-case');
        const s1 = await withEnvPassword('status-probe-shape-case', () => adminAuth.credentialStatus());
        if (fs.existsSync(HASH_FILE)) fs.rmSync(HASH_FILE);
        const s2 = await withEnvPassword('status-probe-shape-case', () => adminAuth.credentialStatus());
        for (const status of [s1, s2]) {
            assert.deepEqual(Object.keys(status).sort(), [...keys].sort());
        }
    });

    it('reports the environment when no hash file exists yet, which is what writes one on first login', async () => {
        if (fs.existsSync(HASH_FILE)) fs.rmSync(HASH_FILE);
        const status = await withEnvPassword('status-probe-env-only', () => adminAuth.credentialStatus());
        assert.equal(status.source, 'env');
        assert.equal(status.hashFilePresent, false);
        assert.equal(status.envPasswordPresent, true);
        assert.equal(status.warning, null);
    });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This file has been failing since 2026-11-06 and no npm script ran it, so nothing noticed: the `after` hook used
// the CommonJS `__dirname`, which an ESM module does not have (ReferenceError). Nothing in `package.json` names
// it either - `tests/unit/test-suite-coverage.mjs` now fails the gate if that happens again.

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

describe('admin auth', () => {
    let auth;
    // Nothing in this suite writes the hash file (ADMIN_PASSWORD is set in `before`, so `loadPasswordHash` reads
    // the environment). The flag exists so the `after` hook can never delete a file it did not create.
    const createdHashFile = false;

    before(() => {
        // Set up test password
        process.env.ADMIN_PASSWORD = 'testpass123';
        auth = require('../../middleware/auth.js');
    });

    it('hashes password correctly', () => {
        const hash = auth.hashPassword('testpass123');
        assert.ok(hash.length > 50);
        assert.ok(hash.startsWith('$2'));
    });

    it('verifies correct password', () => {
        const hash = auth.hashPassword('testpass123');
        assert.strictEqual(auth.verifyPassword('testpass123', hash), true);
    });

    it('rejects wrong password', () => {
        const hash = auth.hashPassword('testpass123');
        assert.strictEqual(auth.verifyPassword('wrongpass', hash), false);
    });

    it('loads password hash from file', () => {
        const hash = auth.loadPasswordHash();
        assert.ok(hash.length > 0);
    });

    after(() => {
        delete process.env.ADMIN_PASSWORD;
        const fs = require('fs-extra');
        const hashFile = path.join(here, '..', '..', '.admin_password_hash');
        // The old hook deleted this file unconditionally: wiring the file into the gate would have destroyed the
        // operator password of the checkout on every run. Deployment state is not a test fixture to clean up -
        // other suites (and the box) own it, and they copy it aside and put it back.
        if (createdHashFile && fs.existsSync(hashFile)) fs.removeSync(hashFile);
    });
});

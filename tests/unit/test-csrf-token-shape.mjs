/**
 * The CSRF comparison decoded more than it should (night of 2026-11-09)
 *
 * Found while testing `POST /admin/feed/regenerate` (`tests/integration/test-admin-feed-regenerate.mjs`): a
 * request carrying the session's real token with one extra character appended - `<64 hex>x` - was **accepted**,
 * redirected to `/admin/feed` and ran the handler. The reason is in `lib/adminAuth.js:159-163`:
 *
 *     return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
 *
 * `Buffer.from(x, 'hex')` stops at the first character that is not hex and does not report that it stopped, so
 * `<token>x` decodes to exactly the expected 32 bytes. And when the two buffers differ in length,
 * `timingSafeEqual` **throws** a RangeError rather than returning false: a truncated or odd-length token turns a
 * refusal into a 500 on every state-changing admin route (`tests/integration/test-admin-upload.mjs` never hit it
 * because it omits the field entirely, which takes the `!csrfToken` branch).
 *
 * Severity is honest: exploiting the accepted-prefix behaviour still requires knowing the real token, so this is
 * not a bypass an off-site attacker can use. It is a security check that fails open on malformed input and can
 * answer 500 instead of 403 - the opposite of the fail-closed rail this project runs on.
 *
 * Mutation check (each applied to `lib/adminAuth.js`, run, then restored byte-exactly; control marker
 * `NO-IDENTICAL` when the anchor is absent):
 *   - C1 drop the hex-shape guard: CAUGHT (the empty-token wildcard case fails)
 *   - C2 drop the length guard: CAUGHT (the odd-length case raises RangeError again)
 *   - C3 replace `timingSafeEqual` with `token === expected`: **NOT CAUGHT, honestly** - constant-time-ness is
 *     not observable from a unit test, and this file does not pretend to prove it
 *   - control: anchor absent -> NO-IDENTICAL
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const adminAuth = require(path.join(root, 'lib/adminAuth.js'));

const expected = crypto.randomBytes(32).toString('hex');

test('a real token still validates - nothing here loosens the check', () => {
    assert.equal(adminAuth.validateCsrfToken(expected, expected), true);
});

test('a token with trailing junk is refused, not silently truncated to the real one', () => {
    assert.equal(
        adminAuth.validateCsrfToken(`${expected}x`, expected),
        false,
        'Buffer.from(x, "hex") stopped at the non-hex character and the comparison saw identical bytes'
    );
});

test('a non-hex token of any shape is refused', () => {
    for (const junk of ['zzzz', 'not-a-token', expected.slice(0, 32) + 'not-hex', '  ' + expected]) {
        assert.equal(adminAuth.validateCsrfToken(junk, expected), false, `${JSON.stringify(junk)} was accepted`);
    }
});

test('a shorter or odd-length token is refused, and does not throw', () => {
    for (const short of [expected.slice(0, 63), expected.slice(0, 8), 'deadbeef', '']) {
        let value;
        let thrown = null;
        try {
            value = adminAuth.validateCsrfToken(short, expected);
        } catch (err) {
            thrown = err;
        }
        assert.equal(
            thrown,
            null,
            `a malformed token raised ${thrown && thrown.constructor.name}: ${thrown && thrown.message} - a refusal became a 500`
        );
        assert.equal(value, false, `${JSON.stringify(short)} was accepted`);
    }
});

test('a different token of the same shape is refused', () => {
    const other = crypto.randomBytes(32).toString('hex');
    assert.equal(adminAuth.validateCsrfToken(other, expected), false);
    // One character different, which is the case a non-constant-time compare would leak.
    const nearMiss = expected.slice(0, -1) + (expected.endsWith('a') ? 'b' : 'a');
    assert.equal(adminAuth.validateCsrfToken(nearMiss, expected), false);
});

test('a missing expected token is refused rather than treated as a wildcard', () => {
    assert.equal(adminAuth.validateCsrfToken(expected, undefined), false);
    assert.equal(adminAuth.validateCsrfToken(undefined, expected), false);
    assert.equal(adminAuth.validateCsrfToken('', ''), false);
});

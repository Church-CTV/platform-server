/**
 * The upload screen promised 2 GB; the server refuses 500 MB (night of 2026-11-09)
 *
 * `views/admin/upload.ejs:15` renders `Supported formats: MP4, MOV, AVI, MKV. Max size: 2GB.` while
 * `routes/admin.js:57` sets `limits: { fileSize: 500 * 1024 * 1024 }` with the comment "500MB max (was 2GB - DoS
 * risk)". So the page tells an operator to do the one thing the server will refuse, and the number on the page is
 * the number that was deliberately lowered. Nothing connects the two: the limit is not in the config schema, not in
 * an environment key, and not passed to the view.
 *
 * And when the limit is hit, there is no error surface at all: only `routes/v2.js` has an error middleware, so a
 * Multer `LIMIT_FILE_SIZE` on the admin path falls through to Express's default handler - a 500 with a stack,
 * instead of a sentence naming the limit the operator just exceeded.
 *
 * One source, stated in the page, enforced by the server: `lib/uploadLimits.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const limits = require(path.join(root, 'lib/uploadLimits.js'));

// The warnings are read from a real subprocess, not by patching `console.warn`: the node test runner intercepts
// console calls inside a test, so patching it here would prove nothing about the shipped module.
function warnFor(envName, value) {
    const child = spawnSync(
        process.execPath,
        ['-e', `const m = require(${JSON.stringify(path.join(root, 'lib/uploadLimits.js'))}); m.videoMaxBytes();`],
        {
            encoding: 'utf8',
            env: { ...process.env, [envName]: value }
        }
    );
    return String(child.stderr || '');
}

test('the shipped defaults are the ones the server enforces today', () => {
    delete process.env.CTV_MAX_VIDEO_BYTES;
    delete process.env.CTV_MAX_THUMBNAIL_BYTES;
    assert.equal(limits.videoMaxBytes(), 500 * 1024 * 1024);
    assert.equal(limits.thumbnailMaxBytes(), 2 * 1024 * 1024);
    const clean = spawnSync(
        process.execPath,
        [
            '-e',
            'const m = require(' +
                JSON.stringify(path.join(root, 'lib/uploadLimits.js')) +
                '); process.stdout.write(String(m.videoMaxBytes()));'
        ],
        { encoding: 'utf8', env: { ...process.env, CTV_MAX_VIDEO_BYTES: '' } }
    );
    assert.equal(
        clean.stdout.trim(),
        String(500 * 1024 * 1024),
        'a real process did not fall back to the shipped ceiling'
    );
});

test('a configured limit is honoured, in bytes', () => {
    try {
        process.env.CTV_MAX_VIDEO_BYTES = '4096';
        process.env.CTV_MAX_THUMBNAIL_BYTES = '65536';
        assert.equal(limits.videoMaxBytes(), 4096);
        assert.equal(limits.thumbnailMaxBytes(), 65536);
    } finally {
        delete process.env.CTV_MAX_VIDEO_BYTES;
        delete process.env.CTV_MAX_THUMBNAIL_BYTES;
    }
});

test('a limit that is not a positive integer falls back to the shipped default and says so', () => {
    for (const bad of ['0', '-1', 'abc', '500MB', '1e999999', ' ', 'Infinity', 'NaN']) {
        process.env.CTV_MAX_VIDEO_BYTES = bad;
        assert.equal(
            limits.videoMaxBytes(),
            500 * 1024 * 1024,
            `CTV_MAX_VIDEO_BYTES="${bad}" was taken at face value - a typo must not open the limit`
        );
        const stderr = warnFor('CTV_MAX_VIDEO_BYTES', bad);
        assert.match(
            stderr,
            /CTV_MAX_VIDEO_BYTES/,
            `a real process stayed quiet about CTV_MAX_VIDEO_BYTES="${bad}" (stderr: ${JSON.stringify(stderr.slice(0, 200))})`
        );
    }
    delete process.env.CTV_MAX_VIDEO_BYTES;
});

test('the number an operator reads is the number the server enforces', () => {
    try {
        process.env.CTV_MAX_VIDEO_BYTES = '4096';
        assert.equal(limits.humanBytes(limits.videoMaxBytes()), '4 KB');
        delete process.env.CTV_MAX_VIDEO_BYTES;
        assert.equal(limits.humanBytes(limits.videoMaxBytes()), '500 MB');
        assert.equal(limits.humanBytes(limits.thumbnailMaxBytes()), '2 MB');
        assert.equal(limits.humanBytes(1536), '1.5 KB');
    } finally {
        delete process.env.CTV_MAX_VIDEO_BYTES;
    }
});

test('the upload screen no longer carries a limit of its own', () => {
    const view = readFileSync(path.join(root, 'views', 'admin', 'upload.ejs'), 'utf8');
    const hardCoded = /Max size:\s*[0-9.]+\s*(GB|MB|KB)/i.exec(view);
    assert.equal(
        hardCoded,
        null,
        `the page states a limit by itself (${hardCoded && hardCoded[0]}) instead of the configured one - this is the sentence that told operators 2 GB while the server refused 500 MB`
    );
    assert.match(view, /uploadLimits|videoMaxBytes/, 'the upload page does not name the limit it got from the server');
});

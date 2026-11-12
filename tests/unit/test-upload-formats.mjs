/**
 * Every container the upload page advertises has to survive the server's own content check (2026-11-09)
 *
 * Measured before any of this existed, with the `file-type` this checkout installs (22.0.1) and files this host's
 * ffmpeg wrote: `out.avi` detects as `video/vnd.avi` and `real.mkv` as `video/matroska`, while the shipping allowlist
 * in `routes/admin.js:99` listed only the detector's legacy names (`video/x-msvideo`, `video/x-matroska`). The page
 * advertised "MP4, MOV, AVI, MKV", the extension filter admitted all four, and the content check then refused two of
 * them after the whole body had been uploaded.
 *
 * So each advertised extension gets a real file, and the real file goes through the shipping content check. A
 * hand-written header is not enough: `file-type` keys on container structure, and a synthetic EBML prefix was
 * undetected in this investigation, which would have made a green test out of a broken path.
 *
 * Not claimed here: whether a Roku or a Fire TV can *play* these containers. Nothing in this server checks
 * playability, and no device was involved in this measurement - that question is recorded NOT RUN in
 * certificate (the private record t8-admin-groundwork-2026-11-08 §25 in the ctv project).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const adminRoutes = require(path.join(root, 'routes/admin.js'));
const uploadFormats = require(path.join(root, 'lib/uploadFormats.js'));
const { inspectUpload } = adminRoutes.__internals || {};

const dir = mkdtempSync(path.join(tmpdir(), 'ctv-formats-'));

// ffmpeg's own names for these containers differ from the file extensions again (`-f matroska` writes .mkv);
// this host also has no `mkv` output format alias, which is how the first attempt at this fixture failed.
const FORMATS = [
    { ext: '.mp4', ffmpeg: 'mp4' },
    { ext: '.mov', ffmpeg: 'mov' },
    { ext: '.avi', ffmpeg: 'avi' },
    { ext: '.mkv', ffmpeg: 'matroska' }
];

function encode(entry) {
    const file = path.join(dir, `sample${entry.ext}`);
    execFileSync(
        'ffmpeg',
        [
            '-y',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=duration=1:size=160x120:rate=5',
            '-pix_fmt',
            'yuv420p',
            '-f',
            entry.ffmpeg,
            file
        ],
        { stdio: 'pipe' }
    );
    assert.ok(existsSync(file) && readFileSync(file).length > 64, `ffmpeg produced no real ${entry.ext} fixture`);
    return file;
}

test('the content check is reachable without an HTTP server', () => {
    assert.equal(typeof inspectUpload, 'function', 'inspectUpload is not exported for testing');
});

test('the advertised set is the one the filter admits - pinned, so a silent narrowing is visible', () => {
    assert.deepEqual(uploadFormats.videoExtensions(), ['.mp4', '.mov', '.avi', '.mkv']);
    assert.equal(uploadFormats.advertisedExtensions(uploadFormats.videoExtensions()), 'MP4, MOV, AVI, MKV');
    assert.equal(uploadFormats.advertisedExtensions(uploadFormats.imageExtensions()), 'JPG, JPEG, PNG');
});

for (const entry of FORMATS) {
    test(`an operator's ${entry.ext} passes the server's own content check`, async () => {
        const file = encode(entry);
        const verdict = await inspectUpload(file, 'video');
        assert.ok(
            verdict.ok,
            `${entry.ext} was refused by the shipping content check: ${verdict.reason || verdict.message} - the page advertises it and the extension filter admits it`
        );
    });
}

test('a video-shaped name around image bytes is refused, and names what it found', async () => {
    const file = path.join(dir, 'disguised.mp4');
    writeFileSync(
        file,
        Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
            'base64'
        )
    );
    const verdict = await inspectUpload(file, 'video');
    assert.equal(verdict.ok, false, 'image bytes inside .mp4 passed the video content check');
    assert.equal(
        verdict.reason,
        'content-not-allowed:image/png',
        `the reason is not a code a consumer can match: ${verdict.reason}`
    );
    assert.equal(verdict.detectedMime, 'image/png');
    assert.ok(
        Array.isArray(verdict.allowedMimes) && verdict.allowedMimes.includes('video/mp4'),
        'the refusal did not say what it accepts'
    );
    assert.match(verdict.message, /image\/png/, 'the operator-facing message did not name the mime it detected');
});

test('a real JPG and PNG pass the image content check', async () => {
    const png = path.join(dir, 'real.png');
    writeFileSync(
        png,
        Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
            'base64'
        )
    );
    const jpg = path.join(dir, 'real.jpg');
    execFileSync(
        'ffmpeg',
        [
            '-y',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=duration=1:size=64x64:rate=1',
            '-frames:v',
            '1',
            jpg
        ],
        { stdio: 'pipe' }
    );
    for (const file of [png, jpg]) {
        const verdict = await inspectUpload(file, 'image');
        assert.ok(
            verdict.ok,
            `${path.basename(file)} failed the image content check: ${verdict.reason || verdict.message}`
        );
    }
});

test('the upload page gets its format sentence from the server, not from itself', () => {
    const view = readFileSync(path.join(root, 'views', 'admin', 'upload.ejs'), 'utf8');
    // `[A-Z0-9]`, not `[A-Z]`: "MP4" has a digit, and the first version of this pattern used letters only -
    // which let a hardcoded "MP4, MOV, AVI, MKV." back into the page and the mutant went green.
    const hardcoded = /Supported formats:\s*[A-Z0-9]{3,4}(,\s*[A-Z0-9]{3,4})+/i.exec(view);
    assert.equal(
        hardcoded,
        null,
        `the page lists formats itself (${hardcoded && hardcoded[0]}) instead of rendering the declared set`
    );
    const route = readFileSync(path.join(root, 'routes', 'admin.js'), 'utf8');
    assert.match(
        route,
        /uploadFormats:\s*\{\s*videoHuman:/,
        'the upload route does not pass the declared set to the view'
    );
});

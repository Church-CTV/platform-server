/**
 * Where does thumbnail art get written, and whose art directory is that? (night of 2026-11-09)
 *
 * The reader and the writer disagree. `server.js:272-276` serves `/output/thumbnails` from
 * `contentRoot.outputDir()/thumbnails`, which follows `CTV_FEED_OUTPUT_DIR` - and `lib/serverProfile.js:89` sets
 * that variable per channel profile, which is how a second organisation gets its own roots. The writer,
 * `lib/thumbnailManager.js:8-9`, hardcodes two repository paths at require time:
 *
 *     const AUTO_THUMBS_DIR = path.join(__dirname, '..', 'output', 'thumbnails');
 *     const UPLOAD_THUMBS_DIR = path.join(__dirname, '..', 'uploads', 'thumbnails');
 *
 * So art generated or uploaded for profile B lands in the repository's art directory: invisible to profile B's
 * mount, and served to whoever reads that directory. That is the Tier-2 rule failing quietly - a per-organisation
 * view sharing one writable art drawer.
 *
 * It is also why the published art directory of this checkout is full of test fixtures right now. Measured at
 * 22:25 with `ls output/thumbnails`: `Contract Sermon One.jpg`, `Contract Sermon One October 4 2026.jpg`,
 * `Contract Sermon Two.jpg`, `Contract Sermon Two November 1 2026.jpg`, `Envelope Sermon November 1 2026.jpg`,
 * `test-ci.jpg`, `test-regen.jpg`, `morning-talk.mp4.jpg`, `ctv-stage-check.jpg` - names that come from test
 * fixtures, written by test runs (`git ls-files output` tracks none of it).
 *
 * These checks put every thumbnail operation in a temp world and require the repository directories to come out
 * of the run exactly as they went in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);

const REPO_AUTO = path.join(repo, 'output', 'thumbnails');
const REPO_UPLOAD = path.join(repo, 'uploads', 'thumbnails');

function listing(dir) {
    if (!existsSync(dir)) return '<absent>';
    return readdirSync(dir)
        .sort()
        .map((name) => `${name}:${readFileSync(path.join(dir, name)).length}`)
        .join('|');
}

function world() {
    const dir = mkdtempSync(path.join(tmpdir(), 'ctv-thumbs-'));
    const videos = path.join(dir, 'Videos');
    const output = path.join(dir, 'output');
    const uploads = path.join(dir, 'uploads');
    mkdirSync(videos, { recursive: true });
    mkdirSync(output, { recursive: true });
    mkdirSync(uploads, { recursive: true });

    // A real two-second video: an auto thumbnail is an ffmpeg frame grab, so a stub file would make the
    // assertion about the output directory meaningless.
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
            path.join(videos, 'thumb-target.mp4')
        ],
        {
            stdio: 'pipe'
        }
    );

    process.env.CTV_VIDEOS_DIR = videos;
    process.env.CTV_FEED_OUTPUT_DIR = output;
    process.env.CTV_VIDEOS_METADATA = path.join(dir, 'videos.json');
    process.env.CTV_UPLOADS_DIR = uploads;
    return { dir, videos, output, uploads };
}

// The manager resolves its directories at require time today, so the cache entry is dropped and the module is
// re-required with the temp environment in place.
function freshManager() {
    const resolved = require.resolve(path.join(repo, 'lib', 'thumbnailManager.js'));
    delete require.cache[resolved];
    return require(resolved);
}

test('the auto-thumbnail directory follows the configured output root, not the repository', async () => {
    const { dir, output } = world();
    const beforeAuto = listing(REPO_AUTO);
    const beforeUpload = listing(REPO_UPLOAD);
    try {
        const { regenerateThumbnail } = freshManager();
        const url = await regenerateThumbnail('thumb-target.mp4');
        const generated = path.join(output, 'thumbnails', 'thumb-target.jpg');
        assert.ok(
            existsSync(generated),
            `the generated frame is not where the /output/thumbnails mount reads it (${url}, expected ${generated})`
        );
        assert.match(url, /^\/output\/thumbnails\/thumb-target\.jpg$/, `unexpected url shape ${url}`);
        assert.equal(listing(REPO_AUTO), beforeAuto, 'the repository art directory changed during the run');
        assert.equal(listing(REPO_UPLOAD), beforeUpload, 'the repository uploads directory changed during the run');
        assert.ok(existsSync(path.join(dir, 'videos.json')), 'the metadata store override was not used');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an uploaded thumbnail follows the configured uploads root', async () => {
    const { dir, uploads } = world();
    const beforeUpload = listing(REPO_UPLOAD);
    try {
        const { uploadThumbnail, getThumbnailPath } = freshManager();
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
            'base64'
        );
        const url = await uploadThumbnail('thumb-target.mp4', png, 'image/png');
        const stored = path.join(uploads, 'thumbnails', 'thumb-target.png');
        assert.ok(
            existsSync(stored),
            `the uploaded thumbnail is not under the configured uploads root (${url}, expected ${stored})`
        );
        assert.equal(url, '/uploads/thumbnails/thumb-target.png');
        assert.equal(listing(REPO_UPLOAD), beforeUpload, 'the repository uploads directory changed during the run');
        const readBack = await getThumbnailPath('thumb-target.mp4');
        assert.equal(readBack, url, 'the metadata URL does not round-trip through the same roots');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('deleteThumbnail deletes what the configured roots hold, and nothing else', async () => {
    const { dir, uploads, output } = world();
    const beforeAuto = listing(REPO_AUTO);
    const beforeUpload = listing(REPO_UPLOAD);
    try {
        const { uploadThumbnail, deleteThumbnail } = freshManager();
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
            'base64'
        );
        await uploadThumbnail('thumb-target.mp4', png, 'image/png');
        mkdirSync(path.join(output, 'thumbnails'), { recursive: true });
        writeFileSync(path.join(output, 'thumbnails', 'thumb-target.jpg'), 'auto frame');
        assert.ok(existsSync(path.join(uploads, 'thumbnails', 'thumb-target.png')));
        await deleteThumbnail('thumb-target.mp4');
        assert.ok(
            !existsSync(path.join(uploads, 'thumbnails', 'thumb-target.png')),
            'the uploaded thumbnail survived deletion in the configured root'
        );
        assert.ok(
            !existsSync(path.join(output, 'thumbnails', 'thumb-target.jpg')),
            'the auto thumbnail survived deletion in the configured root'
        );
        assert.equal(listing(REPO_AUTO), beforeAuto, 'deleteThumbnail touched the repository art directory');
        assert.equal(listing(REPO_UPLOAD), beforeUpload, 'deleteThumbnail touched the repository uploads directory');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the temp world really was used - this suite cannot pass by touching nothing', async () => {
    const { dir, output, uploads } = world();
    try {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
            'base64'
        );
        const { uploadThumbnail, generateAutoThumbnail } = freshManager();
        await Promise.all([
            uploadThumbnail('thumb-target.mp4', png, 'image/png'),
            generateAutoThumbnail(path.join(dir, 'Videos', 'thumb-target.mp4'), 'thumb-target')
        ]);
        assert.ok(
            readdirSync(path.join(uploads, 'thumbnails')).length > 0,
            'nothing was written under the temp uploads root'
        );
        assert.ok(
            readdirSync(path.join(output, 'thumbnails')).length > 0,
            'nothing was written under the temp output root'
        );
        assert.ok(
            existsSync(path.join(output, 'thumbnails', 'thumb-target.jpg')),
            'the auto frame did not land in the temp output root'
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

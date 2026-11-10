import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
test('one server profile selects isolated channel roots without changing defaults or credentials', () => {
    assert.ok(existsSync(new URL('../../lib/serverProfile.js', import.meta.url)), 'missing server profile resolver');
    const { resolveProfile } = require('../../lib/serverProfile');
    const temp = mkdtempSync(path.join(tmpdir(), 'ctv-server-profile-'));
    try {
        mkdirSync(path.join(temp, 'media'));
        mkdirSync(path.join(temp, 'images'));
        writeFileSync(path.join(temp, 'feed.json'), '{}');
        const profile = {
            version: 1,
            environment: 'stage',
            publicOrigin: 'http://127.0.0.1:3105',
            port: 3105,
            contentRoot: 'media',
            feedPath: 'feed.json',
            imagesDir: 'images',
            dbPath: 'analytics.db'
        };
        const result = resolveProfile(profile, temp);
        assert.equal(result.PORT, '3105');
        assert.equal(result.CTV_VIDEOS_DIR, path.join(temp, 'media'));
        assert.equal(result.CTV_V2_FEED_PATH, path.join(temp, 'feed.json'));
        assert.equal(result.ADMIN_PASSWORD, undefined);
        assert.equal(result.STRIKESAFE, 'false');
        assert.throws(() => resolveProfile({ ...profile, port: 0 }, temp), /invalid-server-profile/);
        assert.throws(() => resolveProfile({ ...profile, unknown: true }, temp), /invalid-server-profile/);
        assert.throws(() => resolveProfile({ ...profile, contentRoot: 'missing' }, temp), /missing-profile-input/);
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
});
test('a profile may name the video metadata file, and it becomes the environment the generator reads', () => {
    const { resolveProfile } = require('../../lib/serverProfile');
    // Measured on both production origins on 2026-11-10 while trying to republish: the profile names the
    // content root, the feed file, the images directory, the output directory and the database, but the
    // generator's metadata file (`lib/contentRoot.js:metadataPath`) still resolved next to the code. On example channel
    // the real `videos.json` is 1,293,358 B in the old tree while the deployed repository holds a 311 B
    // stub, so `regenerateFeed()` answered "Missing or invalid release date" for all 524 files - that is the
    // operator's regenerate button failing, not a corner of a script.
    const temp = mkdtempSync(path.join(tmpdir(), 'ctv-profile-meta-'));
    try {
        mkdirSync(path.join(temp, 'media'));
        writeFileSync(path.join(temp, 'feed.json'), '{}');
        writeFileSync(path.join(temp, 'videos.json'), '{}');
        const resolved = resolveProfile(
            {
                version: 1,
                environment: 'stage',
                publicOrigin: 'http://127.0.0.1:3011',
                port: 3011,
                contentRoot: 'media',
                feedPath: 'feed.json',
                imagesDir: 'media',
                dbPath: 'analytics.db',
                videosMetadata: 'videos.json'
            },
            temp
        );
        assert.equal(resolved.CTV_VIDEOS_METADATA, path.join(temp, 'videos.json'));
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
});

test('a profile that does not name the metadata file leaves the legacy behaviour alone', () => {
    const { resolveProfile } = require('../../lib/serverProfile');
    // Defaults must not move under an existing deployment: with no `videosMetadata`, `metadataPath()` keeps
    // resolving to `<repository>/videos.json`, exactly as it did before the field existed.
    const temp = mkdtempSync(path.join(tmpdir(), 'ctv-profile-nometa-'));
    try {
        mkdirSync(path.join(temp, 'media'));
        writeFileSync(path.join(temp, 'feed.json'), '{}');
        const resolved = resolveProfile(
            {
                version: 1,
                environment: 'stage',
                publicOrigin: 'http://127.0.0.1:3012',
                port: 3012,
                contentRoot: 'media',
                feedPath: 'feed.json',
                imagesDir: 'media',
                dbPath: 'analytics.db'
            },
            temp
        );
        assert.equal('CTV_VIDEOS_METADATA' in resolved, false);
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
});

test('a metadata file that is absent is allowed (the first generation writes it); a directory is refused', () => {
    const { resolveProfile } = require('../../lib/serverProfile');
    const temp = mkdtempSync(path.join(tmpdir(), 'ctv-profile-metadir-'));
    const base = {
        version: 1,
        environment: 'stage',
        publicOrigin: 'http://127.0.0.1:3013',
        contentRoot: 'media',
        feedPath: 'feed.json',
        imagesDir: 'media',
        dbPath: 'analytics.db'
    };
    try {
        mkdirSync(path.join(temp, 'media'));
        writeFileSync(path.join(temp, 'feed.json'), '{}');
        // Absent is legitimate: a new organisation has no metadata until the first generation writes it.
        const fresh = resolveProfile({ ...base, port: 3013, videosMetadata: 'videos.json' }, temp);
        assert.equal(fresh.CTV_VIDEOS_METADATA, path.join(temp, 'videos.json'));

        // A directory at that path is a typo, and the generator would fail later with a confusing error.
        mkdirSync(path.join(temp, 'videos.json'));
        assert.throws(
            () => resolveProfile({ ...base, port: 3013, videosMetadata: 'videos.json' }, temp),
            /missing-profile-input:videosMetadata|invalid-server-profile/
        );
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
});

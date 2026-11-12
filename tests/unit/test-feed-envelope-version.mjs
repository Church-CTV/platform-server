/**
 * The frozen feed envelope needs a version, and the producer could not emit one.
 *
 * GATE T1's `feed-v1.md` requires a top-level `feedVersion: "1"`, and the owner-facing packet
 * (`config-v1.md` D-T1-5, the private record t1-decision-sheet-2026-11-09) says the order is emit first, enforce
 * later, because a published Roku client collects only ARRAY-valued top-level keys as month rows
 * (`work/roku-channel-template/components/tasks/MainLoaderTask.brs:313-317`; the shipped Example app is
 * looser still at `:235-239`), so an additive string key is safe on the wire. Measured 2026-11-09 while
 * writing this file: the producer could not emit it. `lib/feedValidator.js` listed five envelope keys and
 * refused every other NON-ARRAY top-level key with `Month key "feedVersion" must contain an array of
 * videos`, and `publishFeed` throws when validation fails - so the shipping validator blocked the frozen
 * format, and would block every future additive envelope key the same way.
 *
 * What this pins: the version key is known and emitted; an ARRAY-valued version stamp is still refused
 * (that is the phantom-row case the client rule exists for); and an unknown non-array key is still
 * refused, so widening the list stays a decision rather than a loophole.
 *
 * Isolated: its own Videos / metadata / output under a temp directory (repository rule: isolated fixtures
 * for anything that writes feed, metadata or video files).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const TEMP = mkdtempSync(path.join(tmpdir(), 'ctv-feed-envelope-'));
const VIDEOS_A = path.join(TEMP, 'validatorVideos'); // for the envelope cases: existence is all the gate checks
const VIDEOS_B = path.join(TEMP, 'producerVideos'); // for the producer case: a real encoded sermon
const OUTPUT_DIR = path.join(TEMP, 'output');
const OVERRIDES = {
    CTV_VIDEOS_DIR: VIDEOS_A,
    CTV_VIDEOS_METADATA: path.join(TEMP, 'videos.json'),
    CTV_FEED_OUTPUT_DIR: OUTPUT_DIR,
    CTV_IMAGES_DIR: VIDEOS_A,
    CTV_CHANNEL_CONFIG: path.join(REPO, 'config.template.json')
};
const SAVED_ENV = Object.fromEntries(Object.keys(OVERRIDES).map((k) => [k, process.env[k]]));
mkdirSync(VIDEOS_A, { recursive: true });
mkdirSync(VIDEOS_B, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });
// The shipping validator checks the media behind an item exists; for the envelope cases a stub is the
// honest fixture, and the producer suite below encodes a real video in its own directory.
writeFileSync(path.join(VIDEOS_A, 'env.mp4'), 'stub-media-bytes');
for (const [k, v] of Object.entries(OVERRIDES)) process.env[k] = v;

function useVideosDir(dir) {
    process.env.CTV_VIDEOS_DIR = dir;
    process.env.CTV_IMAGES_DIR = dir;
}

const { validateFeed } = require('../../lib/feedValidator.js');

function envelope(extra = {}) {
    return {
        providerName: 'Envelope Church',
        lastUpdated: '2026-11-09T00:00:00.000Z',
        language: 'en',
        'November 2026': [
            {
                id: 'env-1',
                title: 'One sermon',
                shortDescription: '',
                thumbnail: 'output/thumbnails/env.png',
                releaseDate: '2026-11-01',
                genres: ['Religious'],
                content: { duration: 60, videos: [{ url: '/stream/env.mp4', quality: 'HD', videoType: 'MP4' }] }
            }
        ],
        ...extra
    };
}

after(() => {
    for (const [k, v] of Object.entries(SAVED_ENV)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    rmSync(TEMP, { recursive: true, force: true });
});

describe('feed envelope version - the validator half', () => {
    before(() => useVideosDir(VIDEOS_A));

    it('the baseline envelope without a version still validates (this change is additive)', () => {
        const res = validateFeed(envelope());
        assert.deepEqual(res.errors, [], res.errors.join('; '));
    });

    it('a top-level feedVersion is accepted, not mistaken for a month row', () => {
        const res = validateFeed(envelope({ feedVersion: '1' }));
        assert.deepEqual(res.errors, [], res.errors.join('; '));
    });

    it('an ARRAY-valued feedVersion is refused as an envelope defect, not mistaken for a month row', () => {
        const res = validateFeed(envelope({ feedVersion: ['1'] }));
        assert.ok(
            res.errors.some((e) => /feedVersion must be a non-empty string/.test(e)),
            `expected an envelope-level refusal, got: ${res.errors.join('; ')}`
        );
    });

    it('an empty feedVersion is refused', () => {
        const res = validateFeed(envelope({ feedVersion: '' }));
        assert.ok(
            res.errors.some((e) => e.includes('feedVersion')),
            res.errors.join('; ')
        );
    });

    it('an unknown non-array key is still refused - the envelope list is a decision, not a loophole', () => {
        const res = validateFeed(envelope({ promoBlock: 'soon' }));
        assert.ok(
            res.errors.some((e) => e.includes('promoBlock')),
            `unknown scalar key slipped through: ${res.errors.join('; ')}`
        );
    });
});

describe('feed envelope version - the producer half', () => {
    let feed;

    before(async () => {
        useVideosDir(VIDEOS_B);
        execSync(
            `ffmpeg -f lavfi -i color=c=black:s=320x240:d=2 -c:v libx264 -pix_fmt yuv420p -y "${path.join(VIDEOS_B, 'Envelope Sermon November 1, 2026.mp4')}"`,
            { stdio: 'pipe' }
        );
        const { generateFeed } = require('../../lib/feedGenerator.js');
        feed = await generateFeed({ baseUrl: 'http://127.0.0.1:9' });
    });

    it('the generated feed carries the frozen envelope version as a string', () => {
        assert.ok(feed, 'generateFeed returned nothing');
        assert.equal(
            feed.feedVersion,
            '1',
            `top-level feedVersion is ${JSON.stringify(feed.feedVersion)}, expected "1"`
        );
    });

    it('the version key is not array-valued, which is the rule a published client actually enforces', () => {
        assert.ok(
            !Array.isArray(feed.feedVersion),
            'an array-valued top-level key becomes a phantom month row on a Roku'
        );
    });

    it('the generated feed still validates through the shipping gate', () => {
        const res = validateFeed(feed);
        assert.deepEqual(res.errors, [], res.errors.join('; '));
    });

    it('the temp world was really used, and the repository Videos directory was not', () => {
        assert.ok(
            existsSync(path.join(VIDEOS_B, 'Envelope Sermon November 1, 2026.mp4')),
            'the fixture video is not in the temp world'
        );
        assert.ok(
            !existsSync(path.join(REPO, 'Videos', 'Envelope Sermon November 1, 2026.mp4')),
            'the producer wrote into the repository Videos directory'
        );
    });
});

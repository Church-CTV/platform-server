import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateFeed, validateFeedConfig, validateCardStyle } = require('../../lib/feedValidator.js');

describe('feedValidator', () => {
    it('rejects null feed', () => {
        const result = validateFeed(null);
        assert.ok(!result.valid);
        assert.ok(result.errors.length > 0);
    });

    it('requires providerName', () => {
        const result = validateFeed({});
        assert.ok(!result.valid);
        assert.ok(result.errors.some((e) => e.includes('providerName')));
    });

    it('catches missing video URL', () => {
        const feed = {
            providerName: 'Test',
            'June 2025': [
                {
                    title: 'No URL',
                    thumbnail: 'http://example.com/t.jpg',
                    releaseDate: '2025-06-01',
                    content: { duration: 100, videos: [] }
                }
            ]
        };
        const result = validateFeed(feed);
        assert.ok(!result.valid);
    });

    it('names a config version as a scalar, not as a month row, and refuses one that is not a digest', () => {
        // Three places decide which top-level keys are scalars rather than month rows - this validator, the
        // Python publish audit, and the Roku client's own collect-array-values rule. The generator now stamps
        // `configVersion` (`CACHE-11`), so every one of them has to know the key exists; the Python side went
        // red on `feedVersion` first and a test in `tests/python/test_example-channel_feed_audit.py` holds it.
        const base = {
            providerName: 'Test',
            'June 2025': [
                {
                    title: 'Ok',
                    thumbnail: 'http://example.com/t.jpg',
                    releaseDate: '2025-06-01',
                    content: { duration: 100, videos: [{ url: 'https://example.com/stream/config-version.mp4' }] }
                }
            ]
        };
        // The check is on the configVersion rule, not on this fixture's whole document: `validateFeed` also
        // probes the filesystem for every video, and this fixture deliberately has no video file behind it.
        const names = (result) => result.errors.filter((e) => e.includes('configVersion'));
        const good = validateFeed({ ...base, configVersion: 'a'.repeat(64) });
        assert.deepEqual(names(good), [], `a named config version was refused: ${JSON.stringify(good.errors)}`);

        for (const bad of [['a'.repeat(64)], 'short', 'z'.repeat(64), 12345, '']) {
            const r = validateFeed({ ...base, configVersion: bad });
            assert.ok(names(r).length > 0, `configVersion ${JSON.stringify(bad)} was accepted`);
        }
    });

    it('rejects release dates assigned to the wrong month row', () => {
        const feed = {
            providerName: 'Test',
            'September 2026': [
                {
                    title: 'Wrong month',
                    thumbnail: 'https://example.com/thumb.jpg',
                    releaseDate: '2026-10-01',
                    content: { videos: [{ url: 'https://example.com/stream/wrong-month.mp4' }] }
                }
            ]
        };
        const result = validateFeed(feed);
        assert.ok(result.errors.some((error) => error.includes('does not belong in month row')));
    });

    it('rejects month rows and videos that are not newest-first', () => {
        const feed = {
            providerName: 'Test',
            'August 2026': [
                {
                    title: 'Older first',
                    thumbnail: 'https://example.com/thumb.jpg',
                    releaseDate: '2026-08-01',
                    content: { videos: [{ url: 'https://example.com/stream/older.mp4' }] }
                },
                {
                    title: 'Newer second',
                    thumbnail: 'https://example.com/thumb.jpg',
                    releaseDate: '2026-08-15',
                    content: { videos: [{ url: 'https://example.com/stream/newer.mp4' }] }
                }
            ],
            'September 2026': []
        };
        const result = validateFeed(feed);
        assert.ok(result.errors.some((error) => error.includes('Month rows must be sorted newest-first')));
        assert.ok(result.errors.some((error) => error.includes('videos in "August 2026" must be sorted newest-first')));
    });

    it('validates config channel name in feed', () => {
        const result = validateFeedConfig({ channel: {} });
        assert.ok(result.errors.some((e) => e.includes('channel.name')));
    });

    it('validates config feature booleans', () => {
        const result = validateFeedConfig({
            channel: { name: 'Test' },
            features: { search: 'true' }
        });
        assert.ok(result.errors.some((e) => e.includes('boolean')));
    });

    it('accepts valid config', () => {
        const result = validateFeedConfig({
            channel: { name: 'Test' },
            branding: { colors: { background: '0x1A1A2E' } },
            features: { search: true },
            cardStyle: { showTitle: true }
        });
        assert.ok(result.errors.length === 0);
    });

    it('catches invalid hex colors', () => {
        const result = validateFeedConfig({
            channel: { name: 'Test' },
            branding: { colors: { background: 'not-a-color' } }
        });
        assert.ok(result.errors.some((e) => e.includes('hex color')));
    });

    it('validates cardStyle boolean fields', () => {
        const result = validateCardStyle({ showTitle: 'yes' });
        assert.ok(result.errors.some((e) => e.includes('must be a boolean')));
    });

    it('validates cardStyle integer fields', () => {
        const result = validateCardStyle({ titleNumLines: 15 });
        assert.ok(result.errors.some((e) => e.includes('between 1 and 10')));
    });

    it('validates cardStyle with invalid values', () => {
        const result = validateCardStyle({
            showTitle: true,
            titleNumLines: 5,
            showDescription: 'no'
        });
        assert.ok(result.errors.some((e) => e.includes('must be a boolean')));
    });

    it('returns empty errors for null cardStyle', () => {
        const result = validateCardStyle(null);
        assert.strictEqual(result.errors.length, 0);
    });

    it('validates video file existence', () => {
        const feed = {
            providerName: 'Test',
            'June 2025': [
                {
                    title: 'Test Video',
                    thumbnail: 'http://example.com/t.jpg',
                    releaseDate: '2025-06-01',
                    content: { duration: 100, videos: [{ url: 'http://example.com/stream/nonexistent.mp4' }] }
                }
            ]
        };
        const result = validateFeed(feed);
        assert.ok(!result.valid);
        assert.ok(result.errors.some((e) => e.includes('video file not found')));
    });

    it('warns when feed has no videos', () => {
        const feed = {
            providerName: 'Test',
            lastUpdated: new Date().toISOString()
        };
        const result = validateFeed(feed);
        assert.ok(result.valid);
        assert.ok(result.warnings.some((w) => w.includes('no videos')));
    });
});

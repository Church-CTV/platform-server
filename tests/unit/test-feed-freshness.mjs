/**
 * The feed page said "Active" with nothing behind it (night of 2026-11-09)
 *
 * `views/admin/feed.ejs` hardcodes a green `Active` badge; the largest measured gap between feed regenerations on a
 * live origin was 35 days, and `C188` established that nothing schedules them. These checks are the arithmetic and
 * the failure modes behind an honest status: age from the feed's own `lastUpdated`, mtime as the fallback, "I cannot
 * tell" treated as stale rather than fresh, and a threshold that is a deployment input which fails closed.
 *
 * Mutation check (each applied to `lib/feedFreshness.js`, run, then restored byte-exactly; the control uses an
 * anchor absent on purpose and must print `NO-IDENTICAL`):
 *   - M1 missing feed answers `fresh` instead of `missing`: expect RED
 *   - M2 drop the unparsable-timestamp branch so it falls through to `fresh`: expect RED
 *   - M3 remove the clock-skew clamp (`Math.max(0, ...)`): expect RED
 *   - M4 make the mtime fallback win over a parsed `lastUpdated`: expect RED (the check pins which source was used,
 *     because an operator troubleshooting a back-dated `lastUpdated` has to know which number they are looking at)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { feedFreshness, staleThresholdDays, headerValue, DEFAULT_STALE_DAYS } = require(
    path.join(root, 'lib/feedFreshness.js')
);

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0); // 2026-11-09T12:00:00Z, fixed so "today" is not whatever the box says

test('a recently regenerated feed reads fresh, with the age stated', () => {
    const f = feedFreshness({ feed: { lastUpdated: new Date(NOW - 2 * DAY).toISOString() }, nowMs: NOW });
    assert.equal(f.status, 'fresh');
    assert.equal(f.ageDays, 2);
    assert.equal(f.source, 'lastUpdated');
    assert.equal(f.reason, null);
});

test('a feed older than the threshold reads stale, and the reason is matchable', () => {
    const f = feedFreshness({ feed: { lastUpdated: new Date(NOW - 35 * DAY).toISOString() }, nowMs: NOW });
    assert.equal(f.status, 'stale');
    assert.equal(f.ageDays, 35);
    assert.equal(f.reason, 'feed-age-35-days-over-14-day-threshold');
});

test('the threshold boundary is inclusive: exactly the threshold is still fresh', () => {
    assert.equal(
        feedFreshness({ feed: { lastUpdated: new Date(NOW - 14 * DAY).toISOString() }, nowMs: NOW }).status,
        'fresh'
    );
    assert.equal(
        feedFreshness({ feed: { lastUpdated: new Date(NOW - 15 * DAY).toISOString() }, nowMs: NOW }).status,
        'stale'
    );
});

test('a missing or unreadable feed is missing, not fresh', () => {
    for (const feed of [null, undefined, 'not-an-object']) {
        const f = feedFreshness({ feed, mtimeMs: NOW - 3 * DAY, nowMs: NOW });
        assert.equal(f.status, 'missing', `${JSON.stringify(feed)} did not read as missing`);
        assert.equal(f.reason, 'feed-missing-or-unreadable');
    }
});

test('an unparsable lastUpdated falls back to the file mtime, and says which it used', () => {
    const f = feedFreshness({ feed: { lastUpdated: 'yesterday-ish' }, mtimeMs: NOW - 3 * DAY, nowMs: NOW });
    assert.equal(f.source, 'file-mtime');
    assert.equal(f.ageDays, 3);
    assert.equal(f.status, 'fresh');
});

test('no usable timestamp at all is stale, never fresh - failing closed', () => {
    const f = feedFreshness({ feed: { lastUpdated: 'garbage' }, mtimeMs: undefined, nowMs: NOW });
    assert.equal(f.status, 'stale');
    assert.equal(f.ageDays, null);
    assert.equal(f.reason, 'timestamp-unparsable');
});

test('a future timestamp is "just now", not a negative age that reads fresh forever', () => {
    const f = feedFreshness({ feed: { lastUpdated: new Date(NOW + 5 * DAY).toISOString() }, nowMs: NOW });
    assert.equal(f.ageDays, 0, 'clock skew produced a negative age');
    assert.equal(f.status, 'fresh');
});

test('the threshold is a deployment input, and a bad value keeps the shipped default', () => {
    delete process.env.CTV_FEED_STALE_DAYS;
    assert.equal(staleThresholdDays(), DEFAULT_STALE_DAYS);
    process.env.CTV_FEED_STALE_DAYS = '3';
    try {
        assert.equal(staleThresholdDays(), 3);
        assert.equal(
            feedFreshness({ feed: { lastUpdated: new Date(NOW - 5 * DAY).toISOString() }, nowMs: NOW }).status,
            'stale'
        );
    } finally {
        delete process.env.CTV_FEED_STALE_DAYS;
    }
    for (const bad of ['0', '-2', 'abc', '14.5', ' ']) {
        const child = spawnSync(
            process.execPath,
            [
                '-e',
                `const m = require('${path.join(root, 'lib/feedFreshness.js')}'); process.stdout.write(String(m.staleThresholdDays()));`
            ],
            { encoding: 'utf8', env: { ...process.env, CTV_FEED_STALE_DAYS: bad } }
        );
        assert.equal(
            child.stdout.trim(),
            String(DEFAULT_STALE_DAYS),
            `CTV_FEED_STALE_DAYS="${bad}" was taken at face value`
        );
        assert.match(
            String(child.stderr),
            /CTV_FEED_STALE_DAYS/,
            `a real process said nothing about CTV_FEED_STALE_DAYS="${bad}"`
        );
    }
});

test('the machine-readable header carries status, age and threshold', () => {
    const f = feedFreshness({ feed: { lastUpdated: new Date(NOW - 35 * DAY).toISOString() }, nowMs: NOW });
    const header = headerValue(f);
    assert.match(header, /^status=stale/);
    assert.match(header, /age-days=35/);
    assert.match(header, /threshold-days=14/);
    assert.match(header, /source=lastUpdated/);
    const missing = headerValue(feedFreshness({ feed: null, nowMs: NOW }));
    assert.match(missing, /status=missing/);
    assert.match(missing, /age-days=unknown/);
});

/**
 * Is the published feed actually current, and does anyone tell the operator? (night of 2026-11-09)
 *
 * `views/admin/feed.ejs` renders a hardcoded `<span class="badge badge-green">Active</span>` next to a raw
 * "Last Updated" timestamp. So a feed that has not been regenerated in 35 days - the largest gap measured on a
 * live origin by `C188`, where nothing schedules regeneration at all - reads as "Active" to the one person who
 * could do something about it. A claim on a status surface with no check behind it is the thing this project keeps
 * finding, and this time it is in the operator's own dashboard.
 *
 * So: compute the age from the feed's own `lastUpdated`, fall back to the file's mtime when that is missing or
 * unparsable, and fail closed when neither can be trusted - "I cannot tell you this is fresh" is a stale answer,
 * never a fresh one. The threshold is a deployment input; a bad value keeps the shipped default and says so.
 *
 * Deliberately narrow: this is the admin surface only. The published `/feed` wire format belongs to `GATE T1` and
 * is not touched here.
 */

const DEFAULT_STALE_DAYS = 14;

function staleThresholdDays() {
    const raw = process.env.CTV_FEED_STALE_DAYS;
    if (raw === undefined || raw === '') return DEFAULT_STALE_DAYS;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        console.warn(
            `[feedFreshness] ignoring CTV_FEED_STALE_DAYS="${raw}" - expected a positive whole number of days; keeping ${DEFAULT_STALE_DAYS}.`
        );
        return DEFAULT_STALE_DAYS;
    }
    return value;
}

function parseUpdated(feed) {
    const raw = feed && typeof feed.lastUpdated === 'string' ? feed.lastUpdated : null;
    if (!raw) return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * @param feed        the parsed published feed, or null when the file does not exist / cannot be read
 * @param mtimeMs     the feed file's mtime, used when `lastUpdated` is absent or unparsable
 * @param nowMs       injectable clock, so "today" is never whatever the machine thinks
 */
function feedFreshness({ feed, mtimeMs, nowMs }) {
    const now = new Date(nowMs === undefined ? Date.now() : nowMs);
    const thresholdDays = staleThresholdDays();

    if (!feed || typeof feed !== 'object') {
        return { status: 'missing', ageDays: null, thresholdDays, source: null, reason: 'feed-missing-or-unreadable' };
    }

    let at = parseUpdated(feed);
    let source = 'lastUpdated';
    if (!at && typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)) {
        at = new Date(mtimeMs);
        source = 'file-mtime';
    }
    if (!at) {
        // Fail closed: an untrustworthy timestamp is not evidence of freshness.
        return { status: 'stale', ageDays: null, thresholdDays, source: null, reason: 'timestamp-unparsable' };
    }

    const ageMs = now.getTime() - at.getTime();
    // Clock skew is real; a future timestamp is "just now", never a negative age that reads as fresh forever.
    const ageDays = Math.max(0, Math.floor(ageMs / 86400000));
    const status = ageDays > thresholdDays ? 'stale' : 'fresh';
    return {
        status,
        ageDays,
        thresholdDays,
        source,
        reason: status === 'stale' ? `feed-age-${ageDays}-days-over-${thresholdDays}-day-threshold` : null
    };
}

function headerValue(freshness) {
    const age = freshness.ageDays === null ? 'age-days=unknown' : `age-days=${freshness.ageDays}`;
    const parts = [`status=${freshness.status}`, age, `threshold-days=${freshness.thresholdDays}`];
    if (freshness.source) parts.push(`source=${freshness.source}`);
    if (freshness.reason) parts.push(`reason=${freshness.reason}`);
    return parts.join('; ');
}

module.exports = { DEFAULT_STALE_DAYS, staleThresholdDays, feedFreshness, headerValue };

// MUTATION-ANCHOR-FEED-FRESHNESS: the lines inside `feedFreshness` above are the anchors used by the mutation check
// in `tests/unit/test-feed-freshness.mjs`: replacing the missing-feed branch with a `fresh` verdict (M1), removing
// the `timestamp-unparsable` branch (M2), and letting a negative age through (M3). The control uses an anchor that
// is absent on purpose and must print `NO-IDENTICAL`.

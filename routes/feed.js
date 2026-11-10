const express = require('express');
const fs = require('fs');
const router = express.Router();
const { getRateLimitMiddleware } = require('../middleware/rateLimit');
const { readFeed, resolveFeedFile } = require('../lib/feedSource');
const { memoized, sendRepresentation, bytesDigest, fingerprintFiles, feedPolicy } = require('../lib/httpCache');
const { deploymentConfig } = require('../lib/deploymentConfig');
const { rateLimitValue } = require('../lib/rateLimits');

// Budgets live in one place (`lib/rateLimits.js`) with the measurement that sized them.
const feedRateLimit = getRateLimitMiddleware(rateLimitValue('feed'), 60000, 'feed');
const searchRateLimit = getRateLimitMiddleware(rateLimitValue('search'), 60000, 'search');

// The feed's own location is an input too (`lib/feedSource.js`): the content root and the server
// profile both name it, and the repository default is only the last candidate.

/**
 * Resolve and read the active feed file, preferring production over test.
 * Returns { raw, jsonPath, stats } or null if neither file exists.
 */
const loadFeed = readFeed;

/**
 * Flatten all VideoItems from the month-keyed feed object into a single array.
 * Month keys hold arrays of videos; metadata keys (providerName, etc.) are skipped.
 */
function flattenVideos(feed) {
    const videos = [];
    for (const value of Object.values(feed)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item === 'object' && item.id) {
                    videos.push(item);
                }
            }
        }
    }
    return videos;
}

/**
 * Score a single video against a query. Higher score = better match.
 * Matches on title (high), genres (medium), shortDescription (low).
 */
function scoreVideo(video, terms) {
    const title = (video.title || '').toLowerCase();
    const genres = (video.genres || []).map((g) => String(g).toLowerCase());
    const description = (video.shortDescription || '').toLowerCase();

    let score = 0;
    for (const term of terms) {
        if (title.includes(term)) {
            // Title match: +3 base, +1 bonus if the term starts the title (relevance)
            score += 3;
            if (title.startsWith(term)) {
                score += 1;
            }
        }
        if (genres.some((g) => g.includes(term))) {
            score += 2;
        }
        if (description.includes(term)) {
            score += 1;
        }
    }
    return score;
}

/**
 * Filter the full video list by search query.
 * Multi-word queries are treated as AND across terms for relevance,
 * but a video qualifies if it matches ANY term (scored, not boolean).
 * Results are sorted by descending relevance, then by most recent.
 */
function searchVideos(videos, query, limit) {
    const terms = String(query || '')
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (terms.length === 0) {
        return videos.slice(0, limit);
    }

    const scored = [];
    for (const video of videos) {
        const score = scoreVideo(video, terms);
        if (score > 0) {
            scored.push({ video, score });
        }
    }

    scored.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        // Tiebreak: most recent releaseDate first (ISO strings sort lexically)
        const da = a.video.releaseDate || '';
        const db = b.video.releaseDate || '';
        return db.localeCompare(da);
    });

    return scored.slice(0, limit).map((entry) => entry.video);
}

router.get('/feed', feedRateLimit, async (req, res) => {
    try {
        // The legacy published format is a file, so its validator is a digest of the exact bytes served
        // (`CACHE-1`) and those bytes are memoized against the file they came from (`CACHE-2`): an unchanged
        // document is read, hashed and gzipped once, not once per request. Measured on the wire 2026-11-09
        // this one endpoint was 99.1 % of everything the public edge served (30.5 GB of 30.8 GB in 3.9 days),
        // at a p50 of 79 ms per request for a document that changes about once a day.
        const live = resolveFeedFile();
        if (!live) {
            return res.status(404).json({ error: 'Feed not found.' });
        }
        const { value, state } = memoized('legacy-feed', fingerprintFiles(live.path), () => {
            const raw = fs.readFileSync(live.path);
            // Ship the *document*, not the file's formatting. Measured on the example channel origin 2026-11-10 at the
            // first minute of the cached build: the published file on disk is pretty-printed (214,494 B) and the
            // build it replaced shipped the compact form (162,563 B) - the same 260 items, 32 % more bytes on the
            // endpoint the estate polls most, on clients that never ask for gzip. Indentation is a property of a
            // file, so it is normalised here, once per publish, and the digest below is still of the exact bytes
            // sent. A file that is not valid JSON is shipped verbatim rather than refused: it is still someone's
            // published feed, and a digest of the served bytes is honest either way.
            let bytes = raw;
            try {
                bytes = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8');
            } catch {
                console.warn('[Feed] published feed is not valid JSON; serving the file bytes verbatim');
            }
            return { bytes, digest: bytesDigest(bytes) };
        });
        // Freshness is deployment configuration, read from the profile/operator-store layers so an operator
        // who changes it in the panel is answered on the next request - no feed rebuild, no restart.
        return sendRepresentation(
            req,
            res,
            { ...value, lastModified: live.stats.mtime },
            {
                state,
                policy: feedPolicy(deploymentConfig())
            }
        );
    } catch (err) {
        console.error('[Feed] Error loading feed:', err.message);
        res.status(500).json({ error: 'Error loading JSON feed.' });
    }
});

router.get('/search', searchRateLimit, async (req, res) => {
    try {
        const query = req.query.q || '';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

        const feed = await loadFeed();
        if (!feed) {
            // Feed not present - return empty results rather than an error,
            // so the client's local-search fallback has a clean response to work with.
            return res.json([]);
        }

        const data = JSON.parse(feed.raw);
        const videos = flattenVideos(data);
        const results = searchVideos(videos, query, limit);

        res.json(results);
    } catch (err) {
        console.error('[Search] Error searching feed:', err.message);
        res.status(500).json({ error: 'Error searching feed.' });
    }
});

module.exports = router;
// Shared input loader for the separately versioned v2 representation.
module.exports.loadFeed = loadFeed;

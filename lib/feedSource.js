const fs = require('fs-extra');
const path = require('path');

const contentRoot = require('./contentRoot');

/**
 * Which feed document this server publishes, in precedence order.
 *
 * Precedence: the profile's `feedPath`, then the content root's output directory, then the repository
 * default. With nothing configured the answer is the same file as before, byte for byte.
 */
function feedFilePaths() {
    const outDir = contentRoot.outputDir();
    const legacyOutputDir = path.join(contentRoot.ROOT, 'output');
    const candidates = [];
    if (process.env.CTV_V2_FEED_PATH) candidates.push(process.env.CTV_V2_FEED_PATH);
    for (const dir of new Set([outDir, legacyOutputDir])) {
        candidates.push(path.join(dir, 'roku_feed.json'), path.join(dir, 'test_feed.json'));
    }
    return candidates;
}

/**
 * Read the published feed. Returns `{ raw, jsonPath, stats }`, or `null` when no feed exists - which
 * is a state the endpoints answer differently (404 for a television, an empty array for a search).
 */
async function readFeed() {
    for (const candidate of feedFilePaths()) {
        if (!(await fs.pathExists(candidate))) continue;
        const [raw, stats] = await Promise.all([fs.readFile(candidate), fs.stat(candidate)]);
        return { raw, jsonPath: candidate, stats };
    }
    return null;
}

/**
 * Which feed file is live right now, without reading it (2026-11-09). `lib/httpCache.js` fingerprints the
 * inputs of a representation on every request, so the answer must not cost a 1.5 MB read - the whole point
 * of the memo is that an unchanged document is never read, parsed, validated or serialized again.
 */
function resolveFeedFile() {
    for (const candidate of feedFilePaths()) {
        try {
            const stats = fs.statSync(candidate);
            if (stats.isFile()) return { path: candidate, stats };
        } catch {
            /* candidate not present */
        }
    }
    return null;
}

module.exports = { feedFilePaths, resolveFeedFile, readFeed };

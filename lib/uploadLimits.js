/**
 * One source for the two upload ceilings (night of 2026-11-09)
 *
 * Until now the ceiling existed twice, disagreeing: `views/admin/upload.ejs:15` told operators
 * "Max size: 2GB." while `routes/admin.js:57` refused anything over `500 * 1024 * 1024` - the lower number was a
 * deliberate DoS decision, the sentence on the page was left behind. Nothing was in the config schema, nothing was
 * in an environment key, and the view never received a value, so the page could not help but drift.
 *
 * The ceiling is also per-deployment real: a self-hosted box on a 451 GB volume and a hosted origin should not
 * pretend to the same number. So it is an environment input, and it fails closed: a value that is not a positive
 * integer keeps the shipped default and is reported, because a typo in a limit is exactly how a 2 GB ceiling comes
 * back by accident.
 */

const DEFAULT_VIDEO_MAX_BYTES = 500 * 1024 * 1024; // 500 MB, the ceiling chosen on 2026-11-08 after the DoS review
const DEFAULT_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

function resolve(envName, fallback) {
    const raw = process.env[envName];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        console.warn(
            `[uploadLimits] ignoring ${envName}="${raw}" - expected a positive integer of bytes; keeping ${fallback} bytes. A typo in an upload ceiling must not silently raise it.`
        );
        return fallback;
    }
    return value;
}

function videoMaxBytes() {
    return resolve('CTV_MAX_VIDEO_BYTES', DEFAULT_VIDEO_MAX_BYTES);
}

function thumbnailMaxBytes() {
    return resolve('CTV_MAX_THUMBNAIL_BYTES', DEFAULT_THUMBNAIL_MAX_BYTES);
}

/** The number an operator reads, so the page and the refusal cannot state different limits. */
function humanBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return String(bytes);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const text = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
    return `${text} ${units[unit]}`;
}

module.exports = {
    DEFAULT_VIDEO_MAX_BYTES,
    DEFAULT_THUMBNAIL_MAX_BYTES,
    videoMaxBytes,
    thumbnailMaxBytes,
    humanBytes
};

// MUTATION-ANCHOR-UPLOAD-LIMITS: the two lines inside `resolve` above - `if (!Number.isSafeInteger(value) ||
// value <= 0) {` and `return resolve('CTV_MAX_VIDEO_BYTES', DEFAULT_VIDEO_MAX_BYTES);` - are the anchors the
// mutation check for `tests/unit/test-upload-limits.mjs` edits (M1 drops the shape check, M2 ignores the
// environment entirely, control uses an anchor absent on purpose -> `NO-IDENTICAL`).

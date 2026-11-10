const path = require('path');
const fs = require('fs-extra');

// The content root is an input, not a constant.
//
// Two reasons, one operational and one commercial:
//  1. Tests. Every module used to hard-code ../Videos and ../videos.json, so unit tests mutated the
//     working tree and the answers depended on what had run before them. `npm test` failed on a tree that
//     had already run the integration contract (a stray "CI test video" appeared in the month rows), which
//     means the suite could not be used to verify a release build twice in a row.
//  2. One server, several organisations. A second channel is a second content root with its own videos,
//     metadata and output; there is no way to generate for organisation B while organisation A is live
//     unless the root is a parameter. (GATE T1/T2 shape.)
//
// Defaults are exactly the old hard-coded paths, so production behaviour with no environment set is
// byte-identical to before. Overrides are read lazily, on every call, so a test cannot be broken by the
// order its modules were required.
const ROOT = path.join(__dirname, '..');

// The admin views live with the code; a container image may mount them elsewhere, and the render helper
// in middleware/adminAuth.js has to resolve view files the same way Express does.
function viewsDirectory() {
    return process.env.CTV_VIEWS_DIR || path.join(ROOT, 'views');
}

function videosDir() {
    return process.env.CTV_VIDEOS_DIR || path.join(ROOT, 'Videos');
}

function metadataPath() {
    return process.env.CTV_VIDEOS_METADATA || path.join(ROOT, 'videos.json');
}

function outputDir() {
    return process.env.CTV_FEED_OUTPUT_DIR || path.join(ROOT, 'output');
}

// The upload scratch directories were already configurable - `routes/admin.js:31,45` read `CTV_UPLOADS_DIR` -
// but the two modules that *write and serve* thumbnails did not: `lib/thumbnailManager.js` hardcoded
// `<repo>/uploads/thumbnails` and `server.js` served that same hardcoded path. The resolver belongs here, next
// to the others, so the writer and the mount cannot drift again.
function uploadsDir() {
    return process.env.CTV_UPLOADS_DIR || path.join(ROOT, 'uploads');
}

// Fail closed: a missing content root is a typo or a lost mount, and generating an empty feed from it
// would publish "no sermons" to every device. An error here is cheaper than a rollback.
function requireVideosDir() {
    const dir = videosDir();
    if (!fs.existsSync(dir)) {
        const err = new Error(`videos-dir-missing:${dir}`);
        err.code = 'VIDEOS_DIR_MISSING';
        throw err;
    }
    return dir;
}

module.exports = { ROOT, viewsDirectory, videosDir, metadataPath, outputDir, uploadsDir, requireVideosDir };

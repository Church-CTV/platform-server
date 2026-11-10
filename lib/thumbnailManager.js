const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { getVideoMetadata, updateVideoThumbnail } = require('./videoMetadata');

const { videosDir, outputDir, uploadsDir } = require('./contentRoot');

// Resolved at call time, like the metadata store and the feed output directory. They were constants pinned to
// the repository at require time, which put the writer out of step with the reader: `server.js` serves
// `/output/thumbnails` from `outputDir()/thumbnails` (and `lib/serverProfile.js:89` sets that per channel
// profile), so art generated for one profile landed in another profile's art directory - invisible to the
// profile that asked for it, visible to whoever reads the shared one. It also meant every test run wrote into
// the published art directory; `output/thumbnails/` in this checkout held fixture art (`Contract Sermon One.jpg`
// and friends) for exactly that reason.
function autoThumbsDir() {
    return path.join(outputDir(), 'thumbnails');
}

function uploadThumbsDir() {
    return path.join(uploadsDir(), 'thumbnails');
}

function sanitizeTitle(title) {
    if (!title || typeof title !== 'string') return '';
    return title
        .replace(/[|]/g, ' ')
        .replace(/[:]/g, ':')
        .replace(/[^\w\s\-_.]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function getThumbnailPath(filename) {
    const meta = getVideoMetadata(filename);
    if (meta && meta.thumbnailUrl) {
        return meta.thumbnailUrl;
    }
    const sanitized = sanitizeTitle(path.parse(filename).name);
    const autoThumb = path.join(autoThumbsDir(), `${sanitized}.jpg`);
    if (fs.existsSync(autoThumb)) {
        return `/output/thumbnails/${path.basename(autoThumb)}`;
    }
    return null;
}

async function generateAutoThumbnail(videoPath, title) {
    const sanitized = sanitizeTitle(title);
    const thumbsDir = autoThumbsDir();
    const outputPath = path.join(thumbsDir, `${sanitized}.jpg`);
    await fs.ensureDir(thumbsDir);
    if (fs.existsSync(outputPath)) {
        return `/output/thumbnails/${sanitized}.jpg`;
    }
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .on('end', () => resolve(`/output/thumbnails/${sanitized}.jpg`))
            .on('error', (err) => reject(err))
            .screenshots({
                timestamps: ['00:00:01.000'],
                filename: `${sanitized}.jpg`,
                folder: thumbsDir,
                size: '320x240'
            });
    });
}

async function uploadThumbnail(filename, fileBuffer, mimeType) {
    const thumbsDir = uploadThumbsDir();
    await fs.ensureDir(thumbsDir);
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const sanitized = sanitizeTitle(path.parse(filename).name);
    const thumbFilename = `${sanitized}.${ext}`;
    const outputPath = path.join(thumbsDir, thumbFilename);
    try {
        await fs.writeFile(outputPath, fileBuffer);
    } catch (err) {
        console.error('[ThumbnailManager] Write error:', err.message);
        throw new Error(`Failed to save thumbnail: ${err.message}`);
    }
    const url = `/uploads/thumbnails/${thumbFilename}`;
    updateVideoThumbnail(filename, url);
    return url;
}

async function regenerateThumbnail(filename) {
    const videoPath = path.join(videosDir(), filename);
    if (!fs.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${filename}`);
    }
    const title = path.parse(filename).name;
    const result = await generateAutoThumbnail(videoPath, title);
    updateVideoThumbnail(filename, null);
    return result;
}

async function deleteThumbnail(filename) {
    const sanitized = sanitizeTitle(path.parse(filename).name);
    const autoThumb = path.join(autoThumbsDir(), `${sanitized}.jpg`);
    if (fs.existsSync(autoThumb)) fs.removeSync(autoThumb);
    const uploadThumbJpg = path.join(uploadThumbsDir(), `${sanitized}.jpg`);
    if (fs.existsSync(uploadThumbJpg)) fs.removeSync(uploadThumbJpg);
    const uploadThumbPng = path.join(uploadThumbsDir(), `${sanitized}.png`);
    if (fs.existsSync(uploadThumbPng)) fs.removeSync(uploadThumbPng);
}

module.exports = {
    getThumbnailPath,
    generateAutoThumbnail,
    uploadThumbnail,
    regenerateThumbnail,
    deleteThumbnail,
    sanitizeTitle
};

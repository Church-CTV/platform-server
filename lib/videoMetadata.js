const fs = require('fs-extra');

const { metadataPath } = require('./contentRoot');

function METADATA_PATH() {
    return metadataPath();
}

// every read/write below resolves the path at call time, so an override is honoured no matter
// when this module was first required

function loadMetadata() {
    const p = METADATA_PATH();
    if (!fs.existsSync(p)) {
        return {};
    }
    return fs.readJsonSync(p);
}

function saveMetadata(metadata) {
    const p = METADATA_PATH();
    const tmpPath = p + '.tmp';
    const bakPath = p + '.bak';
    try {
        if (fs.existsSync(p)) {
            fs.copySync(p, bakPath);
        }
        fs.writeJsonSync(tmpPath, metadata, { spaces: 2 });
        fs.moveSync(tmpPath, p, { overwrite: true });
        return metadata;
    } catch (err) {
        // Clean up temp file on failure
        try {
            if (fs.existsSync(tmpPath)) {
                fs.unlinkSync(tmpPath);
            }
        } catch (err) {
            console.error('[VideoMetadata] Failed to clean up temp file:', err.message);
        }
        throw err;
    }
}

function getVideoMetadata(filename) {
    const all = loadMetadata();
    return all[filename] || null;
}

function setVideoMetadata(filename, metadata) {
    const all = loadMetadata();
    all[filename] = { ...all[filename], ...metadata };
    saveMetadata(all);
    return all[filename];
}

function deleteVideoMetadata(filename) {
    const all = loadMetadata();
    delete all[filename];
    saveMetadata(all);
}

function getAllVideos() {
    return loadMetadata();
}

function updateVideoTitle(filename, newTitle) {
    setVideoMetadata(filename, { title: newTitle });
}

function updateVideoThumbnail(filename, thumbnailUrl) {
    setVideoMetadata(filename, { thumbnailUrl });
}

function updateVideoDescription(filename, description) {
    setVideoMetadata(filename, { description });
}

function updateVideoReleaseDate(filename, releaseDate) {
    setVideoMetadata(filename, { releaseDate });
}

function updateVideoCategory(filename, category) {
    setVideoMetadata(filename, { category });
}

module.exports = {
    loadMetadata,
    saveMetadata,
    getVideoMetadata,
    setVideoMetadata,
    deleteVideoMetadata,
    getAllVideos,
    updateVideoTitle,
    updateVideoThumbnail,
    updateVideoDescription,
    updateVideoReleaseDate,
    updateVideoCategory,
    // Aliases for admin.js convenience
    getAll: getAllVideos,
    getByFilename: getVideoMetadata,
    // `saveMetadata({[filename]: video})` replaced the whole store, so uploading a video erased every other
    // video's title, category and release date. Merging is what the caller means by "add".
    add: (video) => {
        setVideoMetadata(video.filename, video);
    },
    update: (filename, metadata) => {
        setVideoMetadata(filename, metadata);
    },
    delete: deleteVideoMetadata
};

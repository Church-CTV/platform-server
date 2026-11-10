const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const router = express.Router();
const { getRateLimitMiddleware } = require('../middleware/rateLimit');
const { rateLimitValue } = require('../lib/rateLimits');

const contentRoot = require('../lib/contentRoot');

router.get('/stream/:videoName', (req, res) => {
    const VIDEOS_DIR = path.resolve(contentRoot.requireVideosDir());
    let videoName = decodeURIComponent(req.params.videoName);

    // Reject null bytes (Fix vuln-0002: path traversal)
    if (videoName.includes('\0')) {
        return res.status(403).send('Access denied.');
    }

    // Normalize and resolve path (Fix vuln-0002: strict path traversal guard)
    const normalized = path.normalize(videoName).replace(/^(\.\.(\/|\\))+/, '');
    const resolvedPath = path.resolve(VIDEOS_DIR, normalized);

    // Strict check - must start with VIDEOS_DIR + separator (no edge case for root dir)
    if (!resolvedPath.startsWith(VIDEOS_DIR + path.sep)) {
        return res.status(403).send('Access denied.');
    }

    if (!fs.existsSync(resolvedPath)) {
        return res.status(404).send('Video not found.');
    }

    const stat = fs.statSync(resolvedPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const extname = path.extname(videoName).toLowerCase();
    let contentType = 'video/mp4';
    if (extname === '.mkv') {
        contentType = 'video/x-matroska';
    }

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');

        // Handle suffix range (bytes=-N): last N bytes
        if (parts[0] === '') {
            const suffixLen = parseInt(parts[1], 10);
            if (isNaN(suffixLen) || suffixLen <= 0) {
                return res.status(416).send('Invalid Range header');
            }
            const start = Math.max(0, fileSize - suffixLen);
            const end = fileSize - 1;
            const contentLength = end - start + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': contentLength,
                'Content-Type': contentType
            });
            const readStream = fs.createReadStream(resolvedPath, { start, end });
            readStream.on('error', () => {
                console.error('[Stream] Error reading video file (headers already sent):', resolvedPath);
            });
            readStream.pipe(res);
            return;
        }

        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (isNaN(start) || isNaN(end)) {
            return res.status(416).send('Invalid Range header');
        }

        if (start > end) {
            return res.status(416).send('Invalid Range header');
        }

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': contentType
        });
        const readStream = fs.createReadStream(resolvedPath, { start, end });
        readStream.on('error', () => {
            console.error('[Stream] Error reading video file (headers already sent):', resolvedPath);
        });
        readStream.pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
        const readStream = fs.createReadStream(resolvedPath);
        readStream.on('error', () => {
            console.error('[Stream] Error reading video file (headers already sent):', resolvedPath);
        });
        readStream.pipe(res);
    }
});

// /live scans the video directory to find the broadcast, so it is budgeted: the number and the
// measurement behind the whole family of budgets is in `lib/rateLimits.js`.
const liveRateLimit = getRateLimitMiddleware(rateLimitValue('live'), 60000, 'stream');

// GET /live - Live broadcast endpoint for Roku client
// Serves the live broadcast video file
router.get('/live', liveRateLimit, async (req, res) => {
    try {
        // Look for live broadcast video file
        const files = await fs.readdir(contentRoot.requireVideosDir());
        const liveVideo = files.find(
            (file) => file.toLowerCase().includes('live broadcast') || file.toLowerCase().includes('live-stream')
        );

        if (!liveVideo) {
            return res.status(404).json({ error: 'Live broadcast video not found' });
        }

        // Redirect to the stream endpoint
        res.redirect(302, `/stream/${encodeURIComponent(liveVideo)}`);
    } catch (err) {
        console.error('[Live] Error:', err.message);
        res.status(500).json({ error: 'Failed to find live broadcast video' });
    }
});

module.exports = router;

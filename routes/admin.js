const express = require('express');
const router = express.Router();
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const { fileTypeFromFile } = require('file-type');

const adminAuth = require('../lib/adminAuth');
const auditLog = require('../lib/auditLog');
const authMiddleware = require('../middleware/adminAuth');
const configStore = require('../lib/configStore');
const reasonCopy = require('../lib/reasonCopy');
const feedGenerator = require('../lib/feedGenerator');
const videoMetadata = require('../lib/videoMetadata');
const { sanitizeVideoField } = require('../lib/htmlSanitizer');
const { getRateLimitMiddleware } = require('../middleware/rateLimit');
const { videosDir, outputDir } = require('../lib/contentRoot');

// ============================================================
// Multer config for file uploads (must be defined before routes)
// ============================================================

const multer = require('multer');

const videoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Where a body lands before it is accepted. Hardcoded to the app directory it could not live on a
        // mounted volume, and a test could not use it without littering the checkout.
        const uploadDir = process.env.CTV_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
        fs.ensureDirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const thumbnailStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Where a body lands before it is accepted. Hardcoded to the app directory it could not live on a
        // mounted volume, and a test could not use it without littering the checkout.
        const uploadDir = process.env.CTV_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
        fs.ensureDirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const { videoMaxBytes, thumbnailMaxBytes, humanBytes } = require('../lib/uploadLimits');
const uploadFormats = require('../lib/uploadFormats');
const feedFreshnessLib = require('../lib/feedFreshness');
const { feedFreshness } = feedFreshnessLib;

const videoUpload = multer({
    storage: videoStorage,
    // The ceiling and the sentence on the upload page come from one place now (`lib/uploadLimits.js`). They used to
    // be two numbers: the page said "Max size: 2GB." while this said 500 MB (lowered on 2026-11-08 after the DoS
    // review), so the screen instructed operators to do the one thing the server would refuse.
    limits: { fileSize: videoMaxBytes() },
    fileFilter: (req, file, cb) => {
        // Extension only, deliberately. The magic-byte check that used to live here called
        // `fileTypeFromFile(file.path)`, but multer 2.4.0 runs `fileFilter` before `destination`/`filename`,
        // so `file.path` is undefined: the call threw, the filter answered
        // "Could not validate file content." and *every* video upload died with a 500 (measured 2026-11-08:
        // `The "path" argument must be of type string ... Received undefined`). Content is validated on the
        // written file below, where there is a file to read.
        const allowed = uploadFormats.videoExtensions();
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowed.includes(ext)) {
            return cb(
                new Error(`Invalid file type. Only ${uploadFormats.advertisedExtensions(allowed)} are supported.`)
            );
        }
        cb(null, true);
    }
});

const thumbnailUpload = multer({
    storage: thumbnailStorage,
    limits: { fileSize: thumbnailMaxBytes() },
    fileFilter: (req, file, cb) => {
        // Same reason as the video filter above: no `file.path` at filter time, so content inspection cannot
        // happen here. The written file is inspected in the handler.
        const allowed = uploadFormats.imageExtensions();
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowed.includes(ext)) {
            return cb(
                new Error(
                    `Invalid image type. Only ${uploadFormats.advertisedExtensions(uploadFormats.imageExtensions())} are supported.`
                )
            );
        }
        cb(null, true);
    }
});

/**
 * Validate an upload by what its bytes are, not by what its name claims (vuln-0010), now that there is a
 * file to read. The refusal names the reason in machine-readable form so the operator's flash message, the
 * server log and any probe quote the same code.
 */
// One declaration for what may be uploaded (`lib/uploadFormats.js`): the extension filter, the content check and
// the sentence on the upload page used to be three lists that could - and did - disagree. Measured on 2026-11-09
// with `file-type` 22.0.1 and files written by this host's ffmpeg: a real AVI detects as `video/vnd.avi` and a real
// Matroska as `video/matroska`, while this allowlist carried only the detector's legacy names
// (`video/x-msvideo`, `video/x-matroska`) - so `.avi` and `.mkv`, both advertised on the page and admitted by the
// extension filter, were refused after the whole file had streamed up.
const UPLOAD_MIME_KINDS = {
    video: { allowed: uploadFormats.videoMimes(), label: uploadFormats.videoLabel() },
    image: { allowed: uploadFormats.imageMimes(), label: uploadFormats.imageLabel() }
};

async function inspectUpload(filePath, kind) {
    const spec = UPLOAD_MIME_KINDS[kind];
    let detected;
    try {
        detected = await fileTypeFromFile(filePath);
    } catch (err) {
        return {
            ok: false,
            reason: `content-unreadable:${err.message}`,
            message: `Could not read the uploaded file (content-unreadable).`
        };
    }
    if (!detected) {
        return {
            ok: false,
            reason: 'content-unrecognised',
            message: 'The uploaded file is not recognisable as ' + spec.label + ' (content-unrecognised).'
        };
    }
    if (!spec.allowed.includes(detected.mime)) {
        return {
            ok: false,
            // A code a consumer can match, not a sentence with slashes in it. The old shape concatenated the whole
            // allowlist into the identifier
            // (`content-is-image/png-not-video/mp4-not-video/quicktime-...`), which no caller can compare against
            // and which made the "machine-readable reason" claim false in exactly the case it was written for.
            reason: `content-not-allowed:${detected.mime}`,
            detectedMime: detected.mime,
            allowedMimes: spec.allowed,
            message: `The uploaded file is ${detected.mime}, not ${spec.label} (content-not-allowed:${detected.mime}).`
        };
    }
    return { ok: true, mime: detected.mime };
}

/**
 * A request that was refused after its body was written must not leave the body behind. Rate limit,
 * authentication and CSRF all run after Multer has streamed the file, so every one of them can end the
 * request with a temp file on disk - on a 500 MB video that is a slow disk fill with no cleanup.
 */
function discardRejectedUpload(req, res, next) {
    const file = req.file;
    if (!file || !file.path) return next();
    let discarded = false;
    const discard = () => {
        if (discarded) return;
        discarded = true;
        // Synchronous on purpose. `fs.remove` with a callback returned control to the event loop, so a
        // refused upload could still be sitting in the uploads directory when the next request arrived.
        // A refused 500 MB body is the whole reason this middleware exists, so an orphan that is only
        // *eventually* deleted is the bug it was written to fix. If it cannot be deleted, say so:
        // a silent orphan on a 451 GB volume is a slow outage.
        try {
            fs.removeSync(file.path);
        } catch (err) {
            console.warn(`[Admin] refused upload left behind at ${file.path}: ${err.code || err.message}`);
        }
    };

    // Ordering that actually matters (2026-11-09): the body has to be gone before the first response byte,
    // because answering the refusal is the first moment the operator's client can look again. A
    // `res.on("finish")` handler runs after the flush, which is why "a refusal leaves nothing behind" kept
    // failing intermittently - 1 run in 4 standalone and 1 in 4 full-suite runs, with
    // `the CSRF refusal left ["1794278705115-1d1e8d404bed58f8.mp4"] behind` - even after the removal was
    // made synchronous. Discard at `res.end`; keep the `finish` hook as the catch-all for any refusal path
    // that answers without going through this wrapper.
    const end = res.end.bind(res);
    res.end = (...args) => {
        if (res.statusCode >= 400) discard();
        return end(...args);
    };
    res.on('finish', () => {
        if (res.statusCode < 400) return;
        discard();
    });
    next();
}

// Apply flash middleware first
router.use(authMiddleware.flashMiddleware);

// ============================================================
// Public routes (no auth required)
// ============================================================

/** GET /admin/login - Login page */
router.get('/login', (req, res) => {
    const ip = adminAuth.getClientIp(req);
    const lockout = adminAuth.checkLoginLockout(ip);
    const error = req.query.error || '';

    res.render('admin/login', {
        csrfToken: adminAuth.generateCsrfToken(),
        error,
        lockout,
        retryAfterMs: lockout.retryAfterMs
    });
});

/** POST /admin/login - Authenticate */
const adminLoginRateLimit = getRateLimitMiddleware(10, 60000, 'admin-login');
router.post('/login', adminLoginRateLimit, (req, res) => {
    const ip = adminAuth.getClientIp(req);
    const { password } = req.body;

    // Check lockout first
    const lockout = adminAuth.checkLoginLockout(ip);
    if (lockout.locked) {
        auditLog.logEvent('login_blocked', { ip }, req);
        return res.render('admin/login', {
            csrfToken: adminAuth.generateCsrfToken(),
            error: `Too many failed attempts. Please wait ${adminAuth.formatRetryAfter(lockout.retryAfterMs)} before trying again.`,
            lockout,
            retryAfterMs: lockout.retryAfterMs
        });
    }

    // Validate credentials
    const hash = adminAuth.loadPasswordHash();
    if (!hash) {
        auditLog.logEvent('login_fail', { ip, reason: 'No password set' }, req);
        adminAuth.recordFailedLogin(ip);
        return res.render('admin/login', {
            csrfToken: adminAuth.generateCsrfToken(),
            error: 'Authentication is not configured. Set ADMIN_PASSWORD in your .env file.'
        });
    }

    if (!adminAuth.verifyPassword(password, hash)) {
        adminAuth.recordFailedLogin(ip);
        auditLog.logEvent('login_fail', { ip }, req);
        return res.render('admin/login', {
            csrfToken: adminAuth.generateCsrfToken(),
            error: 'Invalid username or password.',
            lockout: false,
            retryAfterMs: 0
        });
    }

    // Success - regenerate session to prevent fixation
    req.session.regenerate((err) => {
        if (err) {
            console.error('[AdminAuth] Session regeneration failed:', err.message);
            return res.status(500).json({ error: 'Internal server error' });
        }

        adminAuth.resetLoginAttempts(ip);
        req.session.adminAuthenticated = true;
        req.session.csrfToken = adminAuth.generateCsrfToken();
        req.session.loginTime = Date.now();
        req.session.lastActivity = Date.now();

        auditLog.logEvent('login_success', { ip }, req);

        // Redirect to intended URL or dashboard
        const redirectTo = req.session.redirectTo || '/admin';
        delete req.session.redirectTo;

        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.json({ success: true, redirect: redirectTo });
        }

        res.redirect(redirectTo);
    });
});

/** GET /admin/logout - Destroy session */
router.get('/logout', (req, res) => {
    const ip = adminAuth.getClientIp(req);
    auditLog.logEvent('logout', { ip }, req);

    req.session.destroy((err) => {
        if (err) console.error('[AdminAuth] Session destruction failed:', err.message);
        res.redirect('/admin/login');
    });
});

// ============================================================
// Authenticated routes (require login)
// ============================================================

router.use(authMiddleware.renderAdmin);
router.use(authMiddleware.requireAuth);

/** GET /admin - Dashboard */
router.get('/', async (req, res) => {
    try {
        // Get feed stats
        let videoCount = 0;
        let monthCount = 0;
        const feedPath = path.join(outputDir(), 'roku_feed.json');

        if (await fs.pathExists(feedPath)) {
            const feed = await fs.readJson(feedPath);
            for (const key of Object.keys(feed)) {
                if (Array.isArray(feed[key])) {
                    videoCount += feed[key].length;
                    monthCount++;
                }
            }
        }

        // Get config
        const config = configStore.loadConfig();

        // Get recent audit entries
        const recentAudit = auditLog.getEntries(10);

        // Get system info
        const diskUsage = await getDiskUsage();
        const dbSize = await getDbSize();

        res.render('admin/dashboard', {
            videoCount,
            monthCount,
            config: config.channel || {},
            branding: config.branding || {},
            recentAudit,
            uptime: process.uptime(),
            diskUsage,
            dbSize
        });
    } catch (err) {
        console.error('[Admin] Dashboard error:', err.message);
        req.flash('error', 'Failed to load dashboard data.');
        res.redirect('/admin');
    }
});

/** GET /admin/videos - Video list */
router.get('/videos', async (req, res) => {
    try {
        // The metadata store is an object keyed by filename; the list, the filter and the sort below all
        // want an array. Measured 2026-11-08 before the fix: `videos.sort is not a function`, caught, and the
        // operator was bounced to /admin with "Failed to load videos." - the video list was unreachable.
        const byFilename = await videoMetadata.getAll();
        const videos = Object.entries(byFilename || {}).map(([filename, meta]) => ({ filename, ...(meta || {}) }));
        let searchQuery = req.query.q || '';

        // Filter by search query if provided
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            const filtered = videos.filter(
                (v) =>
                    (v.title || '').toLowerCase().includes(q) ||
                    (v.category || '').toLowerCase().includes(q) ||
                    (v.filename || '').toLowerCase().includes(q)
            );
            videos.length = 0;
            videos.push(...filtered);
        }

        // Sort by release date descending
        videos.sort((a, b) => {
            const da = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
            const db = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
            return db - da;
        });

        res.render('admin/videos', { videos, searchQuery });
    } catch (err) {
        console.error('[Admin] Videos list error:', err.message);
        req.flash('error', 'Failed to load videos.');
        res.redirect('/admin');
    }
});

/** GET /admin/videos/new - Upload form */
router.get('/videos/new', (req, res) => {
    // The limit is handed to the page rather than typed into it: the screen used to say "Max size: 2GB." while the
    // server refused 500 MB, which is an instruction to fail.
    res.render('admin/upload', {
        uploadFormats: { videoHuman: uploadFormats.advertisedExtensions(uploadFormats.videoExtensions()) },
        uploadLimits: {
            videoMaxBytes: videoMaxBytes(),
            videoMaxHuman: humanBytes(videoMaxBytes()),
            thumbnailMaxHuman: humanBytes(thumbnailMaxBytes())
        }
    });
});

/** Admin POST rate limit - prevents DoS on CPU-heavy operations (ffprobe, feed regen, etc.) */
const adminRouteRateLimit = getRateLimitMiddleware(30, 60000, 'admin-route');

/** POST /admin/videos - Upload video */
router.post(
    '/videos',
    adminRouteRateLimit,
    // Authenticate before the body is streamed: `requireAuth` needs nothing from the body, so an anonymous
    // caller (the only actor a self-hosted box has to fear from the WAN) never writes 500 MB to disk. The
    // CSRF token lives in the multipart body, so *that* check still runs after Multer has parsed it.
    authMiddleware.requireAuth,
    videoUpload.single('video'),
    discardRejectedUpload,
    authMiddleware.requireAuthAndCsrf,
    async (req, res) => {
        try {
            const file = req.file;
            if (!file) {
                req.flash('error', 'No file uploaded.');
                return res.redirect('/admin/videos/new');
            }

            // Magic bytes, on the file that now exists (see inspectUpload above).
            const content = await inspectUpload(file.path, 'video');
            if (!content.ok) {
                fs.removeSync(file.path);
                auditLog.logEvent('upload_rejected', { reason: content.reason, originalname: file.originalname }, req);
                req.flash('error', content.message);
                return res.redirect('/admin/videos/new');
            }

            // Validate file extension (belt-and-suspenders with the magic bytes just checked)
            const ext = path.extname(file.originalname).toLowerCase();
            if (!uploadFormats.videoExtensions().includes(ext)) {
                fs.rmSync(file.path);
                req.flash(
                    'error',
                    `Invalid file type. Only ${uploadFormats.advertisedExtensions(uploadFormats.videoExtensions())} are supported.`
                );
                return res.redirect('/admin/videos/new');
            }

            // Get video duration via ffprobe with timeout
            const duration = await getVideoDuration(file.path).catch(() => 0);

            // Fix vuln-0006: Sanitize user input to prevent stored XSS
            const title = sanitizeVideoField(req.body.title) || extractTitleFromFilename(file.originalname);
            const category = sanitizeVideoField(req.body.category) || 'Sermons';
            const releaseDate = req.body.releaseDate || new Date().toISOString().split('T')[0];
            const description = sanitizeVideoField(req.body.description) || '';

            // Generate slug for filename
            const slug = title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');

            const newFilename = `${slug}${ext}`;
            // The rest of the server reads videos from `contentRoot.videosDir()`, which honours
            // `CTV_VIDEOS_DIR`. Writing next to the code instead meant an uploaded video landed where nothing
            // would ever serve it - invisible in the feed on any install whose media lives elsewhere.
            const newPath = path.join(videosDir(), newFilename);

            // Move file to Videos directory
            await fs.move(file.path, newPath, { overwrite: true });

            // Save metadata
            await videoMetadata.add({
                filename: newFilename,
                title,
                category,
                releaseDate,
                description,
                duration
            });

            auditLog.logEvent('video_upload', { title, filename: newFilename }, req);
            req.flash('success', `Video "${title}" uploaded successfully.`);
            res.redirect('/admin/videos');
        } catch (err) {
            console.error('[Admin] Video upload error:', err.message);
            // Clean up uploaded file if it exists
            if (req.file && req.file.path) {
                fs.rmSync(req.file.path, { force: true });
            }
            req.flash('error', `Upload failed: ${err.message}`);
            res.redirect('/admin/videos/new');
        }
    }
);

/** GET /admin/videos/:filename/edit - Edit video form */
router.get('/videos/:filename/edit', async (req, res) => {
    try {
        const filename = decodeURIComponent(req.params.filename);
        const video = await videoMetadata.getByFilename(filename);

        if (!video) {
            req.flash('error', 'Video not found.');
            return res.redirect('/admin/videos');
        }

        // Check for custom thumbnail
        const thumbBase = path.resolve(outputDir(), 'thumbnails');
        const thumbPath = path.join(thumbBase, `${filename}.jpg`);
        if (!thumbPath.startsWith(thumbBase + path.sep) && thumbPath !== thumbBase) {
            req.flash('error', 'Invalid filename.');
            return res.redirect('/admin/videos');
        }
        const hasThumbnail = await fs.pathExists(thumbPath);

        res.render('admin/editVideo', { video, hasThumbnail });
    } catch (err) {
        console.error('[Admin] Edit video error:', err.message);
        req.flash('error', 'Failed to load video.');
        res.redirect('/admin/videos');
    }
});

/** POST /admin/videos/:filename/edit - Update video metadata */
router.post('/videos/:filename/edit', adminRouteRateLimit, authMiddleware.requireAuthAndCsrf, async (req, res) => {
    try {
        const filename = decodeURIComponent(req.params.filename);
        // Fix vuln-0006: Sanitize user input to prevent stored XSS
        const title = sanitizeVideoField(req.body.title);
        const category = sanitizeVideoField(req.body.category);
        const releaseDate = req.body.releaseDate;
        const description = sanitizeVideoField(req.body.description);

        if (!title || !category || !releaseDate) {
            req.flash('error', 'Title, category, and release date are required.');
            return res.redirect(`/admin/videos/${filename}/edit`);
        }

        const video = await videoMetadata.getByFilename(filename);
        if (!video) {
            req.flash('error', 'Video not found.');
            return res.redirect('/admin/videos');
        }

        // Validate category
        if (!['Sermons', 'Events'].includes(category)) {
            req.flash('error', 'Invalid category.');
            return res.redirect(`/admin/videos/${filename}/edit`);
        }

        // Validate date format (YYYY-MM-DD)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
            req.flash('error', 'Release date must be in YYYY-MM-DD format.');
            return res.redirect(`/admin/videos/${filename}/edit`);
        }

        await videoMetadata.update(filename, { title, category, releaseDate, description });

        auditLog.logEvent('video_edit', { filename, title }, req);
        req.flash('success', `Video "${title}" updated.`);
        res.redirect('/admin/videos');
    } catch (err) {
        console.error('[Admin] Update video error:', err.message);
        req.flash('error', 'Failed to update video.');
        res.redirect(`/admin/videos/${req.params.filename}/edit`);
    }
});

/** POST /admin/videos/:filename/thumbnail - Upload custom thumbnail */
router.post(
    '/videos/:filename/thumbnail',
    adminRouteRateLimit,
    authMiddleware.requireAuth,
    thumbnailUpload.single('thumbnail'),
    discardRejectedUpload,
    authMiddleware.requireAuthAndCsrf,
    async (req, res) => {
        try {
            const file = req.file;
            if (!file) {
                req.flash('error', 'No thumbnail image uploaded.');
                return res.redirect(`/admin/videos/${decodeURIComponent(req.params.filename)}/edit`);
            }

            // Magic bytes, on the written file (see inspectUpload above).
            const content = await inspectUpload(file.path, 'image');
            if (!content.ok) {
                fs.removeSync(file.path);
                auditLog.logEvent('upload_rejected', { reason: content.reason, originalname: file.originalname }, req);
                req.flash('error', content.message);
                return res.redirect(`/admin/videos/${decodeURIComponent(req.params.filename)}/edit`);
            }

            // Validate image type
            const ext = path.extname(file.originalname).toLowerCase();
            if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
                fs.rmSync(file.path);
                req.flash(
                    'error',
                    `Invalid image type. Only ${uploadFormats.advertisedExtensions(uploadFormats.imageExtensions())} are supported.`
                );
                return res.redirect(`/admin/videos/${decodeURIComponent(req.params.filename)}/edit`);
            }

            // Ensure thumbnails directory exists
            const thumbDir = path.join(outputDir(), 'thumbnails');
            await fs.ensureDir(thumbDir);

            const filename = decodeURIComponent(req.params.filename);
            const thumbBase = path.resolve(thumbDir);
            const newThumbPath = path.join(thumbBase, `${filename}.jpg`);
            if (!newThumbPath.startsWith(thumbBase + path.sep) && newThumbPath !== thumbBase) {
                req.flash('error', 'Invalid filename.');
                return res.redirect(`/admin/videos/${filename}/edit`);
            }

            // Convert to JPG if PNG
            if (ext === '.png') {
                await new Promise((resolve, reject) => {
                    ffmpeg(file.path)
                        .output(newThumbPath)
                        .outputOptions('-format mjpeg')
                        .on('end', () => resolve())
                        .on('error', reject)
                        .run();
                });
            } else {
                await fs.move(file.path, newThumbPath, { overwrite: true });
            }

            auditLog.logEvent('thumbnail_upload', { filename }, req);
            req.flash('success', 'Thumbnail uploaded successfully.');
            res.redirect(`/admin/videos/${filename}/edit`);
        } catch (err) {
            console.error('[Admin] Thumbnail upload error:', err.message);
            if (req.file && req.file.path) fs.rmSync(req.file.path, { force: true });
            req.flash('error', 'Failed to upload thumbnail.');
            res.redirect(`/admin/videos/${decodeURIComponent(req.params.filename)}/edit`);
        }
    }
);

/** DELETE /admin/videos/:filename - Delete video */
router.delete('/videos/:filename', authMiddleware.requireAuthAndCsrf, async (req, res) => {
    try {
        const filename = decodeURIComponent(req.params.filename);
        const video = await videoMetadata.getByFilename(filename);

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Delete video file
        const videosBase = path.resolve(__dirname, '..', 'Videos');
        const videoPath = path.join(videosBase, filename);
        if (!videoPath.startsWith(videosBase + path.sep) && videoPath !== videosBase) {
            return res.status(403).json({ error: 'Access denied.' });
        }
        if (await fs.pathExists(videoPath)) {
            await fs.remove(videoPath);
        }

        // Delete thumbnail if exists
        const thumbBase = path.resolve(outputDir(), 'thumbnails');
        const thumbPath = path.join(thumbBase, `${filename}.jpg`);
        if (!thumbPath.startsWith(thumbBase + path.sep) && thumbPath !== thumbBase) {
            return res.status(403).json({ error: 'Access denied.' });
        }
        if (await fs.pathExists(thumbPath)) {
            await fs.remove(thumbPath);
        }

        // Delete metadata
        await videoMetadata.delete(filename);

        auditLog.logEvent('video_delete', { filename, title: video.title }, req);
        res.json({ success: true });
    } catch (err) {
        console.error('[Admin] Delete video error:', err.message);
        res.status(500).json({ error: 'Failed to delete video' });
    }
});

/** GET /admin/config - Config editor */
router.get('/config', (req, res) => {
    try {
        const config = configStore.loadConfig();
        res.render('admin/config', { config });
    } catch (err) {
        console.error('[Admin] Config load error:', err.message);
        req.flash('error', 'Failed to load configuration.');
        res.redirect('/admin');
    }
});

/** POST /admin/config - Save config */
router.post('/config', adminRouteRateLimit, authMiddleware.requireAuthAndCsrf, (req, res) => {
    try {
        // Load existing config for defaults (color/image fields not in form)
        const existingConfig = configStore.loadConfig();

        // Fix vuln-0006: Sanitize all user input to prevent stored XSS
        const channelName = sanitizeVideoField(req.body.channelName);
        const channelDescription = sanitizeVideoField(req.body.channelDescription);

        // Validate required fields
        if (!channelName || !channelDescription) {
            req.flash('error', 'Channel name and description are required.');
            return res.redirect('/admin/config');
        }

        // Merge onto the existing config so keys the form does not expose
        // (features, ui, cardStyle, content, analytics) survive the save.
        // Overwriting config.json with only channel+branding dropped them, and
        // the next feed regeneration embedded undefined for those keys, which
        // breaks the Roku client's feed.config contract.
        const savedConfig = {
            ...existingConfig,
            channel: {
                ...(existingConfig.channel || {}),
                name: channelName,
                description: channelDescription,
                language: sanitizeVideoField(req.body.channelLanguage) || 'en',
                copyright: sanitizeVideoField(req.body.channelCopyright) || ''
            },
            branding: {
                ...(existingConfig.branding || {}),
                colors: {
                    ...(existingConfig.branding?.colors || {}),
                    background: (req.body.colorBackground || '0x1A1A2E').replace(/^#/, '0x'),
                    surface: (req.body.colorSurface || '0x16213E').replace(/^#/, '0x'),
                    accent: (req.body.colorAccent || '0xE8B931').replace(/^#/, '0x'),
                    textPrimary: (
                        req.body.colorTextPrimary ||
                        existingConfig.branding?.colors?.textPrimary ||
                        '0xFFFFFF'
                    ).replace(/^#/, '0x'),
                    textSecondary: (
                        req.body.colorTextSecondary ||
                        existingConfig.branding?.colors?.textSecondary ||
                        '0xA0A0B0'
                    ).replace(/^#/, '0x'),
                    focus: (req.body.colorFocus || existingConfig.branding?.colors?.focus || '0xE8B931').replace(
                        /^#/,
                        '0x'
                    ),
                    error: (req.body.colorError || existingConfig.branding?.colors?.error || '0xFF4444').replace(
                        /^#/,
                        '0x'
                    )
                },
                images: {
                    ...(existingConfig.branding?.images || {}),
                    overhangLogo: sanitizeVideoField(req.body.imageOverhangLogo || '') || '',
                    backgroundImage: sanitizeVideoField(req.body.imageBackgroundImage || '') || '',
                    iconFocus: sanitizeVideoField(req.body.imageIconFocus || '') || ''
                }
            }
        };

        // Validate before saving
        configStore.validateConfig(savedConfig);
        configStore.saveConfig(savedConfig);

        auditLog.logEvent('config_change', { section: 'channel' }, req);
        req.flash('success', 'Configuration saved successfully.');
        res.redirect('/admin/config');
    } catch (err) {
        console.error('[Admin] Config save error:', err.message);
        // The contract gate names every offending key. Show the operator sentence and keep the
        // machine-readable code on the same line: the screen has to be actionable, and the line has
        // to be pasteable into a support message.
        const reasons = Array.isArray(err.reasons) ? err.reasons : [];
        req.flash('error', reasons.length > 0 ? reasonCopy.summary(reasons).join(' ') : `Save failed: ${err.message}`);
        res.redirect('/admin/config');
    }
});

/** POST /admin/feed/regenerate - Regenerate feed */
router.post('/feed/regenerate', adminRouteRateLimit, authMiddleware.requireAuthAndCsrf, async (req, res) => {
    try {
        const result = await feedGenerator.regenerateFeed();

        if (result.success) {
            auditLog.logEvent('feed_regenerate', { videoCount: result.videoCount }, req);
            req.flash('success', `Feed regenerated with ${result.videoCount} videos.`);
        } else {
            req.flash('error', `Feed regeneration failed: ${result.error}`);
        }

        res.redirect('/admin/feed');
    } catch (err) {
        console.error('[Admin] Feed regenerate error:', err.message);
        // The reason, quoted, not just the fact of failure. Every other refusal this operator can meet names
        // itself - an unknown config key, an unparsable upload, a refused upload body - and this is the one path
        // that swallowed it: `regenerateFeed()` throws `Feed generation failed for N files: Missing or invalid
        // release date for "x.mp4": none`, which is exactly the sentence that tells the operator what to fix.
        // Bounded, because it is rendered into a page.
        const reason = String(err.message || 'unknown error').slice(0, 400);
        req.flash('error', `Feed regeneration failed: ${reason}`);
        res.redirect('/admin/feed');
    }
});

/** GET /admin/feed - Feed management */
router.get('/feed', async (req, res) => {
    try {
        const feedPath = path.join(outputDir(), 'roku_feed.json');
        let feed = null;
        let videoCount = 0;
        let monthCount = 0;
        let mtimeMs;

        if (await fs.pathExists(feedPath)) {
            feed = await fs.readJson(feedPath);
            mtimeMs = (await fs.stat(feedPath)).mtimeMs;
            for (const key of Object.keys(feed)) {
                if (Array.isArray(feed[key])) {
                    videoCount += feed[key].length;
                    monthCount++;
                }
            }
        }

        // The page used to render a green "Active" badge unconditionally - a status with no check behind it, on the
        // one surface where an operator could act on it. `C188` measured a 35-day gap between feed regenerations on
        // a live origin, and nothing there schedules them; the badge said "Active" the whole time.
        const freshness = feedFreshness({ feed, mtimeMs });
        res.set('X-CTV-Feed-Status', feedFreshnessLib.headerValue(freshness));

        const config = configStore.loadConfig();

        res.render('admin/feed', { feed: feed || {}, videoCount, monthCount, config, freshness });
    } catch (err) {
        console.error('[Admin] Feed page error:', err.message);
        req.flash('error', 'Failed to load feed data.');
        res.redirect('/admin');
    }
});

/** GET /admin/analytics - Analytics dashboard */
router.get('/analytics', async (req, res) => {
    try {
        const { getDb } = require('../lib/db');
        const db = getDb();

        // Get total events
        const totalEvents = db.prepare('SELECT COUNT(*) as count FROM events').get();

        // Get plays
        const totalPlays = db.prepare("SELECT COUNT(*) as count FROM events WHERE event_type = 'content_play'").get();

        // Get errors
        const totalErrors = db.prepare("SELECT COUNT(*) as count FROM events WHERE event_type = 'error'").get();

        // Get deep links
        const totalDeepLinks = db.prepare("SELECT COUNT(*) as count FROM events WHERE event_type = 'deep_link'").get();

        // Top videos by plays
        const topVideos = db
            .prepare(
                `
            SELECT json_extract(payload, '$.contentTitle') as title, COUNT(*) as count
            FROM events
            WHERE event_type = 'content_play' AND json_extract(payload, '$.contentTitle') IS NOT NULL
            GROUP BY json_extract(payload, '$.contentTitle')
            ORDER BY count DESC
            LIMIT 10
        `
            )
            .all();

        // Recent errors
        const recentErrors = db
            .prepare(
                `
            SELECT timestamp, json_extract(payload, '$.errorType') as errorType, json_extract(payload, '$.errorMessage') as errorMessage
            FROM events
            WHERE event_type = 'error'
            ORDER BY timestamp DESC
            LIMIT 20
        `
            )
            .all();

        res.render('admin/analytics', {
            totalEvents: totalEvents.count || 0,
            totalPlays: totalPlays.count || 0,
            totalErrors: totalErrors.count || 0,
            totalDeepLinks: totalDeepLinks.count || 0,
            topVideos,
            recentErrors
        });
    } catch (err) {
        console.error('[Admin] Analytics error:', err.message);
        req.flash('error', 'Failed to load analytics.');
        res.redirect('/admin');
    }
});

// ============================================================
// Helpers
// ============================================================

/** Get disk usage for the server directory - native implementation, no execSync (Fix vuln-0009) */
async function getDiskUsage() {
    try {
        // Use Node.js built-in fs.statfs on Linux/macOS
        if (process.platform === 'linux' || process.platform === 'darwin') {
            const stats = fs.statfsSync('/');
            const total = stats.blocks * stats.bsize;
            const free = stats.bfree * stats.bsize;
            const avail = stats.bavail * stats.bsize;
            const used = total - free;

            return {
                total: formatBytes(total),
                used: formatBytes(used),
                available: formatBytes(avail),
                usePercent: ((used / total) * 100).toFixed(1) + '%'
            };
        } else {
            // Windows fallback - use built-in os.freemem/os.totalmem for disk approximation
            const total = os.totalmem();
            const free = os.freemem();
            const used = total - free;
            return {
                total: formatBytes(total),
                used: formatBytes(used),
                available: formatBytes(free),
                usePercent: ((used / total) * 100).toFixed(1) + '%'
            };
        }
    } catch (err) {
        console.error('[Admin] getDiskUsage failed:', err.message);
        return null;
    }
}

/** Format bytes to human-readable string */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/** Get analytics database file size */
async function getDbSize() {
    try {
        const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'analytics.db');
        if (await fs.pathExists(dbPath)) {
            const stats = await fs.stat(dbPath);
            return `${(stats.size / 1024).toFixed(1)} KB`;
        }
        return 'N/A';
    } catch (err) {
        console.error('[Admin] getDbSize failed:', err.message);
        return 'N/A';
    }
}

/** Get video duration using ffprobe with timeout */
function getVideoDuration(filePath) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve(0); // Timeout - assume 0 duration
        }, 10000);

        ffmpeg.ffprobe(filePath, (err, metadata) => {
            clearTimeout(timeout);
            if (err || !metadata || !metadata.format) {
                resolve(0);
                return;
            }
            resolve(Math.round(metadata.format.duration || 0));
        });
    });
}

/** Extract a human-readable title from a filename */
function extractTitleFromFilename(filename) {
    const base = path.basename(filename, path.extname(filename));
    return base.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** GET /admin/audit-log - View audit log */
router.get('/audit-log', async (req, res) => {
    try {
        const entries = auditLog.getEntries(100);
        res.render('admin/auditLog', { entries });
    } catch (err) {
        console.error('[Admin] Audit log error:', err.message);
        req.flash('error', 'Failed to load audit log.');
        res.redirect('/admin');
    }
});

/** POST /admin/audit-log/clear - Clear audit log */
router.post('/audit-log/clear', adminRouteRateLimit, authMiddleware.requireAuthAndCsrf, (req, res) => {
    try {
        auditLog.clearEntries();
        auditLog.logEvent('audit_log_cleared', {}, req);
        req.flash('success', 'Audit log cleared.');
        res.redirect('/admin/audit-log');
    } catch (err) {
        console.error('[Admin] Clear audit log error:', err.message);
        req.flash('error', 'Failed to clear audit log.');
        res.redirect('/admin/audit-log');
    }
});

/** GET /admin/settings - Settings page */
router.get('/settings', (req, res) => {
    const hasPassword = adminAuth.loadPasswordHash() !== '';
    res.render('admin/settings', { hasPassword });
});

/** POST /admin/settings/password - Change password */
const passwordChangeRateLimit = getRateLimitMiddleware(10, 60000, 'password-change');
router.post('/settings/password', authMiddleware.requireAuthAndCsrf, passwordChangeRateLimit, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;

        // If no password is set yet, currentPassword can be empty
        const hash = adminAuth.loadPasswordHash();
        if (hash && !currentPassword) {
            req.flash('error', 'Current password is required.');
            return res.redirect('/admin/settings');
        }

        // Verify current password if one exists
        if (hash && !adminAuth.verifyPassword(currentPassword, hash)) {
            req.flash('error', 'Current password is incorrect.');
            return res.redirect('/admin/settings');
        }

        // Validate new password
        if (!newPassword || newPassword.length < 8) {
            req.flash('error', 'New password must be at least 8 characters long.');
            return res.redirect('/admin/settings');
        }

        if (newPassword !== confirmPassword) {
            req.flash('error', 'New passwords do not match.');
            return res.redirect('/admin/settings');
        }

        // Generate new hash and save
        const newHash = adminAuth.hashPassword(newPassword);
        const hashFile = path.join(__dirname, '..', '.admin_password_hash');
        const tmpPath = hashFile + '.tmp';
        fs.writeFileSync(tmpPath, newHash, 'utf8');
        fs.renameSync(tmpPath, hashFile);

        auditLog.logEvent('password_change', {}, req);
        req.flash('success', 'Password updated successfully.');
        res.redirect('/admin/settings');
    } catch (err) {
        console.error('[Admin] Password change error:', err.message);
        req.flash('error', 'Failed to update password.');
        res.redirect('/admin/settings');
    }
});

/**
 * The admin upload path had no error surface: a body over the configured ceiling made Multer raise
 * `LIMIT_FILE_SIZE`, there is no error middleware on this router (only `routes/v2.js` has one), so Express' default
 * answered a 500 with a stack trace to an operator who had simply picked a large file - and the page that told them
 * to do it said 2 GB. Recognised upload-limit failures become a sentence naming the limit and the machine-readable
 * code; everything else keeps travelling to the default handler unchanged, because this is not a place to swallow
 * errors it does not understand.
 */
router.use(function uploadErrorSurface(err, req, res, next) {
    if (!err || err.name !== 'MulterError') return next(err);
    const isThumbnail = String(err.field || '').startsWith('thumbnail');
    const limit = isThumbnail ? thumbnailMaxBytes() : videoMaxBytes();
    const envName = isThumbnail ? 'CTV_MAX_THUMBNAIL_BYTES' : 'CTV_MAX_VIDEO_BYTES';
    const message =
        err.code === 'LIMIT_FILE_SIZE'
            ? `Upload refused: "${err.field}" is larger than the ${humanBytes(limit)} limit on this server (${envName}; LIMIT_FILE_SIZE).`
            : `Upload refused: ${err.code}.`;
    try {
        auditLog.logEvent('upload_refused', { code: err.code, field: err.field || null, limitBytes: limit }, req);
    } catch {}
    req.flash('error', message);
    return res.redirect(isThumbnail ? '/admin/videos' : '/admin/videos/new');
});

module.exports = router;
// Test seam (2026-11-09): the ordering of "a refused upload is discarded" against "the refusal is
// answered" is the whole reason the middleware exists, and it is only checkable if it can be called.
module.exports.__internals = { discardRejectedUpload, inspectUpload, UPLOAD_MIME_KINDS };

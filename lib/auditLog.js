const fs = require('fs-extra');
const path = require('path');

// `initAuditLog` is exported but nothing calls it, so on a fresh install every audit write failed with
// ENOENT (measured 2026-11-08). The directory is therefore ensured in the write path itself, and its
// location is configurable so a container can put the trail on a durable volume.
const LOG_DIR = process.env.CTV_AUDIT_DIR || path.join(__dirname, '..', 'data', 'audit');
const LOG_FILE = path.join(LOG_DIR, 'audit.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 5;

/**
 * Initialize audit log directory.
 */
function initAuditLog() {
    try {
        fs.ensureDirSync(LOG_DIR);
    } catch (e) {
        console.error('[AuditLog] Failed to create audit log directory:', e.message);
    }
}

/**
 * Rotate log file if it exceeds MAX_LOG_SIZE.
 */
function rotateLog() {
    try {
        if (!fs.existsSync(LOG_FILE)) return;

        const stats = fs.statSync(LOG_FILE);
        if (stats.size < MAX_LOG_SIZE) return;

        // Rotate: audit.log → audit.log.1 → audit.log.2, etc.
        for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
            const src = `${LOG_FILE}.${i}`;
            const dst = `${LOG_FILE}.${i + 1}`;
            if (fs.existsSync(src)) {
                if (i >= MAX_LOG_FILES) {
                    fs.rmSync(src); // Remove oldest
                } else {
                    fs.moveSync(src, dst, { overwrite: true });
                }
            }
        }

        fs.moveSync(LOG_FILE, `${LOG_FILE}.1`, { overwrite: true });
    } catch (e) {
        console.error('[AuditLog] Rotation failed:', e.message);
    }
}

/**
 * Log an audit event.
 * @param {string} action - Action type (login_success, login_fail, config_change, video_upload, etc.)
 * @param {object} details - Event details
 * @param {object} req - Express request object (for IP, user agent)
 */
function logEvent(action, details, req = null) {
    try {
        fs.ensureDirSync(LOG_DIR);
        rotateLog();

        const entry = {
            timestamp: new Date().toISOString(),
            action,
            details,
            ip: req ? req.ip || req.connection?.remoteAddress || 'unknown' : 'cli',
            userAgent: req ? (req.headers['user-agent'] || 'unknown').substring(0, 200) : 'cli'
        };

        const line = JSON.stringify(entry) + '\n';

        // Append to log file (async - don't block the request)
        fs.appendFile(LOG_FILE, line, (err) => {
            if (err) {
                console.error('[AuditLog] Write failed:', err.message);
            }
        });
    } catch (e) {
        console.error('[AuditLog] Logging failed:', e.message);
    }
}

/**
 * Read audit log entries (most recent first).
 * @param {number} limit - Max entries to return (default 100)
 * @returns {Array} Array of log entry objects
 */
function getEntries(limit = 100) {
    try {
        if (!fs.existsSync(LOG_FILE)) return [];

        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);

        // Return most recent entries first
        const all = lines
            .slice(-limit)
            .reverse()
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch (err) {
                    console.debug('[AuditLog] Skipping malformed log line:', err.message);
                    return null;
                }
            })
            .filter(Boolean);

        return all;
    } catch (e) {
        console.error('[AuditLog] Read failed:', e.message);
        return [];
    }
}

/**
 * Clear audit log entries.
 */
function clearEntries() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            fs.rmSync(LOG_FILE);
        }
    } catch (e) {
        console.error('[AuditLog] Clear failed:', e.message);
    }
}

module.exports = {
    initAuditLog,
    logEvent,
    getEntries,
    clearEntries
};

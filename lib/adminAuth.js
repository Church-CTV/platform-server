const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');

const SALT_ROUNDS = 12;

// In-memory login attempt tracking (persists across requests in same process)
const loginAttempts = new Map();
const CLEANUP_INTERVAL = 60 * 1000; // clean up every minute

/**
 * Clean up expired entries from login attempts map.
 * Runs automatically every minute and unrefs the timer.
 */
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of loginAttempts.entries()) {
        if (now - data.firstAttempt > 15 * 60 * 1000) {
            // Expired after 15 minutes
            loginAttempts.delete(key);
        }
    }
}, CLEANUP_INTERVAL).unref();

/**
 * Check if an IP is locked out due to too many failed login attempts.
 * Returns { locked: boolean, retryAfterMs: number }
 */
function checkLoginLockout(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);

    if (!entry) return { locked: false, retryAfterMs: 0 };

    // Check if total attempts exceed max before considering lockout
    if (entry.totalAttempts < 5) return { locked: false, retryAfterMs: 0 };

    // Calculate backoff delay based on consecutive failures
    const baseDelay = 2000; // 2 seconds
    const delay = Math.min(baseDelay * Math.pow(2, entry.consecutiveFailures - 1), 30000); // max 30s

    const timeSinceFirstAttempt = now - entry.firstAttempt;
    if (timeSinceFirstAttempt < delay) {
        return { locked: true, retryAfterMs: delay - timeSinceFirstAttempt };
    }

    // Lockout window expired - reset consecutive count but keep total
    entry.consecutiveFailures = Math.max(1, entry.consecutiveFailures - 1);
    entry.firstAttempt = now;

    return { locked: false, retryAfterMs: 0 };
}

/**
 * Record a failed login attempt for an IP.
 */
function recordFailedLogin(ip) {
    const now = Date.now();
    let entry = loginAttempts.get(ip);

    if (!entry) {
        entry = { firstAttempt: now, consecutiveFailures: 0, totalAttempts: 0 };
    }

    entry.consecutiveFailures++;
    entry.totalAttempts++;
    loginAttempts.set(ip, entry);
}

/**
 * Reset login attempts on successful login.
 */
function resetLoginAttempts(ip) {
    loginAttempts.delete(ip);
}

/**
 * Validate password strength.
 * Returns { valid: boolean, reason: string }
 */
function validatePasswordStrength(password) {
    if (!password || typeof password !== 'string') {
        return { valid: false, reason: 'Password is required' };
    }

    if (password.length < 8) {
        return { valid: false, reason: 'Password must be at least 8 characters' };
    }

    // Check for common weak patterns
    const commonPasswords = [
        'password',
        '12345678',
        'qwerty12',
        'admin',
        'letmein',
        'welcome',
        'monkey',
        'dragon',
        'master',
        'login',
        'abc12345',
        '1234567890',
        'password1',
        'iloveyou'
    ];

    if (commonPasswords.includes(password.toLowerCase())) {
        return { valid: false, reason: 'Password is too common - choose something unique' };
    }

    // Check for repetitive characters (e.g., "aaaaaa")
    if (/^(.)\1{7,}$/.test(password)) {
        return { valid: false, reason: 'Password contains too many repeated characters' };
    }

    // Check for sequential numbers/letters (e.g., "12345678", "abcdefgh")
    const hasSequential = /^(?:0123456789|abcdefghijklmnopqrstuvwxyz|qwertyuiop|asdfghjkl|zxcvbnm){1,}$/i.test(
        password.replace(/[^a-z0-9]/gi, '')
    );
    if (hasSequential && password.length >= 8) {
        return { valid: false, reason: 'Password contains sequential characters' };
    }

    return { valid: true, reason: '' };
}

/**
 * Hash a password with bcrypt.
 */
function hashPassword(plain) {
    return bcrypt.hashSync(plain, SALT_ROUNDS);
}

/**
 * Verify a password against a bcrypt hash.
 */
function verifyPassword(plain, hashed) {
    try {
        return bcrypt.compareSync(plain, hashed);
    } catch (e) {
        // Hash might be corrupted - return false to avoid errors
        console.error('[AdminAuth] Password verification error:', e.message);
        return false;
    }
}

/**
 * Generate a CSRF token.
 */
function generateCsrfToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate a CSRF token against the expected value.
 */
function validateCsrfToken(token, expected) {
    if (typeof token !== 'string' || typeof expected !== 'string') return false;
    // Shape before comparison, on purpose (2026-11-09). The old body went straight to
    // `crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))`, and both halves of that
    // are fail-open on malformed input: `Buffer.from(x, 'hex')` stops at the first non-hex character without
    // saying so, so `<real-token>x` decoded to exactly the expected bytes and was ACCEPTED; and when the decoded
    // lengths differ, `timingSafeEqual` throws a RangeError instead of returning false, so a truncated or
    // odd-length token answered 500 rather than 403 on every state-changing admin route. A security check that
    // cannot say no is not a check.
    if (!/^[0-9a-f]+$/i.test(token) || !/^[0-9a-f]+$/i.test(expected)) return false;
    if (token.length !== expected.length) return false;
    // Constant-time comparison, only once the shapes are known to match.
    return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Get the IP address from a request, respecting trusted proxy settings.
 */
function getClientIp(req) {
    const trusted = process.env.TRUST_PROXY === 'true';
    if (trusted && req.headers['x-forwarded-for']) {
        return req.headers['x-forwarded-for'].split(',')[0].trim();
    }
    return req.socket.remoteAddress || req.connection.remoteAddress || 'unknown';
}

/**
 * Format retry-after delay for display.
 */
function formatRetryAfter(ms) {
    if (ms < 1000) return `${Math.ceil(ms / 100)} tenths of a second`;
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return `${seconds} seconds`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Load the admin password hash from file or env.
 * Creates the hash file from env if it doesn't exist yet.
 */
function loadPasswordHash() {
    const hashFile = path.join(__dirname, '..', '.admin_password_hash');
    try {
        if (fs.existsSync(hashFile)) {
            return fs.readFileSync(hashFile, 'utf8').trim();
        }
        if (process.env.ADMIN_PASSWORD) {
            const hash = hashPassword(process.env.ADMIN_PASSWORD);
            const tmpPath = hashFile + '.tmp';
            fs.writeFileSync(tmpPath, hash, 'utf8');
            fs.renameSync(tmpPath, hashFile);
            return hash;
        }
    } catch (e) {
        console.error('[AdminAuth] Failed to load password hash:', e.message);
    }
    return '';
}

/**
 * Which credential this deployment actually accepts, reported rather than assumed.
 *
 * `loadPasswordHash()` prefers `.admin_password_hash` and only falls back to `ADMIN_PASSWORD` when the file
 * is absent - which is correct (the file is written once, from the password the operator chose, and a later
 * edit to a template `.env` must not silently change the door). What was missing was anybody saying so: both
 * production origins were found on 2026-11-10 with `ADMIN_PASSWORD` set in `.env` and a stored hash that does
 * not match it, and the only symptom was an operator concluding their login was broken.
 *
 * Returns `{ source, hashFilePresent, hashFileUsable, envPasswordPresent, envMatchesStored, warning }` - the
 * same six keys in every state, so a caller cannot guess its way past a problem. The warning never contains a
 * password, and this function never writes anything. Cost: when both sources exist it runs one bcrypt compare,
 * measured at ~360-380 ms on this box at the deployment's cost factor of 12 (`verifyPassword` is
 * `compareSync`), and 0-1 ms in every other state. The boot hook in `server.js` runs it after the socket is
 * bound, so the price is one slowed request at startup rather than a refused one.
 */
async function credentialStatus() {
    const hashFile = path.join(__dirname, '..', '.admin_password_hash');
    const envPassword = process.env.ADMIN_PASSWORD || '';
    let stored = '';
    let hashFilePresent = false;
    let hashFileUsable = true;
    try {
        hashFilePresent = fs.existsSync(hashFile);
        if (hashFilePresent) stored = fs.readFileSync(hashFile, 'utf8').trim();
    } catch {
        stored = '';
    }

    // A file that exists and holds nothing is a third state, and the one that hurts: `loadPasswordHash()`
    // returns '' for it, the login compares against an empty hash and accepts nobody, and `ADMIN_PASSWORD`
    // is never consulted because the file is present. Reporting that as `source: 'env'` - which the first
    // version of this function did - sent the operator to the wrong file. And it does not repair itself on
    // the next login: `loadPasswordHash()` writes the file only when it is absent.
    if (hashFilePresent && !stored) hashFileUsable = false;

    const base = { hashFilePresent, hashFileUsable, envPasswordPresent: !!envPassword };

    if (!hashFilePresent && !stored && !envPassword) {
        return { ...base, hashFilePresent: false, source: 'none', envMatchesStored: null, warning: null };
    }
    if (!hashFilePresent) {
        // The first login hashes ADMIN_PASSWORD into the file - the designed first-boot path, and the only
        // moment the environment value becomes the credential.
        return { ...base, source: 'env', envMatchesStored: null, warning: null };
    }
    if (!hashFileUsable) {
        return {
            ...base,
            source: 'hash-file',
            envMatchesStored: null,
            warning:
                'The .admin_password_hash file exists but holds no hash (empty or unreadable), so login accepts nobody. ' +
                'ADMIN_PASSWORD is not consulted while the file is present. Replace the file, or remove it and let the ' +
                'first login recreate it; neither action prints a password.'
        };
    }
    if (!envPassword) {
        return { ...base, source: 'hash-file', envMatchesStored: null, warning: null };
    }

    let matches = false;
    try {
        matches = await verifyPassword(envPassword, stored);
    } catch {
        matches = false;
    }
    if (matches) {
        return { ...base, source: 'hash-file', envMatchesStored: true, warning: null };
    }
    return {
        ...base,
        source: 'hash-file',
        envMatchesStored: false,
        warning:
            'ADMIN_PASSWORD is set but does not match the stored .admin_password_hash; login uses the stored hash. ' +
            'Remove the environment value or replace the hash file - printing neither.'
    };
}

module.exports = {
    checkLoginLockout,
    recordFailedLogin,
    resetLoginAttempts,
    validatePasswordStrength,
    hashPassword,
    verifyPassword,
    loadPasswordHash,
    credentialStatus,
    generateCsrfToken,
    validateCsrfToken,
    getClientIp,
    formatRetryAfter
};

/**
 * HTML Sanitizer - prevents XSS by properly escaping content for different contexts.
 * Fix vuln-0006: Stored XSS via unescaped EJS template rendering.
 */

const escapeHtmlChars = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
    '`': '&#96;'
};

/**
 * Escape a string for safe insertion into HTML body content.
 * Covers all HTML special characters including quotes and backticks.
 */
function escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    return str.replace(/[&<>"'`/]/g, (c) => escapeHtmlChars[c]);
}

/**
 * Escape a string for safe insertion inside a JavaScript string literal.
 * This is critical for the CSRF token rendering in layout.ejs where
 * the token was previously placed in a JS context without proper escaping.
 */
function escapeJsString(str) {
    if (typeof str !== 'string') return String(str);
    // Use JSON.stringify which handles all JS string escaping correctly
    return JSON.stringify(str).slice(1, -1); // Remove surrounding quotes
}

/**
 * Sanitize a string for use in an HTML attribute value.
 */
function escapeAttr(str) {
    if (typeof str !== 'string') return String(str);
    return str.replace(/[&<>"']/g, (c) => escapeHtmlChars[c]);
}

/**
 * Validate that a string doesn't contain dangerous patterns.
 * Used as an additional safety net for user-controlled data stored in the database.
 */
function hasDangerousPatterns(str) {
    if (typeof str !== 'string') return false;
    // Check for script tags, event handlers, and JS protocol injection
    return (
        /<script[\s>]/i.test(str) ||
        /javascript\s*:/i.test(str) ||
        /on\w+\s*=/i.test(str) ||
        /expression\s*\(/i.test(str) ||
        /url\s*\(\s*javascript/i.test(str) ||
        /data\s*:\s*text\/html/i.test(str) ||
        /<iframe/i.test(str) ||
        /<object/i.test(str) ||
        /<embed/i.test(str) ||
        /<applet/i.test(str)
    );
}

/**
 * Sanitize flash messages before rendering - strip any HTML/script content.
 */
function sanitizeFlashMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map((msg) => {
        // Strip all HTML tags, leaving only plain text
        const stripped = msg.replace(/<[^>]*>/g, '');
        // Double-escape to ensure safety in EJS <%= %> rendering
        return escapeHtml(stripped);
    });
}

/**
 * Sanitize a video title/description for safe storage and display.
 */
function sanitizeVideoField(value) {
    if (typeof value !== 'string') return '';
    // Strip all HTML tags
    const stripped = value.replace(/<[^>]*>/g, '');
    // Trim whitespace
    return stripped.trim();
}

/**
 * Sanitize config values (channel name, description, etc.) for safe rendering.
 */
function sanitizeConfigValue(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/<[^>]*>/g, '').trim();
}

module.exports = {
    escapeHtml,
    escapeJsString,
    escapeAttr,
    hasDangerousPatterns,
    sanitizeFlashMessages,
    sanitizeVideoField,
    sanitizeConfigValue
};

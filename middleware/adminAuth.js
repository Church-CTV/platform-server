const adminAuth = require('../lib/adminAuth');
const auditLog = require('../lib/auditLog');
const lanRestrictLib = require('./lanRestrict');
const ejs = require('ejs');
const path = require('path');
const { viewsDirectory } = require('../lib/contentRoot');
/**
 * Require authentication for admin routes.
 * Checks session, enforces LAN restriction if configured, and redirects unauthed users.
 */
function requireAuth(req, res, next) {
    // The same policy `middleware/lanRestrict.js` enforces at the router; asked here because this
    // middleware also has to distinguish "not signed in" from "not on the permitted network". Until
    // 2026-11-08 this file carried its own IPv4-only copy of the matcher, with its own IPv6 bypass.
    const allowed = process.env.ALLOWED_NETWORKS;
    if (allowed) {
        const decision = lanRestrictLib.peerAllowed(adminAuth.getClientIp(req), allowed);
        if (!decision.allowed) {
            res.set('X-CTV-Denied', decision.reason);
            if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                return res.status(403).json({ error: 'lan-restricted', ...decision });
            }
            return res
                .status(403)
                .send(`Access denied: only the configured LAN may reach this panel (${decision.reason}).`);
        }
    }

    // Check session authentication
    if (req.session && req.session.adminAuthenticated) {
        return next();
    }

    // Not authenticated - redirect to login or return 401 for XHR/API. The refusal names its reason in a
    // header as well as a status, the way `middleware/lanRestrict.js` already does for its own: until
    // 2026-11-09 a 302 with no reason leaves "you are not signed in" and "you are not on the permitted
    // network" indistinguishable to anything that is not a human reading a page.
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        res.set('X-CTV-Denied', 'auth-required');
        return res.status(401).json({ error: 'Authentication required' });
    }

    // Save the intended URL so we can redirect back after login
    const returnUrl = req.originalUrl;
    if (req.session && returnUrl !== '/admin/login' && returnUrl !== '/admin/logout') {
        req.session.redirectTo = returnUrl;
    }

    res.set('X-CTV-Denied', 'auth-required');
    return res.redirect('/admin/login');
}

/**
 * Gate one operator route on the session, with a single documented way to publish it on purpose.
 *
 * `requireAuth` is the policy; this only answers the question an operator may legitimately flip - is this
 * surface public by decision? - so `ADMIN_DASHBOARD_PUBLIC=true` publishes and anything else (unset, `yes`,
 * `1`, a typo) keeps the login requirement: the default fails closed, per `../CONFIGURATION.md`. It is
 * deliberately an environment knob and not a channel-config key - what an anonymous browser may see is a
 * property of the deployment in front of it, not of a channel, and it has to be readable from the systemd
 * unit or compose file that owns the deployment. The header records the published state on the response,
 * so exposure is checkable with `curl -I` from outside rather than by reading the box.
 */
function authUnlessFlagged(flagName) {
    return function operatorSurfaceAuth(req, res, next) {
        if (process.env[flagName] === 'true') {
            res.set('X-CTV-Dashboard', 'public-by-flag');
            return next();
        }
        return requireAuth(req, res, next);
    };
}

/**
 * Require authentication AND CSRF token for state-changing requests.
 */
function requireAuthAndCsrf(req, res, next) {
    // First check auth
    if (!req.session || !req.session.adminAuthenticated) {
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return res.redirect('/admin/login');
    }

    // Then check CSRF for non-GET/HEAD/OPTIONS requests
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        const csrfToken = req.body._csrf || req.headers['x-csrf-token'];
        const expectedCsrf = req.session.csrfToken;

        if (!csrfToken || !adminAuth.validateCsrfToken(csrfToken, expectedCsrf)) {
            auditLog.logEvent(
                'csrf_failure',
                {
                    path: req.originalUrl,
                    method: req.method
                },
                req
            );
            return res.status(403).json({ error: 'Invalid CSRF token' });
        }
    }

    next();
}

/**
 * Middleware to ensure admin page rendering has required context.
 * Renders the layout with sidebar nav, CSRF token, and user info.
 */
function renderAdmin(req, res, next) {
    if (!req.session || !req.session.adminAuthenticated) {
        return next();
    }

    // Ensure CSRF token exists in session
    if (!req.session.csrfToken) {
        req.session.csrfToken = adminAuth.generateCsrfToken();
    }

    // Add helper to all render calls.
    //
    // `views/layout.ejs` prints the page inside `<%- body %>`, so a caller's view has to reach the layout as
    // a rendered string. It used to be `body: locals.body || ''` while no route supplied `body`, so every
    // signed-in screen rendered the chrome around an empty box (measured 2026-11-08: 200, 21,795 bytes, no
    // form, no table, no Save button - and no `_csrf` field for a form that was never drawn). The view file
    // is rendered first and only then handed to the layout.
    const originalRender = res.render.bind(res);
    res.render = function (view, locals = {}, callback) {
        const isAdminView = view.startsWith('admin/') || view === 'layout';

        if (isAdminView) {
            const shared = {
                title: getPageTitle(view),
                currentView: getCurrentView(view),
                csrfToken: req.session.csrfToken,
                flashErrors: req.flashErrors || [],
                flashSuccesses: req.flashSuccesses || [],
                ...locals
            };
            if (view === 'layout') return originalRender('layout', shared, callback);
            const viewPath = path.join(viewsDirectory(), `${view}.ejs`);
            return ejs
                .renderFile(viewPath, { ...res.locals, ...shared })
                .then((body) => originalRender('layout', { ...shared, body }, callback))
                .catch((err) => {
                    console.error(`[Admin] Failed to render ${view}:`, err.message);
                    if (typeof callback === 'function') return callback(err);
                    return next(err);
                });
        }
        return originalRender(view, locals, callback);
    };

    next();
}

/** Get page title from view path */
function getPageTitle(view) {
    const titles = {
        'admin/dashboard': 'Dashboard',
        'admin/videos': 'Videos',
        'admin/upload': 'Upload Video',
        'admin/editVideo': 'Edit Video',
        'admin/config': 'Configuration',
        'admin/feed': 'Feed Management',
        'admin/analytics': 'Analytics',
        'admin/auditLog': 'Audit Log',
        'admin/settings': 'Settings'
    };
    return titles[view] || 'Admin';
}

/** Get currentView for sidebar highlighting */
function getCurrentView(view) {
    const views = {
        'admin/dashboard': 'dashboard',
        'admin/videos': 'videos',
        'admin/upload': 'upload',
        'admin/editVideo': 'videos',
        'admin/config': 'config',
        'admin/feed': 'feed',
        'admin/analytics': 'analytics',
        'admin/auditLog': 'audit-log',
        'admin/settings': 'settings'
    };
    return views[view] || 'dashboard';
}

/**
 * Flash message middleware.
 * Stores messages in session and removes them after one request.
 */
function flashMiddleware(req, res, next) {
    // Get flash messages from previous request
    const errors = req.session.flashErrors || [];
    const successes = req.session.flashSuccesses || [];

    // Clear flash data for this request (will be set again if needed)
    req.session.flashErrors = undefined;
    req.session.flashSuccesses = undefined;

    req.flash = function (type, message) {
        if (!req.session) req.session = {};
        const key = type === 'error' ? 'flashErrors' : 'flashSuccesses';
        if (!req.session[key]) req.session[key] = [];
        req.session[key].push(message);
    };

    req.flashErrors = errors;
    req.flashSuccesses = successes;

    next();
}

module.exports = {
    requireAuth,
    requireAuthAndCsrf,
    authUnlessFlagged,
    renderAdmin,
    flashMiddleware
};

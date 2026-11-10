/**
 * Fail-closed freshness default (`CACHE-9`, design `CACHE-DESIGN-2026-11-09.md`).
 *
 * Every response that no route gave a policy to gets the table's default, which is `no-store`. That is the
 * project's fail-closed rule applied to caching: a new route cannot become cacheable by accident, an error
 * page is never cached, and an operator surface cannot be cached by a browser that happened to like the
 * response. Measured on the live origins 2026-11-09: not one feed or config path sent `Cache-Control` at
 * all, so every strict client was left on heuristic freshness - which is not a policy, it is a guess.
 *
 * Patched at `writeHead` rather than at `finish`, because by `finish` the headers are already on the wire.
 * Node's implicit header path (`_implicitHeader`) and Express' `res.send`/`res.json` both go through it, so
 * nothing escapes: a route that never sets a header still gets one.
 */

const { policyFor, addOrgVary } = require('../lib/httpCache');

module.exports = function defaultFreshness(req, res, next) {
    // The path the request ARRIVED with, captured now. The v2 router forwards some endpoints by rewriting
    // `req.url` onto a legacy handler (`routes/v2.js` does it for `/search`), so by the time headers are being
    // written `req.path` can name an internal route rather than the public one. A cache policy is a statement
    // to the client and to any shared cache about *that* path, so an internal forward must not be able to
    // change it. Measured on the stage 2026-11-10: `/api/v2/search` was answering `public, no-cache` for
    // exactly this reason, on a path the design says must never be stored.
    const arrivedPath = req.path;
    const original = res.writeHead.bind(res);
    res.writeHead = function writeHeadWithPolicy(statusArg, ...rest) {
        if (!res.getHeader('Cache-Control')) {
            // A 404/500 is never cacheable whatever the table says about the path: the answer "there is no
            // such feed" is not a representation of content, and caching one keeps a fixed channel dead.
            const status = Number(statusArg) || res.statusCode;
            const policy = status >= 400 ? 'no-store' : policyFor(arrivedPath);
            res.setHeader('Cache-Control', policy);
            // `CACHE-6`: anything a cache is allowed to hold must name the organization whose bytes they are.
            // A `no-store` answer needs no cache key, so the header is added where it can actually be read.
            if (policy.startsWith('public')) addOrgVary(res);
        }
        return original(statusArg, ...rest);
    };
    next();
};

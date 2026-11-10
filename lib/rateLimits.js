/**
 * One place to read the request budgets, so `/feed`, `/search`, `/analytics` and `/live` cannot drift
 * apart and an operator moves one number, not four.
 *
 * Shared proxies can make monitoring and viewers consume the same budget. Tune these defaults
 * for the deployment rather than treating them as capacity guarantees.
 *
 * `TRUST_PROXY` decides whose budget is whose: unset, the proxy's address is the key (fail-closed -
 * a direct client cannot forge its way past the limit); set, the forwarded address is.
 */

// `heartbeat` gets its own budget rather than sharing `analytics`: a device pings the health route
// on a timer, and that timer must not be able to starve the events the same device sends.
const DEFAULT_RATE_LIMITS = { feed: 300, search: 120, analytics: 300, heartbeat: 300, live: 60 };

function rateLimitValue(name) {
    const fallback = DEFAULT_RATE_LIMITS[name];
    if (fallback === undefined) throw new Error(`unknown-rate-limit:${name}`);
    const raw = process.env['CTV_RATE_LIMIT_' + name.toUpperCase()];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        // Fail towards the measured default rather than towards an unbounded endpoint, and say so: a
        // typo in an operator's budget must not quietly remove the budget.
        console.warn(`[RateLimit] ignoring CTV_RATE_LIMIT_${name.toUpperCase()}="${raw}", using ${fallback}`);
        return fallback;
    }
    return parsed;
}

module.exports = { DEFAULT_RATE_LIMITS, rateLimitValue };

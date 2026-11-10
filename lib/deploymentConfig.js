/**
 * The configuration this deployment owns - the server profile's `clientConfig` and the operator store the admin
 * panel writes - and nothing else (2026-11-10).
 *
 * `lib/effectiveConfig.js` resolves the full picture for a client: the `config` block embedded in a published
 * feed, then the profile, then the operator store. That order is right for what a television renders. It is the
 * wrong order for the HTTP cache's freshness policy, because a policy living inside a published document cannot
 * be changed without republishing the document - the exact release bug `CACHE-DESIGN-2026-11-09.md` was written
 * to close. So freshness is read from these layers only, which means an operator who sets it in the panel is
 * answered by `/feed` on the next request, with no feed rebuild and no restart.
 *
 * Reading two small JSON files per request is not free, so the value is memoized against the same content
 * fingerprint the rest of the cache layer uses: an admin save rewrites the store file, the fingerprint moves,
 * and the next request rebuilds. A restart is not needed for a policy release, and neither is a poll timer.
 */

const { memoized, fingerprintFiles } = require('./httpCache');
const { resolve: resolveEffectiveConfig, normalizeEndpoints } = require('./effectiveConfig');

/**
 * Effective config from the deployment layers, or `{}` when there is nothing to read. Fail-closed: an
 * unreadable or invalid layer yields no freshness value, and `httpCache.feedPolicy({})` answers
 * `public, no-cache` - the safe answer is always to revalidate.
 */
function deploymentConfig() {
    const profilePath = process.env.CTV_SERVER_PROFILE;
    const storePath = process.env.CTV_CHANNEL_CONFIG;
    const { value } = memoized('deployment-config', fingerprintFiles(profilePath, storePath), () => {
        try {
            const resolved = resolveEffectiveConfig({
                base: undefined,
                profilePath,
                storePath,
                repair: (config) => normalizeEndpoints(config, process.env.URL)
            });
            return resolved.config || {};
        } catch {
            // A config the contract refuses must not change what is cached, and must not become a 500 on
            // a path a television polls. `feedPolicy({})` is the fail-closed answer.
            return {};
        }
    });
    return value;
}

module.exports = { deploymentConfig };

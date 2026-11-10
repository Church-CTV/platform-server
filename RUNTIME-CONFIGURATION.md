# Configuration and secret placement

There are three different kinds of value. Do not confuse them.

1. **Public client configuration:** channel name, public service origin, store app
   identifier, artwork references and feature flags. These can use versioned
   profiles or Actions variables. Once packaged in a TV application they are
   discoverable; a build variable cannot make them secret.
2. **Private operational settings:** deployment hosts, SSH account names and
   internal topology. Keep them out of source. If a future deployment workflow
   needs them and their disclosure is sensitive, use protected environment
   secrets, not variables. No production deployment workflow is enabled here.
3. **Credentials:** passwords, API tokens, session secrets, private keys, signing
   certificates/passwords and webhooks. Use Actions secrets only when CI needs
   them, and ignored local files or a runtime secret store otherwise. Never place
   server credentials in client profiles, bundles, logs, build artifacts or
   GitHub variables. Never use a broad personal access token for ordinary CI.

Examples must be blank or synthetic. Operators create fresh per-installation
credentials; no shared default password is provided. A failed configuration
validation must not silently activate an old customer's endpoint.

Production values are intentionally not migrated from private repositories by
this source-preparation task. Configuring live deployments, rotating credentials,
changing signing identities and production cutover are separately authorized
operations. See each platform README for the implemented variable names and
unverified build/store prerequisites.

# CTV platform server

Permissions, commercial licensing, sales and support: see [SUPPORT.md](SUPPORT.md).

Node.js service for a configurable TV channel feed, streaming, analytics and an operator interface. This is a public-source candidate, not a deployment-ready distribution. It does not include media, customer configurations, credentials, store signing material or the original operations and deployment tooling. The separately included Python stream-relay directory is not part of the Node setup below.

## Local setup

Use Node.js 22.12 or newer, npm, and a compiler toolchain (Python 3, make and a C/C++ compiler) for the SQLite native dependency. FFmpeg/ffprobe are needed for video metadata and thumbnail generation. No password is supplied by default.

```sh
cp .env.example .env
mkdir -p data/{videos,images,output,uploads,audit}
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Run the random-value command separately for each secret. Put a strong unique value in `ADMIN_PASSWORD` and a different value in `SESSION_SECRET` in `.env`; set `ANALYTICS_API_KEY` if API authentication must survive restarts. Never commit `.env`. Then run:

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm start
```

Open `http://localhost:3000/health` or `/admin`. The application initializes a local configuration from `config.template.json` if none exists. No sample feed or media is supplied; configure content and provide a feed before expecting playback. Existing `.admin_password_hash` takes precedence over `ADMIN_PASSWORD`; changing the environment variable alone does not rotate an existing stored password.

## Local containers

With Docker Compose installed, create `.env` as above, then run `docker compose up --build`. Port 3000 is published on loopback only; the named `server-data` volume holds the database, operator configuration and content directories. The image also contains an ephemeral password hash outside the volume; on recreation the configured password is used again. Container build and Compose have not been verified in this environment because Docker is unavailable. Do not use this example as a production deployment.

## Configuration and secrets

| Input | Purpose |
| --- | --- |
| `URL`, `PORT` | Public base URL and listener port; loopback is for local development. |
| `ADMIN_PASSWORD` | Required at startup; initial admin password. Stored hash, when present, takes precedence. |
| `SESSION_SECRET` | Session signing secret; if omitted, generated at startup and sessions do not survive restart. |
| `ANALYTICS_API_KEY` | API authentication key; if omitted, generated at startup and changes on restart. |
| `STRIPE_WEBHOOK_SECRET` | Isolated experimental billing-test secret only; real payment processing is not supplied. |
| `ENABLE_EXPERIMENTAL_BILLING` | Defaults off. The stub is accessible only when this is `true` AND `NODE_ENV=test`; production remains blocked even when the flag is set. |
| `YOUTUBE_API_KEY`, `YOUTUBE_CHANNEL_HANDLE` | Optional metadata lookup; omit the key to avoid YouTube API requests. |
| `CTV_SERVER_PROFILE` | Optional versioned JSON deployment profile; profile paths must exist. |
| `CTV_CHANNEL_CONFIG` | Path to the writable operator configuration; defaults to `config.json`. |
| `DB_PATH`, `CTV_VIDEOS_DIR`, `CTV_IMAGES_DIR`, `CTV_FEED_OUTPUT_DIR`, `CTV_UPLOADS_DIR`, `CTV_AUDIT_DIR` | Runtime database, content and writable state locations. |
| `CORS_ORIGINS` | Comma-separated allowed browser origins; defaults to localhost and 127.0.0.1 on port 3000. |
| `CTV_TELEMETRY_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` | Both `true` and an explicit collector endpoint are required for OpenTelemetry export; disabled by default. |
| `ALLOWED_NETWORKS`, `TRUST_PROXY`, `STRIKESAFE`, `FORCE_HTTPS` | Deployment security controls; review proxy trust and access policy before any exposure. An unset network allowlist is not a WAN access restriction. |

Configuration inputs and schema behavior are implemented in `lib/serverProfile.js`, `lib/effectiveConfig.js`, `lib/configStore.js` and `schemas/`. `config.template.json` is an illustrative starting point, not a production channel. Protect the database, media, configuration, logs, hashes and backups as potentially sensitive data.

## Checks and limitations

`npm test` runs Node unit tests; `npm run test:client` and `npm run test:integration:isolated` exercise local mock servers. `npm run test:all` runs these in sequence. The isolated tests use local ports and temporary state; do not point overrides at a real server. The old Python feed-generator tooling/tests, customer assets, operational workflows and deployments are omitted. Some integration debt is recorded in `tests/integration/unwired.json`.

The admin pages load fonts from Google Fonts and dashboard pages load Chart.js from jsDelivr; browsers make those requests when displaying those pages. Optional YouTube metadata and explicitly configured telemetry can also reach external services. Billing remains a nonfunctional payment stub with known identity/privacy defects. Its checkout, subscription and webhook routes return `503 experimental_billing_disabled` outside explicitly opted-in test environments. Do not set production deployments to test mode or supply real subscriber/payment data. Third-party packages and external content require dependency, license, privacy and security review. Publication and deployment remain blocked until rights and those reviews are resolved.

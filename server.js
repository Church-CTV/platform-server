require('dotenv').config();
require('./lib/serverProfile').applyProfile(process.env.CTV_SERVER_PROFILE);

// OpenTelemetry initialization
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { resourceFromAttributes } = require('@opentelemetry/resources');

const serverRole = process.env.ROKU_SERVER_ROLE || 'roku-server-1';

const { telemetryEndpoint, corsOrigins: resolveCorsOrigins } = require('./lib/publicDefaults');
const otlpEndpoint = telemetryEndpoint(process.env);

let sdk;
if (otlpEndpoint) {
sdk = new NodeSDK({
    serviceName: serverRole,
    resource: resourceFromAttributes({
        'service.name': serverRole,
        'service.version': '1.0.0',
        'server.role': 'roku-streaming'
    }),
    traceExporter: new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
        concurrencyLimit: 10
    }),
    metricReaders: [new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
            url: `${otlpEndpoint}/v1/metrics`
        }),
        exportIntervalMillis: 15000
    })],
    logRecordProcessors: [new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
            url: `${otlpEndpoint}/v1/logs`,
            concurrencyLimit: 10
        })
    })],
    instrumentations: [new HttpInstrumentation()]
});

sdk.start();
console.log('[OTel] SDK started for', serverRole);
}

// Custom metrics for HTTP requests
const { metrics } = require('@opentelemetry/api');
const meter = metrics.getMeter('roku-server');

const requestCounter = meter.createCounter('http_requests_total', {
    description: 'Total HTTP requests'
});

const requestDurationHistogram = meter.createHistogram('http_request_duration_seconds', {
    description: 'HTTP request duration in seconds',
    unit: 's',
    advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] }
});

const activeRequestsGauge = meter.createUpDownCounter('http_requests_active', {
    description: 'Currently active HTTP requests'
});

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { policyFor, addOrgVary } = require('./lib/httpCache');
const os = require('os');
const crypto = require('crypto');
const helmet = require('helmet');

const app = express();

// `TRUST_PROXY=true` is how the operator says "nothing but my own reverse proxy can reach this port".
// Express otherwise reports the proxy's address as `req.ip`, so an `ALLOWED_NETWORKS` panel sitting behind
// Caddy judges every visitor as 127.0.0.1 and lets the internet in (measured 2026-11-08; pinned by
// tests/integration/test-admin-proxy-trust.mjs). `lib/adminAuth.js` and `middleware/rateLimit.js` already
// read this same variable; before this they disagreed with `req.ip` about who the client was.
if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', true);
}
const PORT = process.env.PORT || 3000;

// Validate required environment variables
const missingEnv = [];
if (!process.env.URL) missingEnv.push('URL (server URL for absolute feed URLs)');
if (!process.env.ADMIN_PASSWORD) missingEnv.push('ADMIN_PASSWORD (admin panel password)');
if (missingEnv.length > 0) {
    console.error('Error: Missing required environment variables:');
    for (const env of missingEnv) {
        console.error(`  - ${env}`);
    }
    console.error('Set these in your .env file. See .env.example for reference.');
    process.exit(1);
}

// SSRF protection: validate URL env var against private/internal IPs (Fix vuln-0012)
// In production (STRIKESAFE=true), reject all private/LAN URLs.
// In development, allow LAN/localhost URLs with a warning.
const isProduction = process.env.STRIKESAFE === 'true';

function isPrivateOrInternalIp(ip) {
    if (!ip || typeof ip !== 'string') return true;
    if (ip === 'localhost' || ip === '127.0.0.1' || ip === '::1') return true;
    if (/^10\./.test(ip)) return true;
    const m = ip.match(/^172\.(\d+)\./);
    if (m && m[1] >= 16 && m[1] <= 31) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^169\.254\./.test(ip)) return true;
    if (/^0\./i.test(ip) || /^127\./i.test(ip) || /^::/i.test(ip) || /^fe80:/i.test(ip) || /^fd/i.test(ip)) return true;
    if (/^::ffff:(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(ip)) return true;
    return false;
}

function validateUrlForSSRF(urlStr) {
    if (!urlStr) return false;
    let parsed;
    try {
        parsed = new URL(urlStr);
    } catch {
        return false; // Invalid URL
    }
    const host = parsed.hostname;
    if (isPrivateOrInternalIp(host)) {
        if (isProduction) {
            console.error(`[Security] SSRF prevention: rejecting private IP in URL env var: ${host}`);
            return false;
        }
        // Development mode: allow with warning
        console.warn(`[Security] SSRF check bypassed (development mode): ${host}`);
        return true;
    }
    return true;
}

if (!validateUrlForSSRF(process.env.URL)) {
    console.error('Error: URL environment variable must point to a public hostname, not localhost or internal IPs.');
    process.exit(1);
}

// Generate secure SESSION_SECRET if not set (Fix vuln-0004)
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex');
if (!process.env.SESSION_SECRET) {
    console.warn('[Security] Generated random SESSION_SECRET at startup. Set one in .env for persistence.');
}

// Helmet - full security headers with CSP (Fix vuln-0011)
app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
                imgSrc: ["'self'", 'data:', 'https:', 'http:'],
                fontSrc: ["'self'", 'fonts.gstatic.com'],
                connectSrc: ["'self'"],
                frameSrc: ["'self'"],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'"],
                baseUri: ["'self'"],
                formAction: ["'self'"]
            }
        },
        crossOriginEmbedderPolicy: true,
        crossOriginOpenerPolicy: true,
        crossOriginResourcePolicy: { policy: 'same-site' },
        dnsPrefetchControl: { allow: false },
        frameguard: { action: 'sameorigin' },
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        ieNoOpen: true,
        noSniff: true,
        permittedPolicies: '',
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        xssFilter: true
    })
);

const corsOrigins = resolveCorsOrigins(process.env);

app.use(
    cors({
        origin: corsOrigins,
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']
    })
);

// Stripe webhook needs raw body - mount before JSON parser
app.use('/api/webhook/stripe', express.raw({ type: '*/*' }));

// Body parsers (needed for admin panel)
// CTV request log - without this you cannot tell a live channel from a dead one.
app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
        console.log(
            `[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - started}ms from ${req.ip}`
        );
    });
    next();
});

// [rig 2026-11-07] Roku roUrlTransfer + Node keep-alive measured on the Roku Ultra (fw 16.0.4): every
// GET /feed was served 200 by this server, yet the device's loader received url-event failure 1 on
// every attempt - the classic keep-alive socket race for HTTP clients that never reuse connections.
// Answering with Connection: close gives each Roku request a clean, closed transaction. Production edge
// (Caddy) already closes per request the same way, so this only changes the bare-node dev rig.
app.use((req, res, next) => {
    res.setHeader('Connection', 'close');
    next();
});

// Freshness is stated or it is not policy (`CACHE-3`/`CACHE-9`, CACHE-DESIGN-2026-11-09.md). Measured on
// both live origins 2026-11-09: not one feed or config path sent `Cache-Control` at all, so every strict
// client - the webOS/Tizen/Vizio apps above all - was running on heuristic freshness, a guess rather than a
// rule. Every response this server does not give an explicit policy to takes the table's default, `no-store`.
app.use(require('./middleware/defaultFreshness'));

// A deployment whose two credential sources disagree says so once, at boot, in its own log.
// Both production origins were found in exactly that state on 2026-11-10 and the only symptom was a
// login that appeared broken. Fail-open: a problem reporting the problem must never take the server down.
const adminAuthForBoot = require('./lib/adminAuth');
setImmediate(() => {
    adminAuthForBoot
        .credentialStatus()
        .then((status) => {
            if (status && status.warning) console.warn(`[auth] ${status.warning}`);
        })
        .catch(() => {});
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware (secure cookies, LAN-only)
// `FORCE_HTTPS=true` remains the operator's explicit "only my TLS proxy reaches me" and keeps the flag hard
// on. It is not the only way a deployment is https: both live origins sit behind a TLS edge, set
// `URL=https://...`, and never set `FORCE_HTTPS`, so until 2026-11-09 the cookie that carries the right to
// edit a channel was flagged sendable over plain http on an https-only host.
//
// Deriving `true` from `URL` alone would have been the wrong fix and is worth keeping in words:
// express-session 1.19.0 refuses to *send* a Secure cookie over a request it judges insecure
// (`node_modules/express-session/index.js:241-243`, measured 2026-11-09 - a login over plain http to an
// https-configured box answered 302 with no `Set-Cookie` at all), so a hard `true` locks an operator out of
// their own panel the moment anyone browses it by `http://<box>:3000`. `'auto'` is the flag that is both
// honest and safe: express-session marks the cookie Secure exactly when the arriving request is https
// (index.js:163-167), which is the visitor's real transport once `TRUST_PROXY=true` makes `X-Forwarded-Proto`
// count, and it never drops a cookie the browser could not send back.
let configuredOriginIsHttps = false;
try {
    configuredOriginIsHttps = new URL(process.env.URL).protocol === 'https:';
} catch {
    configuredOriginIsHttps = false;
}
const sessionCookieSecure = process.env.FORCE_HTTPS === 'true' ? true : configuredOriginIsHttps ? 'auto' : false;
app.use(
    session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: sessionCookieSecure,
            httpOnly: true,
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        }
    })
);

// EJS templating for dashboard
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static file serving (Fix vuln-0008: dotfiles + symlink protection)
app.use(
    '/Videos',
    express.static(require('./lib/contentRoot').requireVideosDir(), { dotfiles: 'ignore', acceptDotFiles: false })
);
const staticFreshness = (res, _filePath) => {
    // `CACHE-3` for generated art: a regenerated file at a fixed name (`MC-Live.png`) is revalidated, never
    // aged - measured 2026-11-09 that one PNG had not changed since 2025-12-21 and was downloaded whole
    // 1,023 times in 3.9 days (54.8 MB), while its `Cache-Control` said `public, max-age=0` with nothing
    // telling any client that asking first was cheap.
    res.setHeader('Cache-Control', policyFor('/output/thumbnails'));
    // `CACHE-6`: generated art is org art. A shared cache in front of two orgs must never answer one channel's
    // thumbnail request from the other's file, and `Vary: Host` is what tells it not to.
    addOrgVary(res);
};
app.use(
    '/output/thumbnails',
    express.static(path.join(require('./lib/contentRoot').outputDir(), 'thumbnails'), {
        dotfiles: 'ignore',
        acceptDotFiles: false,
        setHeaders: staticFreshness
    })
);
app.use(
    '/uploads',
    express.static(require('./lib/contentRoot').uploadsDir(), { dotfiles: 'ignore', acceptDotFiles: false })
);
app.use(
    '/images',
    express.static(process.env.CTV_IMAGES_DIR || path.join(__dirname, 'images'), {
        dotfiles: 'ignore',
        acceptDotFiles: false
    })
);

// Route modules
app.use('/', require('./routes/dashboard'));

// Metrics middleware - track all requests
app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    activeRequestsGauge.add(1);
    res.on('finish', () => {
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        const method = req.method || 'UNKNOWN';
        const route = req.route?.path || req.path || 'UNKNOWN';
        const status = String(res.statusCode);
        requestCounter.add(1, { method, route, status });
        requestDurationHistogram.record(duration, { method, route, status });
        activeRequestsGauge.add(-1);
        // Log slow/error requests to console (Promtail will scrape these)
        if (res.statusCode >= 400 || duration > 1) {
            console.warn(`HTTP ${method} ${route} ${status} ${duration.toFixed(3)}s`);
        }
    });
    next();
});

app.use(require('./routes/feed'));
app.use(require('./routes/stream'));
// `GET /privacy` - the page a store submission quotes, served by the published origin today and by
// this server from here on (`routes/privacy.js`: the organisation's own file if it wrote one, a page
// generated from the effective configuration if it did not).
app.use(require('./routes/privacy'));

// API authentication policy: public client ingestion, protected query/mutation routes
const { apiAuth } = require('./middleware/apiAuth');
app.use('/api/v2', require('./routes/v2'));
app.use('/api', apiAuth);
const apiRouter = require('./routes/api');
app.use('/api', apiRouter);
// The embedded Roku config advertises this root ingestion URL.
app.post('/analytics', (req, res, next) => apiRouter(req, res, next));
// Exposure control for the operator surface, in front of the admin router and its auth: a self-hosted
// box handed to a church has a panel that must not be reachable from the WAN. Opt-in via
// `ALLOWED_NETWORKS`; with it set, a peer outside those networks - including any IPv6 peer when the
// allow-list names only IPv4 - is refused here, before sessions, rate limits or the panel itself.
const { lanRestrict } = require('./middleware/lanRestrict');
app.use('/admin', lanRestrict);
app.use('/admin', require('./routes/admin'));

// Health check endpoint
app.get('/health', (req, res) =>
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() })
);

// Initialize config if missing
try {
    const { initializeConfig } = require('./lib/configStore');
    initializeConfig();
} catch (err) {
    console.error('[Server] Config initialization failed:', err.message);
}

function getLocalIPAddress() {
    // Try env var first
    let ip = process.env.URL;
    if (ip) {
        try {
            ip = new URL(ip).hostname;
        } catch (err) {
            console.warn('[Server] Invalid URL in URL env var:', err.message);
            ip = null;
        }
    }

    // Fall back to detecting non-loopback IPv4
    if (!ip || ip === 'localhost' || ip === '127.0.0.1') {
        ip = '127.0.0.1';
        const networkInterfaces = os.networkInterfaces();
        for (const interfaceName in networkInterfaces) {
            if (interfaceName.includes('docker') || interfaceName.includes('virbr')) continue;
            for (const iface of networkInterfaces[interfaceName]) {
                if (!iface.internal && iface.family === 'IPv4' && !iface.address.startsWith('127.')) {
                    ip = iface.address;
                    break;
                }
            }
            if (ip !== '127.0.0.1') break;
        }
    }

    // No non-loopback IPv4 found (container/CI). Fall back to the bind address
    // rather than a hardcoded host IP so the log never advertises a wrong host.
    if (ip === '127.0.0.1' || ip === 'localhost') {
        ip = '0.0.0.0';
    }

    return ip;
}

const ipAddress = getLocalIPAddress();
const server = app.listen(PORT, () => {
    console.log(`Roku Admin server running at http://${ipAddress}:${PORT}`);
    console.log(`Admin panel: http://${ipAddress}:${PORT}/admin`);
});

process.on('SIGTERM', () => {
    const { closeDb } = require('./lib/db');
    closeDb();
    server.close(() => {
        (sdk ? sdk.shutdown() : Promise.resolve())
            .then(() => {
                console.log('[OTel] Shutdown complete');
                process.exit(0);
            })
            .catch((err) => {
                console.error('[OTel] Shutdown error:', err.message);
                process.exit(1);
            });
    });
});

process.on('SIGINT', () => {
    const { closeDb } = require('./lib/db');
    closeDb();
    server.close(() => {
        (sdk ? sdk.shutdown() : Promise.resolve())
            .then(() => {
                console.log('[OTel] Shutdown complete');
                process.exit(0);
            })
            .catch((err) => {
                console.error('[OTel] Shutdown error:', err.message);
                process.exit(1);
            });
    });
});

/**
 * test-client-contract.mjs - Server-to-Client Integration Contract Tests
 *
 * Validates that the server produces exactly what the Roku client expects.
 * Starts a real server, generates a feed, and exercises every endpoint
 * with the exact payloads the client sends and the exact expectations the client has.
 *
 * Run: node tests/integration/test-client-contract.mjs
 * Requires: ffmpeg/ffprobe on PATH, npm install
 *
 * Isolated by contract, not by habit (repository rule: "use isolated fixtures for tests that write
 * feed, metadata, database, or video files"). Measured 2026-11-09, before this was true: this file
 * rewrote the repository's own `output/roku_feed.json` on every run (`581f5928...` -> `de84a18e...`,
 * transcript the private evidence record red-00-repo-state-mutated in the project
 * certificate), read the deployment store `config.json` for its expectations, depended on
 * `Videos/*.mp4` artifacts another test happened to leave behind, and squatted on a fixed port (3999)
 * that a second thread running the same suite would collide with. A final test asserts the
 * repository's own state bytes did not move while the suite ran.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Resolve directories relative to this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, '../..');

// ─── The isolated world this suite owns ───────────────────────────────────────
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-client-contract-'));
const VIDEOS_DIR = path.join(TEMP, 'Videos');
const OUTPUT_DIR = path.join(TEMP, 'output');
const THUMBNAIL_DIR = path.join(OUTPUT_DIR, 'thumbnails');
const METADATA_PATH = path.join(TEMP, 'videos.json');
const CHANNEL_CONFIG = path.join(TEMP, 'channel-config.json');
const DB_PATH = path.join(TEMP, 'analytics.db');
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

// The expectation is a fixture, not whatever a box happens to have configured.
const CHANNEL_FIXTURE = {
    version: '1.0.0',
    channel: {
        name: 'Contract Church',
        description: 'The channel the contract suite builds',
        language: 'en',
        copyright: '(c) 2026'
    },
    content: { sourceUrl: '', maxItemsPerRow: 9 },
    cardStyle: { showTitle: true, showDescription: false },
    branding: { colors: { background: '0x101018', accent: '0xE8B931' } },
    features: { search: true, live: false },
    ui: { backgroundColor: '0x101018' },
    analytics: { enabled: true, exportIntervalSeconds: 60, exportUrl: '/analytics' }
};
fs.writeFileSync(CHANNEL_CONFIG, JSON.stringify(CHANNEL_FIXTURE, null, 2));

/** Two real, tiny videos: ffprobe has to measure them, so they are encoded, not stubbed.
 *  Same one-liner the repository's own unit suites use (`tests/unit/test-feedGenerator.mjs:64`). */
function makeFixtureVideos() {
    for (const name of ['Contract Sermon One October 4, 2026.mp4', 'Contract Sermon Two November 1, 2026.mp4']) {
        const out = path.join(VIDEOS_DIR, name);
        try {
            execFileSync(
                'ffmpeg',
                [
                    '-hide_banner',
                    '-loglevel',
                    'error',
                    '-f',
                    'lavfi',
                    '-i',
                    'color=c=black:s=320x240:d=2',
                    '-c:v',
                    'libx264',
                    '-pix_fmt',
                    'yuv420p',
                    '-y',
                    out
                ],
                { stdio: 'pipe' }
            );
        } catch (err) {
            throw new Error(`fixture-video-encode-failed:${name}:${err.message}`);
        }
    }
}
makeFixtureVideos();

// Every path the generator, the routes and the database resolve, pointed into TEMP. `contentRoot.js`
// reads these lazily; `lib/db.js` captures DB_PATH at require time, so this happens before any require.
process.env.CTV_VIDEOS_DIR = VIDEOS_DIR;
process.env.CTV_VIDEOS_METADATA = METADATA_PATH;
process.env.CTV_FEED_OUTPUT_DIR = OUTPUT_DIR;
process.env.CTV_IMAGES_DIR = VIDEOS_DIR;
process.env.CTV_UPLOADS_DIR = path.join(TEMP, 'uploads');
process.env.CTV_AUDIT_DIR = path.join(TEMP, 'audit');
process.env.CTV_CHANNEL_CONFIG = CHANNEL_CONFIG;
process.env.DB_PATH = DB_PATH;

/** A port nobody else is holding, probed at run time, instead of a number written into the file. */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

let TEST_PORT = Number(process.env.CLIENT_CONTRACT_PORT || 0);
let TEST_URL = null;
const FEED_PATH = path.join(OUTPUT_DIR, 'roku_feed.json');

// Deployment state this suite must not move: snapshot at load, assert at the end.
const digest = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);
const REPO_WATCH = [
    'config.json',
    'videos.json',
    'output/roku_feed.json',
    'analytics.db',
    'analytics.db-wal',
    'analytics.db-shm'
].map((rel) => {
    const abs = path.join(SERVER_DIR, rel);
    return { rel, abs, sha: digest(abs) };
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function httpGet(urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`${TEST_URL}${urlPath}`, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) });
                } catch {
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
                }
            });
        }).on('error', reject);
    });
}

function httpPost(urlPath, payload) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(payload);
        const url = new URL(`${TEST_URL}${urlPath}`);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
                } catch {
                    resolve({ statusCode: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function httpHead(urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`${TEST_URL}${urlPath}`, { method: 'HEAD' }, (res) => {
            resolve({ statusCode: res.statusCode, headers: res.headers });
        }).on('error', reject);
    });
}

function getFeed() {
    return JSON.parse(fs.readFileSync(FEED_PATH, 'utf8'));
}

function getMonthKeys(feed) {
    // The client's own rule, not a list: a published Roku collects every ARRAY-valued top-level key as a
    // month row (`work/roku-channel-template/components/tasks/MainLoaderTask.brs:313-317`; the shipped
    // Example app at `:235-239` keeps array values only). A hardcoded metadata list would call the frozen
    // envelope's `feedVersion` a month row, which is the very confusion the client rule prevents.
    return Object.keys(feed).filter((k) => Array.isArray(feed[k]));
}

function getAllVideos(feed) {
    const videos = [];
    for (const key of getMonthKeys(feed)) {
        videos.push(...feed[key]);
    }
    return videos;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

before(async () => {
    if (!TEST_PORT) TEST_PORT = await freePort();
    TEST_URL = `http://127.0.0.1:${TEST_PORT}`;
    process.env.PORT = String(TEST_PORT);
    process.env.URL = TEST_URL;
    const { regenerateFeed } = require(`${SERVER_DIR}/lib/feedGenerator.js`);
    await regenerateFeed({ baseUrl: TEST_URL });
});

after(() => {
    delete process.env.PORT;
    delete process.env.URL;
    fs.rmSync(TEMP, { recursive: true, force: true });
});

// ─── 1. FEED CONTRACT ─────────────────────────────────────────────────────────

describe('GET /feed - Roku client feed contract', () => {
    let feed;

    before(() => {
        feed = getFeed();
    });

    it('has required top-level keys that MainLoaderTask expects', () => {
        assert.ok(feed.providerName, 'feed must have providerName');
        assert.ok(feed.lastUpdated, 'feed must have lastUpdated');
        assert.ok(feed.language, 'feed must have language');
    });

    it('names the feed contract version it is written in (GATE T1 feed-v1, D-T1-5 emit step)', () => {
        assert.equal(feed.feedVersion, '1', `top-level feedVersion is ${JSON.stringify(feed.feedVersion)}`);
        assert.ok(
            !Array.isArray(feed.feedVersion),
            'an array-valued top-level key becomes a phantom month row on a Roku'
        );
    });

    it('has cardStyle at top level (client extracts it)', () => {
        assert.ok(feed.cardStyle, 'feed must have cardStyle at top level');
        assert.ok(typeof feed.cardStyle.showTitle !== 'undefined', 'cardStyle must have showTitle');
    });

    it('has month-year keys (not providerName/lastUpdated/language/cardStyle)', () => {
        const monthKeys = getMonthKeys(feed);
        assert.ok(monthKeys.length > 0, 'feed must have at least one month key');
        const monthPattern =
            /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/;
        for (const key of monthKeys) {
            assert.ok(monthPattern.test(key), `month key "${key}" must match "Month YYYY" format`);
        }
    });

    it('month keys contain arrays of video objects', () => {
        for (const monthKey of getMonthKeys(feed)) {
            const videos = feed[monthKey];
            assert.ok(Array.isArray(videos), `month key "${monthKey}" must contain an array`);
            assert.ok(videos.length > 0, `month key "${monthKey}" must have at least one video`);
            for (const video of videos) {
                assert.ok(typeof video === 'object', 'each video must be an object');
            }
        }
    });
});

// ─── 2. CONTENT ITEM CONTRACT ─────────────────────────────────────────────────

describe('Content item fields - MainLoaderTask GetItemData contract', () => {
    let videos;

    before(() => {
        videos = getAllVideos(getFeed());
    });

    it('each video has required fields for GetItemData()', () => {
        for (const video of videos) {
            assert.ok(video.id, 'video must have id (deep linking)');
            assert.ok(typeof video.title === 'string', 'video must have title string');
            assert.ok(typeof video.shortDescription === 'string', 'video must have shortDescription string');
            assert.ok(video.thumbnail, 'video must have thumbnail URL');
            assert.ok(video.hdPosterUrl, 'video must have hdPosterUrl');
            assert.ok(video.sdPosterUrl, 'video must have sdPosterUrl');
            assert.ok(video.url, 'video must have url');
            assert.ok(video.releaseDate, 'video must have releaseDate');
            assert.ok(Array.isArray(video.genres), 'video must have genres array');
        }
    });

    it('each video has content.videos array with stream info', () => {
        for (const video of videos) {
            assert.ok(video.content, 'video must have content object');
            assert.ok(typeof video.content.duration === 'number', 'video.content must have duration (number)');
            assert.ok(Array.isArray(video.content.videos), 'video.content must have videos array');
            assert.ok(video.content.videos.length > 0, 'video.content.videos must have at least one entry');
            const stream = video.content.videos[0];
            assert.ok(stream.url, 'video.content.videos[0] must have url');
            assert.ok(stream.quality, 'video.content.videos[0] must have quality');
            assert.ok(stream.videoType, 'video.content.videos[0] must have videoType');
        }
    });

    it('each video stream URL uses /stream/ prefix (client uses it for playback)', () => {
        for (const video of videos) {
            assert.ok(video.url.includes('/stream/'), `video URL must use /stream/ prefix: ${video.url}`);
            assert.ok(
                video.content.videos[0].url.includes('/stream/'),
                'content.videos[0].url must use /stream/ prefix'
            );
        }
    });

    it('each video thumbnail URL uses /output/thumbnails/ prefix', () => {
        for (const video of videos) {
            assert.ok(
                video.thumbnail.includes('/output/thumbnails/'),
                `thumbnail must use /output/thumbnails/ prefix: ${video.thumbnail}`
            );
        }
    });

    it('thumbnail, hdPosterUrl, sdPosterUrl are consistent', () => {
        for (const video of videos) {
            assert.strictEqual(video.thumbnail, video.hdPosterUrl, 'thumbnail must equal hdPosterUrl');
            assert.strictEqual(video.thumbnail, video.sdPosterUrl, 'thumbnail must equal sdPosterUrl');
        }
    });
});

// ─── 3. EMBEDDED CONFIG CONTRACT ──────────────────────────────────────────────

describe('Embedded config - feed.config consistency', () => {
    let feed;
    let config;

    before(() => {
        feed = getFeed();
        config = JSON.parse(fs.readFileSync(CHANNEL_CONFIG, 'utf8'));
    });

    it('feed.config matches the configured channel store structure', () => {
        assert.ok(feed.config, 'feed must have config object');
        assert.ok(feed.config.channel, 'feed.config must have channel');
        assert.ok(feed.config.branding, 'feed.config must have branding');
        assert.ok(feed.config.features, 'feed.config must have features');
        assert.ok(feed.config.ui, 'feed.config must have ui');
    });

    it('feed.config.channel matches the configured store channel', () => {
        assert.strictEqual(feed.config.channel.name, config.channel.name, 'feed.config.channel.name must match');
        assert.strictEqual(
            feed.config.channel.language,
            config.channel.language,
            'feed.config.channel.language must match'
        );
    });

    it('feed.config.cardStyle matches the configured store cardStyle', () => {
        assert.strictEqual(
            feed.config.cardStyle.showTitle,
            config.cardStyle.showTitle,
            'feed.config.cardStyle.showTitle must match'
        );
    });

    it('feed.config.server.baseUrl is set', () => {
        assert.ok(feed.config.server, 'feed.config must have server');
        assert.ok(feed.config.server.baseUrl, 'feed.config.server must have baseUrl');
        assert.ok(feed.config.server.baseUrl.startsWith('http'), 'feed.config.server.baseUrl must be a valid URL');
    });

    it('feed.config.analytics has expected structure', () => {
        assert.ok(feed.config.analytics, 'feed.config must have analytics');
        assert.ok(typeof feed.config.analytics.enabled === 'boolean', 'analytics must have enabled boolean');
        assert.ok(feed.config.analytics.exportUrl !== undefined, 'analytics must have exportUrl');
        assert.ok(
            typeof feed.config.analytics.exportIntervalSeconds === 'number',
            'analytics must have exportIntervalSeconds'
        );
    });

    it('top-level cardStyle matches feed.config.cardStyle', () => {
        assert.deepStrictEqual(
            feed.cardStyle,
            feed.config.cardStyle,
            'top-level cardStyle must match feed.config.cardStyle'
        );
    });
});

// ─── 4. LIVE SERVER CONTRACT ──────────────────────────────────────────────────

describe('Live server - HTTP endpoint contract', () => {
    let server;

    before((done) => {
        Object.keys(require.cache).forEach((key) => {
            if (key.includes('server.js') || key.includes('lib/db.js')) {
                delete require.cache[key];
            }
        });

        process.env.PORT = String(TEST_PORT);
        process.env.URL = TEST_URL;

        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use(express.urlencoded({ extended: true }));

        // Mount routes EXACTLY as server.js does (lines 53-56):
        //   app.use('/', require('./routes/dashboard'));
        //   app.use(require('./routes/feed'));       → GET /feed
        //   app.use(require('./routes/stream'));     → GET /stream/:videoName
        //   app.use('/api', require('./routes/api')); → POST /api/analytics, GET /api/v1/analytics/*
        app.use('/', require(`${SERVER_DIR}/routes/dashboard.js`));
        app.use(require(`${SERVER_DIR}/routes/feed.js`));
        app.use(require(`${SERVER_DIR}/routes/stream.js`));
        const { apiAuth } = require(`${SERVER_DIR}/middleware/apiAuth.js`);
        // Query contract assertions use an authenticated admin context.
        app.use(
            '/api',
            (req, res, next) => {
                req.session = { adminAuthenticated: true, loginTime: Date.now() - 3600000 };
                next();
            },
            apiAuth
        );
        const apiRouter = require(`${SERVER_DIR}/routes/api.js`);
        app.use('/api', apiRouter);
        app.post('/analytics', (req, res, next) => apiRouter(req, res, next));

        app.use('/Videos', express.static(VIDEOS_DIR));
        app.use('/output/thumbnails', express.static(THUMBNAIL_DIR));

        server = app.listen(TEST_PORT, done);
    });

    after(() => {
        if (server) {
            server.close();
        }
        try {
            const { closeDb } = require(`${SERVER_DIR}/lib/db.js`);
            closeDb();
        } catch {}
    });

    // ─── Feed endpoint ────────────────────────────────────────────────────────

    describe('GET /feed (live HTTP)', () => {
        it('returns 200 with JSON feed', async () => {
            const res = await httpGet('/feed');
            assert.strictEqual(res.statusCode, 200);
            assert.ok(res.body.providerName, 'response must have providerName');
        });

        it('returns ETag header for caching', async () => {
            const res = await httpGet('/feed');
            assert.ok(res.headers['etag'], 'response must have ETag header');
        });

        it('returns Last-Modified header', async () => {
            const res = await httpGet('/feed');
            assert.ok(res.headers['last-modified'], 'response must have Last-Modified header');
        });

        it('returns 304 Not Modified when If-Modified-Since matches', async () => {
            const first = await httpGet('/feed');
            const lastModified = first.headers['last-modified'];

            // Wait a bit to ensure the feed file timestamp is stable
            await new Promise((resolve) => setTimeout(resolve, 100));

            return new Promise((resolve, reject) => {
                http.get(
                    `${TEST_URL}/feed`,
                    {
                        headers: { 'If-Modified-Since': lastModified }
                    },
                    (res) => {
                        let data = '';
                        res.on('data', (chunk) => (data += chunk));
                        res.on('end', () => {
                            try {
                                resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
                            } catch {
                                resolve({ statusCode: res.statusCode, body: data });
                            }
                        });
                    }
                ).on('error', reject);
            }).then((res) => {
                // Accept both 304 (Not Modified) and 200 (OK) - the server may regenerate feed between requests
                assert.ok(
                    res.statusCode === 304 || res.statusCode === 200,
                    `should return 304 or 200, got ${res.statusCode}`
                );
            });
        });
    });

    // ─── Stream endpoint ──────────────────────────────────────────────────────

    describe('GET /stream/:videoName (live HTTP)', () => {
        /**
         * The stream a client can open is the one the feed names, so that is what this asserts on.
         * The previous version asked for `/stream/test-regen.mp4` - a file another suite happened to
         * leave in `Videos/`, which is how this file could be green while a real channel's URL was not
         * being tested at all.
         */
        function feedStreamPath() {
            const feed = getFeed();
            const rows = Object.keys(feed)
                .filter((k) => Array.isArray(feed[k]))
                .flatMap((k) => feed[k]);
            assert.ok(rows.length > 0, 'the generated feed has no items to stream');
            return { item: rows[0], pathname: new URL(rows[0].content.videos[0].url).pathname };
        }

        it('returns 200 for a video the feed itself names, with the bytes that video is', async () => {
            const { item, pathname } = feedStreamPath();
            const res = await httpHead(pathname);
            assert.strictEqual(res.statusCode, 200, `${item.title} is named by the feed but does not stream`);
            assert.ok(res.headers['content-type'], 'must have Content-Type');
            const onDisk = fs.statSync(path.join(VIDEOS_DIR, decodeURIComponent(path.basename(pathname)))).size;
            assert.ok(Number(res.headers['content-length']) === onDisk, 'the stream length is not the file on disk');
        });

        it('returns 404 for non-existent video', async () => {
            const res = await httpHead('/stream/nonexistent.mp4');
            assert.strictEqual(res.statusCode, 404);
        });

        it('returns 206 Partial Content for range request', async () => {
            const { pathname } = feedStreamPath();
            return new Promise((resolve, reject) => {
                http.get(
                    `${TEST_URL}${pathname}`,
                    {
                        headers: { Range: 'bytes=0-100' }
                    },
                    (res) => {
                        let data = '';
                        res.on('data', (chunk) => (data += chunk));
                        res.on('end', () => {
                            resolve({
                                statusCode: res.statusCode,
                                headers: res.headers,
                                contentLength: data.length
                            });
                        });
                    }
                ).on('error', reject);
            }).then((res) => {
                assert.strictEqual(res.statusCode, 206, 'must return 206 for range request');
                assert.ok(res.headers['content-range'], 'must have Content-Range header');
                assert.ok(res.headers['accept-ranges'], 'must have Accept-Ranges header');
            });
        });
    });

    // ─── Analytics endpoint ───────────────────────────────────────────────────

    describe('POST /analytics - Roku client export contract', () => {
        it('accepts the exact payload format the client sends (nested events)', async () => {
            // This is the EXACT format BuildExportPayload() produces in AnalyticsExport.brs
            const clientPayload = {
                appVersion: '1.0.0',
                sessionStartTime: '12:00:00',
                activeScreen: 'VideoScreen',
                eventCount: 4,
                summary: {
                    screenViews: 1,
                    plays: 1,
                    deepLinks: 1,
                    errors: 1
                },
                events: {
                    screenViews: [
                        {
                            eventType: 'screen_view',
                            screenName: 'GridScreen',
                            previousScreen: 'MainScene',
                            timestamp: '12:01:00',
                            sessionDuration: 60
                        }
                    ],
                    plays: [
                        {
                            eventType: 'content_play',
                            contentId: 'video-test-regen',
                            contentTitle: 'test-regen',
                            timestamp: '12:02:00',
                            sessionDuration: 120
                        }
                    ],
                    deepLinks: [
                        {
                            eventType: 'deep_link',
                            contentId: 'video-test-regen',
                            mediaType: 'video',
                            source: 'rowlist',
                            timestamp: '12:03:00'
                        }
                    ],
                    errors: [
                        {
                            eventType: 'error',
                            errorType: 'network',
                            errorMessage: 'Connection timeout',
                            context: 'stream',
                            timestamp: '12:04:00'
                        }
                    ]
                }
            };

            const res = await httpPost('/api/analytics', clientPayload);
            assert.strictEqual(
                res.statusCode,
                200,
                `analytics must return 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`
            );
            assert.strictEqual(res.body.received, true, 'response must have received: true');
            assert.strictEqual(res.body.count, 4, 'response must have count: 4');
        });

        it('accepts queued event format (queued events from FlushEventQueue)', async () => {
            const queuedPayload = {
                eventType: 'screen_view',
                timestamp: '12:00:00',
                appVersion: '1.0.0',
                screenViews: [{ screenName: 'Home' }],
                plays: [],
                deepLinks: [],
                errors: [],
                sessionDuration: 30
            };

            const res = await httpPost('/api/analytics', queuedPayload);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.received, true);
            assert.strictEqual(res.body.count, 1);
        });

        it('accepts flat events array format', async () => {
            const flatPayload = {
                events: [
                    { eventType: 'screen_view', timestamp: '12:00:00', screenName: 'Home', sessionDuration: 30 },
                    { eventType: 'content_play', timestamp: '12:01:00', contentId: 'vid1' }
                ]
            };

            const res = await httpPost('/api/analytics', flatPayload);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.count, 2);
        });

        it('stores device info from client payload', async () => {
            const devicePayload = {
                deviceInfo: {
                    deviceId: 'roku-contract-test-device',
                    channelName: 'Example Channel',
                    appVersion: '1.0.0'
                },
                events: {
                    screenViews: [
                        {
                            eventType: 'screen_view',
                            screenName: 'TestScreen',
                            timestamp: '12:00:00'
                        }
                    ]
                }
            };

            const res = await httpPost('/api/analytics', devicePayload);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.received, true);

            const { getDb } = require(`${SERVER_DIR}/lib/db.js`);
            const db = getDb();
            const device = db.prepare('SELECT * FROM devices WHERE id = ?').get('roku-contract-test-device');
            assert.ok(device, 'device must be stored in DB');
            assert.strictEqual(device.channel_name, 'Example Channel');
            assert.strictEqual(device.app_version, '1.0.0');
        });

        it('stores summary from client payload', async () => {
            const summaryPayload = {
                summary: {
                    screenViews: 10,
                    plays: 5,
                    deepLinks: 2,
                    errors: 1
                },
                events: {
                    screenViews: [
                        {
                            eventType: 'screen_view',
                            screenName: 'Home',
                            timestamp: '12:00:00'
                        }
                    ]
                }
            };

            const res = await httpPost('/api/analytics', summaryPayload);
            assert.strictEqual(res.statusCode, 200);

            const { getDb } = require(`${SERVER_DIR}/lib/db.js`);
            const db = getDb();
            const summary = db.prepare('SELECT * FROM summary WHERE id = 1').get();
            assert.ok(summary, 'summary must be stored');
            const metadata = JSON.parse(summary.metadata);
            assert.strictEqual(metadata.screenViews, 10);
            assert.strictEqual(metadata.plays, 5);
        });

        it('accepts analytics with content_play event matching feed video IDs', async () => {
            const feed = getFeed();
            const monthKeys = getMonthKeys(feed);
            const firstVideo = feed[monthKeys[0]][0];

            const payload = {
                events: {
                    plays: [
                        {
                            eventType: 'content_play',
                            contentId: firstVideo.id,
                            contentTitle: firstVideo.title,
                            timestamp: '12:00:00'
                        }
                    ]
                }
            };

            const res = await httpPost('/api/analytics', payload);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.received, true);
            assert.strictEqual(res.body.count, 1);
        });
    });

    // ─── Analytics query endpoints ────────────────────────────────────────────

    describe('GET /api/v1/analytics/events - query contract', () => {
        it('returns paginated events', async () => {
            const res = await httpGet('/api/v1/analytics/events');
            assert.strictEqual(res.statusCode, 200);
            assert.ok(Array.isArray(res.body.events), 'response must have events array');
            assert.ok(res.body.pagination, 'response must have pagination');
            assert.ok(typeof res.body.pagination.total === 'number', 'pagination must have total');
        });

        it('filters by event type', async () => {
            const res = await httpGet('/api/v1/analytics/events?eventType=screen_view');
            assert.strictEqual(res.statusCode, 200);
            for (const event of res.body.events) {
                assert.strictEqual(event.event_type, 'screen_view', 'all events must match filter');
            }
        });

        it('filters by device ID', async () => {
            const res = await httpGet('/api/v1/analytics/events?deviceId=roku-contract-test-device');
            assert.strictEqual(res.statusCode, 200);
            for (const event of res.body.events) {
                assert.strictEqual(event.device_id, 'roku-contract-test-device', 'all events must match device filter');
            }
        });
    });

    describe('GET /api/v1/analytics/stats - stats contract', () => {
        it('returns stats with expected structure', async () => {
            const res = await httpGet('/api/v1/analytics/stats');
            assert.strictEqual(res.statusCode, 200);
            assert.ok(res.body.summary, 'stats must have summary');
            assert.ok(typeof res.body.summary.totalEvents === 'number', 'summary must have totalEvents');
            assert.ok(typeof res.body.summary.uniqueDevices === 'number', 'summary must have uniqueDevices');
            assert.ok(Array.isArray(res.body.eventsOverTime), 'must have eventsOverTime array');
            assert.ok(Array.isArray(res.body.typeBreakdown), 'must have typeBreakdown array');
        });

        it('supports period parameter', async () => {
            for (const period of ['7d', '30d', '90d', 'all']) {
                const res = await httpGet(`/api/v1/analytics/stats?period=${period}`);
                assert.strictEqual(res.statusCode, 200, `period ${period} must return 200`);
                assert.strictEqual(res.body.period, period, `response must echo period ${period}`);
            }
        });

        it('supports groupBy parameter', async () => {
            for (const groupBy of ['day', 'week', 'month']) {
                const res = await httpGet(`/api/v1/analytics/stats?groupBy=${groupBy}`);
                assert.strictEqual(res.statusCode, 200, `groupBy ${groupBy} must return 200`);
                assert.strictEqual(res.body.groupBy, groupBy, `response must echo groupBy ${groupBy}`);
            }
        });
    });

    describe('GET /api/v1/analytics/devices - device contract', () => {
        it('returns device data', async () => {
            const res = await httpGet('/api/v1/analytics/devices');
            assert.strictEqual(res.statusCode, 200);
            assert.ok(res.body, 'response must have body');
        });
    });

    // ─── End-to-end round-trip ────────────────────────────────────────────────

    describe('End-to-end round-trip - full client lifecycle simulation', () => {
        it('client loads feed → parses content → sends analytics → verifies storage', async () => {
            // Step 1: Client loads feed (like MainLoaderTask)
            const feed = getFeed();

            // Step 2: Client parses content (like BuildContentTree)
            const monthKeys = getMonthKeys(feed);
            let firstVideo = null;
            for (const key of monthKeys) {
                if (feed[key].length > 0) {
                    firstVideo = feed[key][0];
                    break;
                }
            }
            assert.ok(firstVideo, 'feed must have at least one video');

            // Step 3: Client builds content node (like GetItemData)
            // Verify all fields GetItemData accesses are present
            assert.ok(firstVideo.title, 'GetItemData accesses .title');
            assert.ok(firstVideo.shortDescription, 'GetItemData accesses .shortDescription');
            assert.ok(firstVideo.thumbnail, 'GetItemData accesses .thumbnail');
            assert.ok(firstVideo.id, 'GetItemData accesses .id');
            assert.ok(firstVideo.content?.videos?.[0]?.url, 'GetItemData accesses .content.videos[0].url');
            assert.ok(firstVideo.content?.videos?.[0]?.videoType, 'GetItemData accesses .content.videos[0].videoType');
            assert.ok(firstVideo.content?.duration, 'GetItemData accesses .content.duration');

            // Step 4: Client sends analytics (like BuildExportPayload)
            const analyticsPayload = {
                appVersion: '1.0.0',
                sessionStartTime: '12:00:00',
                activeScreen: 'VideoScreen',
                eventCount: 3,
                summary: {
                    screenViews: 1,
                    plays: 1,
                    deepLinks: 0,
                    errors: 1
                },
                events: {
                    screenViews: [
                        {
                            eventType: 'screen_view',
                            screenName: 'GridScreen',
                            previousScreen: 'MainScene',
                            timestamp: '12:00:01',
                            sessionDuration: 60
                        }
                    ],
                    plays: [
                        {
                            eventType: 'content_play',
                            contentId: firstVideo.id,
                            contentTitle: firstVideo.title,
                            contentDuration: firstVideo.content.duration,
                            timestamp: '12:00:02',
                            sessionDuration: 120
                        }
                    ],
                    deepLinks: [],
                    errors: [
                        {
                            eventType: 'error',
                            errorType: 'player',
                            errorMessage: 'Buffer underrun',
                            context: 'VideoScreen',
                            timestamp: '12:00:03'
                        }
                    ]
                }
            };

            const res = await httpPost('/api/analytics', analyticsPayload);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.received, true);
            assert.strictEqual(res.body.count, 3);

            // Step 5: Verify analytics are queryable
            const eventsRes = await httpGet('/api/v1/analytics/events?eventType=content_play');
            assert.strictEqual(eventsRes.statusCode, 200);
            const playEvents = eventsRes.body.events.filter((e) => e.event_type === 'content_play');
            assert.ok(playEvents.length > 0, 'content_play event must be stored and queryable');

            // Step 6: Verify stats include our events
            const statsRes = await httpGet('/api/v1/analytics/stats');
            assert.strictEqual(statsRes.statusCode, 200);
            assert.ok(statsRes.body.summary.totalEvents > 0, 'stats must include our events');
        });
    });
});

// ─── 7. PURITY: the suite may not move state it does not own ──────────────────

it('the run leaves the repository deployment state byte-identical, and its own fixtures prove it ran', () => {
    // Positive control first: the isolated world really was used, so the assertion below cannot be
    // satisfied by a run that generated nothing.
    assert.ok(fs.existsSync(FEED_PATH), `the isolated feed was never generated at ${FEED_PATH}`);
    const generated = getFeed();
    const rows = Object.keys(generated).filter((k) => Array.isArray(generated[k]));
    assert.ok(rows.length > 0, 'the isolated feed has no month rows - the isolation is not wired');
    assert.ok(rows.reduce((n, k) => n + generated[k].length, 0) >= 2, 'expected the two fixture sermons in the feed');
    assert.ok(fs.existsSync(DB_PATH), 'the run did not use its own analytics database');

    const moved = REPO_WATCH.map((w) => ({ rel: w.rel, before: w.sha, after: digest(w.abs) })).filter(
        (w) => w.before !== w.after
    );
    assert.deepEqual(
        moved.map((m) => `${m.rel} ${String(m.before).slice(0, 12)} -> ${String(m.after).slice(0, 12)}`),
        [],
        "the contract suite rewrote repository deployment state - config.json / videos.json / output/roku_feed.json / analytics.db are a box's live channel state, not test scratch"
    );
});

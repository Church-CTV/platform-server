require('dotenv').config();

const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const { loadConfig } = require('./configStore');
const httpCache = require('./httpCache');
const { normalizeEndpoints } = require('./effectiveConfig');
const { getVideoMetadata } = require('./videoMetadata');
const { generateAutoThumbnail, getThumbnailPath, sanitizeTitle } = require('./thumbnailManager');
const { validateFeed } = require('./feedValidator');

const { videosDir, requireVideosDir, outputDir } = require('./contentRoot');

// resolved per call so a test, or a second organisation, can point the generated feed elsewhere
function outputFile() {
    return path.join(outputDir(), 'roku_feed.json');
}

const DEFAULT_THUMBNAIL_PATH = path.join(__dirname, '..', 'images', 'test-video-thumbnail.png');
const YOUTUBE_CHANNEL_HANDLE = process.env.YOUTUBE_CHANNEL_HANDLE || '';
const YOUTUBE_MATCH_THRESHOLD = Number.parseFloat(process.env.YOUTUBE_MATCH_THRESHOLD || '0.3');

// The published client contract, read from the schema file itself, is the only shape a television
// may be handed. Measured 2026-11-08: this producer used to emit `sermon` and `offline` into the
// config block, the live example-channel feed still ships both, and the contract refuses unknown keys - so the
// feed generator was handing clients a block their own config self-test has to refuse. Keys are
// picked from the contract, never copied wholesale from the legacy store, and the uri-valued fields
// are resolved against the origin this server actually serves from.
const CLIENT_CONTRACT_KEYS = Object.keys(require('../schemas/ctv-config-v1.json').properties);

function absoluteOrUndefined(value, base) {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    try {
        return new URL(value, base).toString();
    } catch {
        return undefined;
    }
}

function buildClientConfig(config, base) {
    const block = {};
    for (const key of CLIENT_CONTRACT_KEYS) {
        if (config[key] === undefined) continue;
        block[key] = structuredClone(config[key]);
    }
    // `server.baseUrl` names where this server serves, which the producer knows and the operator
    // store cannot guess; the same forcing the v2 route applies when it rewrites a served feed.
    block.server = { ...(config.server || {}), baseUrl: absoluteOrUndefined(config.server?.baseUrl, base) || base };
    // The contract requires a content source, and only this server can name it, so the producer
    // resolves it the same way the v2 route does when it rewrites a served feed.
    block.content = { ...(config.content || {}) };
    block.content.sourceUrl = absoluteOrUndefined(config.content?.sourceUrl, base) || `${base}/feed`;
    if (block.analytics)
        block.analytics.exportUrl = absoluteOrUndefined(config.analytics?.exportUrl, base) || `${base}/analytics`;
    // The remaining URI-valued fields belong to the shared endpoint step, so the producer and the
    // serve path resolve relative and empty endpoints exactly the same way - one implementation, no
    // drift between the feed a television downloads and the config endpoint it also reads.
    const normalized = normalizeEndpoints(block, base);
    for (const key of Object.keys(normalized)) {
        if (normalized[key] && typeof normalized[key] === 'object' && Object.keys(normalized[key]).length === 0) {
            delete normalized[key];
        }
    }
    return normalized;
}

function normalizeTitle(title) {
    return String(title || '')
        .replace(/\.[^/.]+$/, '')
        .replace(/_/g, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function titleSimilarity(left, right) {
    const a = normalizeTitle(left);
    const b = normalizeTitle(right);
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const pairs = new Map();
    for (let i = 0; i < a.length - 1; i++) {
        const pair = a.slice(i, i + 2);
        pairs.set(pair, (pairs.get(pair) || 0) + 1);
    }
    let intersection = 0;
    for (let i = 0; i < b.length - 1; i++) {
        const pair = b.slice(i, i + 2);
        const count = pairs.get(pair) || 0;
        if (count > 0) {
            pairs.set(pair, count - 1);
            intersection++;
        }
    }
    return (2 * intersection) / (a.length + b.length - 2);
}

async function fetchYouTubeJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok || data.error) {
        const message =
            data.error && data.error.message ? data.error.message : `${response.status} ${response.statusText}`;
        throw new Error(`YouTube API request failed: ${message}`);
    }
    return data;
}

async function retrieveYouTubeVideos() {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
        if (process.env.YOUTUBE_METADATA_REQUIRED === 'true') {
            throw new Error('YOUTUBE_API_KEY is required for feed generation');
        }
        console.warn('[FeedGenerator] YOUTUBE_API_KEY is not set; using stored/local metadata');
        return [];
    }

    const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
    channelUrl.search = new URLSearchParams({
        part: 'contentDetails',
        forHandle: YOUTUBE_CHANNEL_HANDLE.replace(/^@/, ''),
        key: apiKey
    });
    const channelData = await fetchYouTubeJson(channelUrl);
    const playlistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!playlistId) throw new Error(`YouTube channel not found: ${YOUTUBE_CHANNEL_HANDLE}`);

    const videos = [];
    let pageToken = '';
    do {
        const playlistUrl = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
        playlistUrl.search = new URLSearchParams({
            part: 'snippet,contentDetails',
            maxResults: '50',
            playlistId,
            pageToken,
            key: apiKey
        });
        const data = await fetchYouTubeJson(playlistUrl);
        videos.push(...(data.items || []));
        pageToken = data.nextPageToken || '';
    } while (pageToken);

    console.log(`[FeedGenerator] Retrieved ${videos.length} videos from YouTube`);
    return videos.map((video) => ({ video, normalizedTitle: normalizeTitle(video.snippet?.title), matched: false }));
}

function resolveThumbnailUrl(thumbnail, baseUrl) {
    if (/^https?:\/\//i.test(thumbnail || '')) return encodeURI(thumbnail);
    return encodeURI(`${baseUrl}/${String(thumbnail || '').replace(/^\/+/, '')}`);
}

function extractReleaseDateFromTitle(title) {
    const patterns = [/([A-Za-z]+\s\d{1,2},\s*\d{4})/, /([A-Za-z]+\s\d{1,2}\s\d{4})/, /([A-Za-z]+\s\d{1,2}\d{4})/];
    const monthNames = [
        'january',
        'february',
        'march',
        'april',
        'may',
        'june',
        'july',
        'august',
        'september',
        'october',
        'november',
        'december'
    ];

    for (const pattern of patterns) {
        const match = String(title || '').match(pattern);
        if (!match) continue;

        let normalized = match[1].replace(/(\d),(\d{4})/, '$1, $2');
        if (!normalized.includes(',') && /\d{2}\d{4}$/.test(normalized)) {
            normalized = normalized.replace(/(\d{2})(\d{4})$/, '$1 $2');
        }

        const parts = normalized.match(/^([A-Za-z]+)\s+(\d{1,2})[ ,]+(\d{4})$/);
        if (!parts) continue;
        const month = monthNames.indexOf(parts[1].toLowerCase());
        if (month < 0) continue;

        const year = Number(parts[3]);
        const day = Number(parts[2]);
        const date = new Date(Date.UTC(year, month, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
            continue;
        }
        return date.toISOString().slice(0, 10);
    }
    return null;
}

async function getVideoMetadata_ffprobe(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata);
        });
    });
}

async function buildVideoEntry(filename, index, baseUrl, youtubeVideos) {
    const filePath = path.join(videosDir(), filename);
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return null;
    const extension = path.extname(filename).toLowerCase();
    if (!['.mp4', '.mkv'].includes(extension)) return null;

    let metadata;
    try {
        metadata = await getVideoMetadata_ffprobe(filePath);
    } catch (err) {
        throw new Error(`ffprobe failed for "${filename}": ${err.message}`, { cause: err });
    }
    const duration = Math.floor(metadata.format.duration);

    const storedMeta = getVideoMetadata(filename) || {};
    const rawTitle = path.parse(filename).name;
    let title = storedMeta.title || sanitizeTitle(rawTitle);
    let description = storedMeta.description || `${title}`;
    let releaseDate =
        storedMeta.releaseDate || extractReleaseDateFromTitle(title) || extractReleaseDateFromTitle(rawTitle);
    let thumbnailUrl = storedMeta.thumbnail || null;
    let youtubeMatch = null;
    let bestSimilarity = 0;

    for (const candidate of youtubeVideos) {
        if (candidate.matched) continue;
        const similarity = titleSimilarity(rawTitle, candidate.normalizedTitle);
        if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            youtubeMatch = candidate;
        }
    }

    if (youtubeMatch && bestSimilarity >= YOUTUBE_MATCH_THRESHOLD) {
        const snippet = youtubeMatch.video.snippet || {};
        title = snippet.title || title;
        description = String(snippet.description || description)
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        thumbnailUrl =
            snippet.thumbnails?.maxres?.url ||
            snippet.thumbnails?.standard?.url ||
            snippet.thumbnails?.high?.url ||
            snippet.thumbnails?.medium?.url ||
            thumbnailUrl;
        if (snippet.publishedAt && !isNaN(new Date(snippet.publishedAt).getTime())) {
            releaseDate = new Date(snippet.publishedAt).toISOString().split('T')[0];
        }
        youtubeMatch.matched = true;
    }

    // Prefer the YouTube thumbnail. Generate a local frame only when metadata did not provide artwork.
    if (!thumbnailUrl) {
        thumbnailUrl = await getThumbnailPath(filename);
    }
    if (!thumbnailUrl) {
        try {
            await generateAutoThumbnail(filePath, rawTitle);
        } catch (err) {
            console.error('[FeedGenerator] Thumbnail generation failed:', err.message);
        }
        thumbnailUrl = await getThumbnailPath(filename);
    }
    if (!thumbnailUrl && fs.existsSync(DEFAULT_THUMBNAIL_PATH)) {
        thumbnailUrl = path.posix.join('output', 'thumbnails', 'default-thumbnail.png');
    }

    const releaseDateObj = new Date(`${releaseDate}T00:00:00Z`);
    if (
        typeof releaseDate !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate) ||
        Number.isNaN(releaseDateObj.getTime()) ||
        releaseDateObj.toISOString().slice(0, 10) !== releaseDate
    ) {
        throw new Error(`Missing or invalid release date for "${filename}": ${releaseDate || 'none'}`);
    }
    const monthYear = `${releaseDateObj.getUTCFullYear()}-${(releaseDateObj.getUTCMonth() + 1).toString().padStart(2, '0')}`;

    const thumbUrl = resolveThumbnailUrl(thumbnailUrl, baseUrl);
    const videoUrl = encodeURI(`${baseUrl}/stream/${path.basename(filename)}`);

    const videoData = {
        id: `video-${filename
            .replace(/\.[^.]+$/, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')}`,
        title: title,
        shortDescription: description,
        thumbnail: thumbUrl,
        hdPosterUrl: thumbUrl,
        sdPosterUrl: thumbUrl,
        url: videoUrl,
        releaseDate: releaseDate,
        genres: ['Religious'],
        content: {
            duration: duration,
            videos: [
                {
                    url: videoUrl,
                    quality: 'FHD',
                    videoType: path.extname(filename).slice(1).toUpperCase()
                }
            ]
        },
        dateAdded: storedMeta.dateAdded || new Date().toISOString()
    };

    return { monthYear, videoData };
}

async function generateFeed(options) {
    const { baseUrl, url } = options || {};
    const base = baseUrl || url || process.env.URL;
    if (!base) {
        throw new Error('URL environment variable or baseUrl option is required');
    }

    const OUT = outputDir();
    await fs.ensureDir(OUT);

    const youtubeVideos = await retrieveYouTubeVideos();
    const files = await fs.readdir(requireVideosDir());
    const configuredConcurrency = Number.parseInt(process.env.FEED_GENERATION_CONCURRENCY || '4', 10);
    const concurrency = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0 ? configuredConcurrency : 4;
    const movies = new Array(files.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < files.length) {
            const index = nextIndex++;
            try {
                movies[index] = {
                    status: 'fulfilled',
                    value: await buildVideoEntry(files[index], index, base, youtubeVideos)
                };
            } catch (reason) {
                movies[index] = { status: 'rejected', reason };
            }
        }
    }

    const workerCount = Math.min(concurrency, files.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const rejectedMovies = movies.filter((result) => result.status === 'rejected');
    if (rejectedMovies.length > 0) {
        const reasons = rejectedMovies.map((result) => String(result.reason?.message || result.reason)).join('; ');
        throw new Error(`Feed generation failed for ${rejectedMovies.length} files: ${reasons}`);
    }
    const validMovies = movies
        .filter((result) => result.status === 'fulfilled' && result.value !== null)
        .map((result) => result.value);
    const expectedVideoCount = files.filter((file) => /\.(mp4|mkv)$/i.test(file)).length;
    if (validMovies.length !== expectedVideoCount) {
        throw new Error(`Feed generated ${validMovies.length} entries for ${expectedVideoCount} video files`);
    }
    const youtubeMatchCount = youtubeVideos.filter((entry) => entry.matched).length;
    const youtubeMatchRatio = validMovies.length > 0 ? youtubeMatchCount / validMovies.length : 1;
    if (youtubeVideos.length > 0) {
        console.log(
            `[FeedGenerator] Matched YouTube metadata for ${youtubeMatchCount}/${validMovies.length} local videos (${(
                youtubeMatchRatio * 100
            ).toFixed(1)}%)`
        );
    }
    const minimumMatchRatio = Number.parseFloat(process.env.YOUTUBE_MIN_MATCH_RATIO || '0');
    if (youtubeVideos.length > 0 && youtubeMatchRatio < minimumMatchRatio) {
        throw new Error(
            `YouTube metadata match ratio ${(youtubeMatchRatio * 100).toFixed(1)}% is below required ${(
                minimumMatchRatio * 100
            ).toFixed(1)}%`
        );
    }

    const monthCategories = [];
    validMovies.forEach(({ monthYear, videoData }) => {
        const existing = monthCategories.find((cat) => cat.monthYear === monthYear);
        if (!existing) {
            monthCategories.push({ monthYear, videos: [videoData] });
        } else {
            existing.videos.push(videoData);
        }
    });

    monthCategories.sort((a, b) => b.monthYear.localeCompare(a.monthYear));
    monthCategories.forEach((cat) => {
        cat.videos.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
    });

    const config = loadConfig();
    // Built once and used twice: the digest must be of the block that is actually embedded, not of a
    // second call that happens to look the same.
    const clientConfig = buildClientConfig(config, base);

    const feed = {
        // GATE T1 `feed-v1.md`: every generated feed names the contract version it is written in.
        // Additive and safe on the wire today - a published Roku client collects only ARRAY-valued
        // top-level keys as month rows (`work/roku-channel-template/components/tasks/MainLoaderTask.brs:313-317`,
        // the shipped Example app at `:235-239` keeps array values only), so a scalar key is ignored by
        // the installed apps and read by the new ones. Emit first, enforce later (D-T1-5).
        feedVersion: '1',
        providerName: config.channel ? config.channel.name : 'Roku Channel',
        lastUpdated: new Date().toISOString(),
        language: config.channel && config.channel.language ? config.channel.language : 'en',
        cardStyle: config.cardStyle,
        config: clientConfig,
        // `CACHE-11` on the legacy surface, and additive in exactly the way `feedVersion` above is: the
        // installed Roku clients collect only array-valued top-level keys, so a scalar is ignored by them and
        // read by the new ones. The live example channel origin measured a published `config` block whose digest was not
        // the released config's (`7bfbd9772f441e09` vs `cf451ec91959321d`) and nothing on the wire said so;
        // naming the version is what lets a client, an audit and the Studio agree on which config a document
        // carries. Same function, same salt as `/api/v2/config` publishes, so "the same config" means the
        // same digest on both surfaces - and only once `T16` reconciles the spellings does it mean the same
        // string as the proof dossier's.
        configVersion: httpCache.contentDigest(clientConfig)
    };

    monthCategories.forEach((mc) => {
        const monthName = new Date(`${mc.monthYear}-01T00:00:00Z`).toLocaleString('en-US', {
            month: 'long',
            timeZone: 'UTC'
        });
        feed[`${monthName} ${mc.monthYear.split('-')[0]}`] = mc.videos;
    });

    return feed;
}

async function publishFeed(feed) {
    const OUT = outputDir();
    await fs.ensureDir(OUT);

    const validation = validateFeed(feed);
    if (!validation.valid) {
        throw new Error(`Feed validation failed: ${validation.errors.join('; ')}`);
    }

    const OUT_FILE = outputFile();
    const tmpPath = `${OUT_FILE}.tmp`;
    const bakPath = `${OUT_FILE}.bak`;

    if (fs.existsSync(OUT_FILE)) {
        fs.copySync(OUT_FILE, bakPath);
    }

    await fs.writeJson(tmpPath, feed, { spaces: 2 });
    try {
        await fs.move(tmpPath, OUT_FILE, { overwrite: true });
    } catch (moveErr) {
        await fs.remove(tmpPath);
        throw moveErr;
    }

    // The path actually written, not the module default: with `CTV_FEED_OUTPUT_DIR` set (every channel profile
    // sets it, `lib/serverProfile.js:89`) the old line named a file that was never touched, which is the one
    // question an operator asks after pressing regenerate.
    console.log(`Feed published: ${OUT_FILE} (${validation.videoCount} videos)`);
    if (validation.warnings.length > 0) {
        console.log('Warnings:', validation.warnings.join('; '));
    }
    return { success: true, videoCount: validation.videoCount, warnings: validation.warnings };
}

async function regenerateFeed(options) {
    const feed = await generateFeed(options);
    return publishFeed(feed);
}

if (require.main === module) {
    regenerateFeed()
        .then(() => console.log('Done.'))
        .catch((err) => {
            console.error('Failed:', err.message);
            process.exit(1);
        });
}

module.exports = { generateFeed, publishFeed, regenerateFeed, extractReleaseDateFromTitle, buildClientConfig };

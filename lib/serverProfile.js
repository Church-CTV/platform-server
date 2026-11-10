const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'environment', 'publicOrigin', 'port', 'contentRoot', 'feedPath', 'imagesDir', 'dbPath'],
    properties: {
        version: { const: 1 },
        environment: { enum: ['development', 'stage', 'production'] },
        publicOrigin: { type: 'string', format: 'uri' },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        contentRoot: { type: 'string' },
        feedPath: { type: 'string' },
        imagesDir: { type: 'string' },
        dbPath: { type: 'string' },
        outputDir: { type: 'string' },
        videosMetadata: { type: 'string' },
        // Request budgets are per-organisation operational posture, not client behaviour: the TLS edge
        // funnels every visitor and every monitor at the origin as ONE peer address, so a cap sized for
        // a desktop browser can lock a whole church service out of its own feed.
        rateLimits: {
            type: 'object',
            additionalProperties: false,
            properties: {
                feed: { type: 'integer', minimum: 1 },
                search: { type: 'integer', minimum: 1 },
                analytics: { type: 'integer', minimum: 1 },
                heartbeat: { type: 'integer', minimum: 1 },
                live: { type: 'integer', minimum: 1 }
            }
        },
        observability: {
            type: 'object',
            additionalProperties: false,
            required: ['metricsPort', 'prometheusPort', 'grafanaPort', 'appVersionPrefix'],
            properties: {
                metricsPort: { type: 'integer', minimum: 1, maximum: 65535 },
                prometheusPort: { type: 'integer', minimum: 1, maximum: 65535 },
                grafanaPort: { type: 'integer', minimum: 1, maximum: 65535 },
                appVersionPrefix: { type: 'string' }
            }
        },
        clientConfig: require('../schemas/ctv-config-v1.json')
    }
};
const validate = new Ajv({ allErrors: true }).compile(schema);
function resolveProfile(profile, base) {
    if (!validate(profile)) throw new Error('invalid-server-profile:' + JSON.stringify(validate.errors));
    const origin = new URL(profile.publicOrigin);
    if (origin.pathname !== '/' || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password)
        throw new Error('invalid-server-profile:publicOrigin');
    const input = (name) => path.resolve(base, profile[name]);
    for (const [name, isDir] of [
        ['contentRoot', true],
        ['feedPath', false],
        ['imagesDir', true]
    ]) {
        const file = input(name);
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory() !== isDir)
            throw new Error('missing-profile-input:' + name);
    }
    const env = {
        PORT: String(profile.port),
        URL: origin.origin,
        STRIKESAFE: profile.environment === 'production' ? 'true' : 'false',
        CTV_VIDEOS_DIR: input('contentRoot'),
        CTV_IMAGES_DIR: input('imagesDir'),
        CTV_V2_FEED_PATH: input('feedPath'),
        DB_PATH: input('dbPath')
    };
    // The feed file and the artwork directory travel together. `/output/thumbnails/<name>.jpg` is what a
    // published item's `thumbnail` points at, and it is resolved from the output directory; if the feed
    // came from the profile while the art came from the repository next to the code, a second
    // organisation would publish its own catalogue with another organisation's pictures. So an omitted
    // `outputDir` means `dirname(feedPath)` - `feedPath` has already been proven to exist above - and an
    // explicit one is honoured and proven the same way.
    let outDir;
    if (profile.outputDir === undefined) outDir = path.dirname(input('feedPath'));
    else {
        outDir = input('outputDir');
        if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory())
            throw new Error('missing-profile-input:outputDir');
    }
    env.CTV_FEED_OUTPUT_DIR = outDir;
    // The metadata file may legitimately not exist yet (the first generation writes it), so absence is not an
    // error here - but a directory at that path is a typo, and the generator would only discover it later as
    // "Missing or invalid release date" for every file, which reads like a content problem, not a path one.
    if (profile.videosMetadata !== undefined) {
        const metadataFile = input('videosMetadata');
        if (fs.existsSync(metadataFile) && !fs.statSync(metadataFile).isFile())
            throw new Error('missing-profile-input:videosMetadata');
        env.CTV_VIDEOS_METADATA = metadataFile;
    }
    for (const [name, value] of Object.entries(profile.rateLimits || {})) {
        env['CTV_RATE_LIMIT_' + name.toUpperCase()] = String(value);
    }
    return env;
}
function applyProfile(file) {
    if (!file) return;
    const absolute = path.resolve(file);
    const profile = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const values = resolveProfile(profile, path.dirname(absolute));
    Object.assign(process.env, values, { CTV_SERVER_PROFILE: absolute });
}
module.exports = { resolveProfile, applyProfile };

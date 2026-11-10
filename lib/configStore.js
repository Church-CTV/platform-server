const fs = require('fs-extra');
const path = require('path');

const effective = require('./effectiveConfig.js');
const reasonCopy = require('./reasonCopy.js');

// The store is whichever file this process is configured to use, not whichever file the repository
// happens to ship: `lib/effectiveConfig.js` reads `CTV_CHANNEL_CONFIG`, and until 2026-11-08 this
// module wrote the repo's own `config.json` regardless - the admin panel editing a file no television
// read (measured: `saveConfig` landed in `config.json` while `resolve()` reported the named store).
// One definition of "where is the store", borrowed from the reader, so the two cannot drift again.
// `tests/unit/test-configStore-write-path.mjs` asserts the un-configured default is the repository's
// own `config.json`, which is what the legacy panel has always written.
const TEMPLATE_PATH = path.join(__dirname, '..', 'config.template.json');

function CONFIG_PATH() {
    return effective.defaultStorePath();
}

function loadConfig() {
    const target = CONFIG_PATH();
    if (!fs.existsSync(target)) {
        initializeConfig();
    }
    return fs.readJsonSync(target);
}

function saveConfig(config) {
    const target = CONFIG_PATH();
    try {
        ensureColorDefaults(config);
        validateConfig(config);
        // The published contract gets the last word before a byte moves, so the operator is told at
        // the keyboard - not in a degraded channel after the next feed regeneration drops the whole
        // store layer (refuse-the-layer, C135).
        const reasons = effective.layerReasons(config);
        if (reasons.length > 0) {
            const error = new Error(`invalid-channel-config: ${reasons.join(' ')}`);
            error.name = 'InvalidChannelConfigError';
            error.reasons = reasons;
            error.copy = reasonCopy.summary(reasons);
            throw error;
        }
        const tmpPath = target + '.tmp';
        const bakPath = target + '.bak';
        if (fs.existsSync(target)) {
            fs.copySync(target, bakPath);
        }
        fs.writeJsonSync(tmpPath, config, { spaces: 2 });
        fs.moveSync(tmpPath, target, { overwrite: true });
        return config;
    } catch (err) {
        // Clean up temp file on failure
        const tmpPath = target + '.tmp';
        try {
            if (fs.existsSync(tmpPath)) {
                fs.unlinkSync(tmpPath);
            }
        } catch (cleanupErr) {
            console.error('[ConfigStore] Failed to clean up temp file:', cleanupErr.message);
        }
        throw err;
    }
}

function initializeConfig() {
    const target = CONFIG_PATH();
    // Seed only when there is nothing to seed. `server.js` calls this on every start under the comment
    // "initialize config if missing", and until 2026-11-08 the function wrote `config.template.json`
    // over the target unconditionally - so each restart replaced the channel name, colours and
    // endpoints the operator had actually saved (measured: an isolated store written before boot came
    // back as the template, and `/api/v2/config` then answered 400 because the template ships
    // `content.sourceUrl: ""`).
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8').trim() !== '') {
        try {
            return fs.readJsonSync(target);
        } catch {
            // Unparseable stays unparseable: the reader reports `store-unreadable` and a television keeps
            // its last-known-good config. Re-seeding here would quietly destroy the evidence.
            return null;
        }
    }
    if (fs.existsSync(TEMPLATE_PATH)) {
        const template = fs.readJsonSync(TEMPLATE_PATH);
        fs.writeJsonSync(target, template, { spaces: 2 });
        return template;
    }
    const defaults = getDefaultConfig();
    fs.writeJsonSync(target, defaults, { spaces: 2 });
    return defaults;
}

function getDefaultConfig() {
    return {
        channel: { name: 'Roku Channel', description: '', language: 'en', copyright: '' },
        branding: {
            colors: {
                background: '0x1A1A2E',
                surface: '0x16213E',
                accent: '0xE8B931',
                textPrimary: '0xFFFFFF',
                textSecondary: '0xA0A0B0',
                focus: '0xE8B931',
                error: '0xFF4444'
            },
            images: { overhangLogo: '', backgroundImage: '', iconFocus: '' },
            fonts: {
                title: 'font:BoldSystemFont',
                body: 'font:MediumSystemFont',
                caption: 'font:SmallSystemFont',
                heading: 'font:ExtraBoldSystemFont'
            },
            spacing: { marginHorizontal: 80, marginVertical: 40 },
            animation: { cardScale: 1.05, transitionDuration: 0.25 }
        },
        features: {
            layoutPreference: 'leftnav',
            search: true,
            deepLinking: true,
            analytics: true,
            crashReporting: true,
            overhangLogo: true,
            overhangClock: false,
            overhangOptions: false
        },
        ui: {
            backgroundColor: '0x1A1A2E',
            welcome: { enabled: true, title: 'Loading...', subtitle: 'Please wait' },
            error: {
                title: 'Connection Error',
                message: 'Unable to load content. Please check your network connection.',
                retryLabel: 'Retry'
            },
            loading: { message: 'Loading...' }
        },
        cardStyle: {
            showTitle: true,
            showDescription: true,
            titleFont: 'font:SmallBoldSystemFont',
            descriptionFont: 'font:SmallSystemFont',
            titleColor: '0xFFFFFF',
            descriptionColor: '0xA0A0B0',
            titleNumLines: 1,
            descriptionNumLines: 1,
            showDetailTitle: true,
            showDetailDescription: true,
            detailTitleFont: 'font:SmallBoldSystemFont',
            detailDescriptionFont: 'font:SmallSystemFont',
            detailTitleColor: '0xFFFFFF',
            detailDescriptionColor: '0xA0A0B0',
            detailTitleNumLines: 1,
            detailDescriptionNumLines: 3
        },
        navItems: [],
        pageRegistry: {},
        giving: {
            donationUrl: ''
        },
        heartbeat: {
            intervalSeconds: 60,
            exportUrl: '/api/heartbeat'
        }
    };
}

function ensureColorDefaults(config) {
    const defaultColors = getDefaultConfig().branding.colors;
    const colorFields = Object.keys(defaultColors);
    if (!config.branding) config.branding = {};
    if (!config.branding.colors) config.branding.colors = {};
    for (const field of colorFields) {
        if (config.branding.colors[field] === undefined) {
            config.branding.colors[field] = defaultColors[field];
        }
    }
    return config;
}

function validateConfig(config) {
    const errors = [];
    if (!config || typeof config !== 'object') {
        throw new Error('Config must be a valid object');
    }
    if (!config.channel || typeof config.channel !== 'object' || !config.channel.name || config.channel.name === '') {
        errors.push('channel.name is required and cannot be empty');
    } else if (typeof config.channel.name !== 'string') {
        errors.push('channel.name must be a string');
    }
    const colorFields = ['background', 'surface', 'accent', 'textPrimary', 'textSecondary', 'focus', 'error'];
    if (config.branding && config.branding.colors) {
        for (const field of colorFields) {
            if (config.branding.colors[field] !== undefined) {
                const val = config.branding.colors[field];
                if (typeof val !== 'string' || val.length < 4 || !val.startsWith('0x')) {
                    errors.push(`branding.colors.${field} must be a valid hex color (e.g., 0xFF0000)`);
                }
            }
        }
    }
    if (config.content) {
        if (typeof config.content.maxRows === 'number' && (config.content.maxRows < 1 || config.content.maxRows > 20)) {
            errors.push('content.maxRows must be between 1 and 20');
        }
        if (
            typeof config.content.maxItemsPerRow === 'number' &&
            (config.content.maxItemsPerRow < 1 || config.content.maxItemsPerRow > 50)
        ) {
            errors.push('content.maxItemsPerRow must be between 1 and 50');
        }
    }
    const featureFields = [
        'search',
        'deepLinking',
        'analytics',
        'crashReporting',
        'overhangLogo',
        'overhangClock',
        'overhangOptions',
        'continueWatching',
        'liveService',
        'offlineMode',
        'sermonCategories',
        'serviceSchedule',
        'watchLater'
    ];
    if (config.features) {
        for (const field of featureFields) {
            if (config.features[field] !== undefined && typeof config.features[field] !== 'boolean') {
                errors.push(`features.${field} must be a boolean`);
            }
        }
    }
    if (config.cardStyle) {
        const boolFields = ['showTitle', 'showDescription', 'showDetailTitle', 'showDetailDescription'];
        for (const field of boolFields) {
            if (config.cardStyle[field] !== undefined && typeof config.cardStyle[field] !== 'boolean') {
                errors.push(`cardStyle.${field} must be a boolean`);
            }
        }
        const intFields = ['titleNumLines', 'descriptionNumLines', 'detailTitleNumLines', 'detailDescriptionNumLines'];
        for (const field of intFields) {
            const val = config.cardStyle[field];
            if (val !== undefined && (typeof val !== 'number' || val < 1 || val > 10)) {
                errors.push(`cardStyle.${field} must be an integer between 1 and 10`);
            }
        }
    }
    if (errors.length > 0) {
        throw new Error('Config validation failed: ' + errors.join('; '));
    }
    return true;
}

function getConfigValue(config, dotPath) {
    const parts = dotPath.split('.');
    let current = config;
    for (const part of parts) {
        if (!current || typeof current !== 'object' || !(part in current)) return undefined;
        current = current[part];
    }
    return current;
}

function setConfigValue(config, dotPath, value) {
    const parts = dotPath.split('.');
    let current = config;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] === undefined || current[parts[i]] === null || typeof current[parts[i]] !== 'object') {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

module.exports = {
    loadConfig,
    saveConfig,
    initializeConfig,
    validateConfig,
    getConfigValue,
    setConfigValue,
    getDefaultConfig,
    // Named so an operator-facing surface (the admin panel, the Studio) can show the file it is
    // writing instead of assuming the repository's.
    configPath: CONFIG_PATH
};

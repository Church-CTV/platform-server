const fs = require('fs-extra');
const path = require('path');

const { videosDir } = require('./contentRoot');

const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
];

function isValidReleaseDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateFeed(feed) {
    const errors = [];
    const warnings = [];

    if (!feed || typeof feed !== 'object') {
        errors.push('Feed must be a valid object');
        return { valid: false, errors, warnings };
    }

    if (!feed.providerName || typeof feed.providerName !== 'string') {
        errors.push('providerName is required and must be a string');
    }

    if (!feed.lastUpdated) {
        warnings.push('lastUpdated is missing from feed');
    }

    // Validate embedded config section
    if (feed.config && typeof feed.config === 'object') {
        const configErrors = validateFeedConfig(feed.config);
        errors.push(...configErrors.errors);
        warnings.push(...configErrors.warnings);
    }

    // Validate top-level cardStyle if present (for backwards compat)
    if (feed.cardStyle && typeof feed.cardStyle === 'object') {
        const cardStyleErrors = validateCardStyle(feed.cardStyle);
        errors.push(...cardStyleErrors.errors);
        warnings.push(...cardStyleErrors.warnings);
    }

    const knownKeys = ['providerName', 'lastUpdated', 'language', 'config', 'cardStyle'];
    let videoCount = 0;
    let previousMonthOrder = Number.POSITIVE_INFINITY;

    for (const [key, value] of Object.entries(feed)) {
        // The frozen envelope version (GATE T1 `feed-v1.md`, D-T1-5: emit first, enforce later). It is
        // declared here rather than dropped into `knownKeys` because an ARRAY-valued version stamp is the
        // exact defect the client rule guards against: a published Roku collects every array-valued
        // top-level key as a month row (`MainLoaderTask.brs:313-317`), so `feedVersion: ["1"]` would draw a
        // phantom row on every television while validating cleanly. Scalar-or-refuse, named.
        if (key === 'feedVersion') {
            if (typeof value !== 'string' || value.trim() === '') {
                errors.push(
                    'feedVersion must be a non-empty string naming the feed contract version; an array-valued top-level key becomes a phantom month row on a Roku client'
                );
            }
            continue;
        }
        if (key === 'configVersion') {
            // `CACHE-11`: the document carries a `config` block, so it names which config it is, with the same
            // digest `/api/v2/config` publishes for that block. Declared alongside `feedVersion` for the same
            // reason and with the same shape rule: a scalar here is read by new clients and ignored by the
            // installed ones, while an array-valued top-level key would draw a phantom month row on every
            // television. A malformed digest is refused rather than carried, because a version a client cannot
            // compare against the config endpoint is worse than no version at all - it looks like agreement.
            if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
                errors.push(
                    'configVersion must be a 64-character lowercase hex digest of the embedded config block; an array-valued top-level key becomes a phantom month row on a Roku client'
                );
            }
            continue;
        }
        if (knownKeys.includes(key)) continue;
        if (!Array.isArray(value)) {
            errors.push(`Month key "${key}" must contain an array of videos`);
            continue;
        }

        const monthMatch = key.match(/^([A-Za-z]+)\s+(\d{4})$/);
        const monthIndex = monthMatch ? MONTH_NAMES.indexOf(monthMatch[1]) : -1;
        let expectedMonth = null;
        if (monthIndex < 0) {
            errors.push(`Month key "${key}" must use a valid month name and year`);
        } else {
            const monthOrder = Number(monthMatch[2]) * 12 + monthIndex;
            if (monthOrder > previousMonthOrder) {
                errors.push(`Month rows must be sorted newest-first, but "${key}" is out of order`);
            }
            previousMonthOrder = monthOrder;
            expectedMonth = { monthIndex, year: Number(monthMatch[2]) };
        }

        let previousReleaseDate = null;
        value.forEach((item, idx) => {
            const itemPath = `${key}[${idx}]`;
            if (!item.title || typeof item.title !== 'string') {
                errors.push(`${itemPath}: title is required`);
            }
            if (!item.thumbnail || typeof item.thumbnail !== 'string') {
                errors.push(`${itemPath}: thumbnail URL is required`);
            }
            if (!isValidReleaseDate(item.releaseDate)) {
                errors.push(`${itemPath}: releaseDate must be a valid YYYY-MM-DD date`);
            } else {
                const releaseDate = new Date(`${item.releaseDate}T00:00:00Z`);
                if (
                    expectedMonth &&
                    (releaseDate.getUTCFullYear() !== expectedMonth.year ||
                        releaseDate.getUTCMonth() !== expectedMonth.monthIndex)
                ) {
                    errors.push(`${itemPath}: releaseDate does not belong in month row "${key}"`);
                }
                if (previousReleaseDate && item.releaseDate > previousReleaseDate) {
                    errors.push(`${itemPath}: videos in "${key}" must be sorted newest-first`);
                }
                previousReleaseDate = item.releaseDate;
            }
            if (
                !item.content ||
                !item.content.videos ||
                !Array.isArray(item.content.videos) ||
                item.content.videos.length === 0
            ) {
                errors.push(`${itemPath}: content.videos must be a non-empty array`);
            } else {
                const video = item.content.videos[0];
                if (!video.url || typeof video.url !== 'string') {
                    errors.push(`${itemPath}: video URL is required`);
                } else {
                    const videoFilename = path.basename(video.url.split('/stream/')[1] || '');
                    const videoPath = path.resolve(videosDir(), decodeURIComponent(videoFilename));
                    if (!videoPath.startsWith(videosDir() + path.sep)) {
                        errors.push(`${itemPath}: video path traversal detected for ${video.url}`);
                    } else if (!fs.existsSync(videoPath)) {
                        errors.push(`${itemPath}: video file not found at ${videoPath}`);
                    }
                }
            }
            videoCount++;
        });
    }

    if (videoCount === 0 && errors.length === 0) {
        warnings.push('Feed contains no videos');
    }

    return { valid: errors.length === 0, errors, warnings, videoCount };
}

function validateFeedConfig(config) {
    const errors = [];
    const warnings = [];

    if (
        !config.channel ||
        typeof config.channel !== 'object' ||
        !config.channel.name ||
        typeof config.channel.name !== 'string'
    ) {
        errors.push('config.channel.name is required and must be a string');
    }

    const colorFields = ['background', 'surface', 'accent', 'textPrimary', 'textSecondary', 'focus', 'error'];
    if (config.branding && config.branding.colors) {
        for (const field of colorFields) {
            if (config.branding.colors[field] !== undefined) {
                const val = config.branding.colors[field];
                if (typeof val !== 'string' || !val.startsWith('0x')) {
                    errors.push(`config.branding.colors.${field} must be a hex color`);
                }
            }
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
                errors.push(`config.features.${field} must be a boolean`);
            }
        }
    }

    return { errors, warnings };
}

function validateCardStyle(cardStyle) {
    const errors = [];
    const warnings = [];

    if (!cardStyle || typeof cardStyle !== 'object') return { errors, warnings };

    const boolFields = ['showTitle', 'showDescription', 'showDetailTitle', 'showDetailDescription'];
    for (const field of boolFields) {
        if (cardStyle[field] !== undefined && typeof cardStyle[field] !== 'boolean') {
            errors.push(`cardStyle.${field} must be a boolean`);
        }
    }

    const intFields = ['titleNumLines', 'descriptionNumLines', 'detailTitleNumLines', 'detailDescriptionNumLines'];
    for (const field of intFields) {
        const val = cardStyle[field];
        if (val !== undefined && (typeof val !== 'number' || val < 1 || val > 10)) {
            errors.push(`cardStyle.${field} must be an integer between 1 and 10`);
        }
    }

    return { errors, warnings };
}

module.exports = { validateFeed, validateFeedConfig, validateCardStyle };

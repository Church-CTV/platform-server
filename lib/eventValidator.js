const VALID_EVENT_TYPES = [
    'screen_view',
    'content_play',
    'deep_link',
    'error',
    'interaction',
    'playback_state',
    'unknown'
];

const TYPE_REQUIRED_FIELDS = {
    screen_view: ['screenName'],
    content_play: ['contentId'],
    deep_link: ['contentId', 'mediaType'],
    error: ['errorType'],
    interaction: ['action'],
    playback_state: ['state']
};

function sanitizeString(val) {
    if (typeof val !== 'string') return val;
    return val.replace(
        /[<>]/g,
        (c) =>
            ({
                '<': '&lt;',
                '>': '&gt;'
            })[c]
    );
}

function sanitizePayload(payload) {
    if (typeof payload !== 'object' || payload === null) return payload;
    const sanitized = {};
    for (const [key, value] of Object.entries(payload)) {
        if (typeof value === 'string') {
            sanitized[sanitizeString(key)] = sanitizeString(value);
        } else if (typeof value === 'object' && value !== null) {
            sanitized[sanitizeString(key)] = sanitizePayload(value);
        } else {
            sanitized[sanitizeString(key)] = value;
        }
    }
    return sanitized;
}

function validateEvent(event) {
    const errors = [];

    if (!event || typeof event !== 'object') {
        return { valid: false, errors: ['Event must be an object'] };
    }

    // Required common fields
    if (!event.eventType && !event.event_type) {
        errors.push('Missing eventType');
    }

    const eventType = event.eventType || event.event_type;

    if (typeof eventType !== 'string') {
        errors.push('eventType must be a string');
    } else if (!VALID_EVENT_TYPES.includes(eventType)) {
        errors.push(`Unknown event type: ${eventType}`);
        return { valid: false, errors };
    }

    if (!event.timestamp && !event.Timestamp) {
        errors.push('Missing timestamp');
    }

    if (event.sessionDuration !== undefined && event.sessionDuration !== null) {
        if (typeof event.sessionDuration !== 'number' || event.sessionDuration < 0) {
            errors.push('sessionDuration must be a non-negative number');
        }
    }

    // Type-specific required fields
    const requiredFields = TYPE_REQUIRED_FIELDS[eventType];
    if (requiredFields) {
        for (const field of requiredFields) {
            // Check original field name and lowercase variant
            const hasField = event[field] !== undefined || event[field.toLowerCase()] !== undefined;
            if (!hasField) {
                errors.push(`Missing required field for ${eventType}: ${field}`);
            }
        }
    }

    return { valid: errors.length === 0, errors, eventType };
}

function validateDeviceInfo(deviceInfo) {
    if (!deviceInfo || typeof deviceInfo !== 'object')
        return { valid: false, errors: ['deviceInfo must be an object'] };

    const errors = [];

    if (!deviceInfo.deviceId && !deviceInfo.device_id) {
        errors.push('Missing deviceId');
    }

    return { valid: errors.length === 0, errors };
}

function flattenRokuEvents(eventsObj) {
    if (!eventsObj || typeof eventsObj !== 'object') {
        return [];
    }
    const flat = [];
    const eventCategories = ['screenViews', 'plays', 'deepLinks', 'errors'];
    for (const category of eventCategories) {
        const items = eventsObj[category];
        if (Array.isArray(items)) {
            for (const item of items) {
                if (item && typeof item === 'object') {
                    flat.push(item);
                }
            }
        }
        // Non-array items are silently ignored (defensive handling)
    }
    return flat;
}

function extractEventsFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;

    // Format 1: Roku structured payload with nested events object
    // { events: { screenViews: [...], plays: [...], deepLinks: [...], errors: [...] } }
    if (payload.events && typeof payload.events === 'object' && !Array.isArray(payload.events)) {
        return flattenRokuEvents(payload.events);
    }

    // Format 2: Standard flat events array
    // { events: [...] } or { Events: [...] }
    if (Array.isArray(payload.events)) {
        return payload.events;
    }
    if (Array.isArray(payload.Events)) {
        return payload.Events;
    }

    return null;
}

function validateBatchPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { valid: false, errors: ['Payload must be an object'] };
    }

    const events = extractEventsFromPayload(payload);
    if (!events) {
        return { valid: false, errors: ['Payload must contain an events array or nested events object'] };
    }

    const accepted = [];
    const rejected = [];

    for (const event of events) {
        const validation = validateEvent(event);
        if (validation.valid) {
            accepted.push({ event, eventType: validation.eventType });
        } else {
            rejected.push({ event, errors: validation.errors });
        }
    }

    return { valid: true, accepted, rejected };
}

module.exports = {
    VALID_EVENT_TYPES,
    TYPE_REQUIRED_FIELDS,
    validateEvent,
    validateDeviceInfo,
    validateBatchPayload,
    sanitizePayload,
    sanitizeString,
    flattenRokuEvents,
    extractEventsFromPayload
};

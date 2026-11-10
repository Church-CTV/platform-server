import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
    validateEvent,
    validateDeviceInfo,
    validateBatchPayload,
    sanitizeString,
    sanitizePayload,
    flattenRokuEvents,
    extractEventsFromPayload,
    VALID_EVENT_TYPES,
    TYPE_REQUIRED_FIELDS
} = require('../../lib/eventValidator.js');

describe('eventValidator - sanitizeString', () => {
    it('escapes HTML angle brackets', () => {
        assert.strictEqual(sanitizeString('<script>'), '&lt;script&gt;');
        assert.strictEqual(sanitizeString('a < b > c'), 'a &lt; b &gt; c');
    });

    it('preserves other characters', () => {
        assert.strictEqual(sanitizeString('"quoted"'), '"quoted"');
        assert.strictEqual(sanitizeString("it's"), "it's");
        assert.strictEqual(sanitizeString('a & b'), 'a & b');
        assert.strictEqual(sanitizeString('a + b'), 'a + b');
    });

    it('handles non-string input', () => {
        assert.strictEqual(sanitizeString(123), 123);
        assert.strictEqual(sanitizeString(null), null);
        assert.strictEqual(sanitizeString(undefined), undefined);
    });
});

describe('eventValidator - sanitizePayload', () => {
    it('sanitizes string values in object', () => {
        const result = sanitizePayload({ name: '<test>', value: 'normal' });
        assert.strictEqual(result.name, '&lt;test&gt;');
        assert.strictEqual(result.value, 'normal');
    });

    it('sanitizes string keys', () => {
        const result = sanitizePayload({ '<key>': 'value' });
        assert.ok(result['&lt;key&gt;'] === 'value');
    });

    it('handles nested objects', () => {
        const result = sanitizePayload({ outer: { inner: '<val>' } });
        assert.strictEqual(result.outer.inner, '&lt;val&gt;');
    });

    it('handles non-object input', () => {
        assert.strictEqual(sanitizePayload(null), null);
        assert.strictEqual(sanitizePayload(123), 123);
        assert.strictEqual(sanitizePayload('string'), 'string');
    });
});

describe('eventValidator - validateEvent', () => {
    it('accepts all valid event types', () => {
        const validEvents = [
            { eventType: 'screen_view', timestamp: '12:00:00', screenName: 'Home' },
            { eventType: 'content_play', timestamp: '12:00:00', contentId: 'vid1' },
            { eventType: 'deep_link', timestamp: '12:00:00', contentId: 'vid1', mediaType: 'video' },
            { eventType: 'error', timestamp: '12:00:00', errorType: 'network' },
            { eventType: 'interaction', timestamp: '12:00:00', action: 'click' },
            { eventType: 'playback_state', timestamp: '12:00:00', state: 'playing' },
            { eventType: 'unknown', timestamp: '12:00:00' }
        ];

        for (const event of validEvents) {
            const result = validateEvent(event);
            assert.strictEqual(result.valid, true, `Should accept ${event.eventType}`);
        }
    });

    it('rejects missing eventType', () => {
        const result = validateEvent({ timestamp: '12:00:00' });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.some((e) => e.includes('Missing eventType')));
    });

    it('rejects missing timestamp', () => {
        const result = validateEvent({ eventType: 'screen_view', screenName: 'Home' });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.some((e) => e.includes('Missing timestamp')));
    });

    it('rejects unknown event type', () => {
        const result = validateEvent({ eventType: 'invalid_type', timestamp: '12:00:00' });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.some((e) => e.includes('Unknown event type')));
    });

    it('rejects invalid sessionDuration', () => {
        const result = validateEvent({
            eventType: 'screen_view',
            timestamp: '12:00:00',
            screenName: 'Home',
            sessionDuration: -1
        });
        assert.ok(result.errors.some((e) => e.includes('sessionDuration')));
    });

    it('accepts null/undefined sessionDuration', () => {
        const result = validateEvent({
            eventType: 'screen_view',
            timestamp: '12:00:00',
            screenName: 'Home',
            sessionDuration: null
        });
        assert.strictEqual(result.valid, true);
    });

    it('rejects missing required fields for each type', () => {
        const requiredFieldTests = [
            { eventType: 'screen_view', field: 'screenName' },
            { eventType: 'content_play', field: 'contentId' },
            { eventType: 'deep_link', field: 'contentId' },
            { eventType: 'error', field: 'errorType' },
            { eventType: 'interaction', field: 'action' },
            { eventType: 'playback_state', field: 'state' }
        ];

        for (const test of requiredFieldTests) {
            const result = validateEvent({
                eventType: test.eventType,
                timestamp: '12:00:00'
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some((e) => e.includes(test.field)));
        }
    });

    it('rejects null event', () => {
        const result = validateEvent(null);
        assert.strictEqual(result.valid, false);
    });

    it('rejects non-object event', () => {
        assert.strictEqual(validateEvent('string').valid, false);
        assert.strictEqual(validateEvent(123).valid, false);
        assert.strictEqual(validateEvent([]).valid, false);
    });

    it('accepts event_type alias for eventType', () => {
        const result = validateEvent({
            event_type: 'screen_view',
            timestamp: '12:00:00',
            screenName: 'Home'
        });
        assert.strictEqual(result.valid, true);
    });

    it('accepts Timestamp alias for timestamp', () => {
        const result = validateEvent({
            eventType: 'screen_view',
            Timestamp: '12:00:00',
            screenName: 'Home'
        });
        assert.strictEqual(result.valid, true);
    });
});

describe('eventValidator - validateDeviceInfo', () => {
    it('accepts valid deviceInfo', () => {
        const result = validateDeviceInfo({ deviceId: 'device-123' });
        assert.strictEqual(result.valid, true);
    });

    it('rejects missing deviceId', () => {
        const result = validateDeviceInfo({});
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.some((e) => e.includes('Missing deviceId')));
    });

    it('rejects null deviceInfo', () => {
        const result = validateDeviceInfo(null);
        assert.strictEqual(result.valid, false);
    });
});

describe('eventValidator - flattenRokuEvents', () => {
    it('flattens all event categories', () => {
        const eventsObj = {
            screenViews: [{ id: 1 }, { id: 2 }],
            plays: [{ id: 3 }],
            deepLinks: [{ id: 4 }],
            errors: [{ id: 5 }]
        };
        const result = flattenRokuEvents(eventsObj);
        assert.strictEqual(result.length, 5);
    });

    it('handles missing categories', () => {
        const eventsObj = { screenViews: [{ id: 1 }] };
        const result = flattenRokuEvents(eventsObj);
        assert.strictEqual(result.length, 1);
    });

    it('filters out non-object items', () => {
        const eventsObj = {
            screenViews: [{ id: 1 }, null, 'string', 123, undefined, { id: 2 }]
        };
        const result = flattenRokuEvents(eventsObj);
        assert.strictEqual(result.length, 2);
    });

    it('handles empty arrays', () => {
        const eventsObj = { screenViews: [], plays: [] };
        const result = flattenRokuEvents(eventsObj);
        assert.strictEqual(result.length, 0);
    });

    it('handles non-array categories gracefully', () => {
        const eventsObj = { screenViews: 'not-array', plays: 123 };
        const result = flattenRokuEvents(eventsObj);
        assert.strictEqual(result.length, 0);
    });
});

describe('eventValidator - extractEventsFromPayload', () => {
    it('extracts from Roku nested format', () => {
        const payload = {
            events: {
                screenViews: [{ id: 1 }],
                plays: [{ id: 2 }]
            }
        };
        const result = extractEventsFromPayload(payload);
        assert.strictEqual(result.length, 2);
    });

    it('extracts from flat events array', () => {
        const payload = { events: [{ id: 1 }, { id: 2 }] };
        const result = extractEventsFromPayload(payload);
        assert.strictEqual(result.length, 2);
    });

    it('extracts from capitalized Events array', () => {
        const payload = { Events: [{ id: 1 }] };
        const result = extractEventsFromPayload(payload);
        assert.strictEqual(result.length, 1);
    });

    it('returns null for payload without events', () => {
        assert.strictEqual(extractEventsFromPayload({ data: [] }), null);
        assert.strictEqual(extractEventsFromPayload({}), null);
    });

    it('returns null for null payload', () => {
        assert.strictEqual(extractEventsFromPayload(null), null);
    });

    it('returns null for non-object payload', () => {
        assert.strictEqual(extractEventsFromPayload('string'), null);
    });
});

describe('eventValidator - validateBatchPayload', () => {
    it('accepts valid batch payload', () => {
        const result = validateBatchPayload({
            events: [
                { eventType: 'screen_view', timestamp: '12:00:00', screenName: 'Home' },
                { eventType: 'content_play', timestamp: '12:00:00', contentId: 'vid1' }
            ]
        });
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.accepted.length, 2);
        assert.strictEqual(result.rejected.length, 0);
    });

    it('partially accepts mixed payload', () => {
        const result = validateBatchPayload({
            events: [
                { eventType: 'screen_view', timestamp: '12:00:00', screenName: 'Home' },
                { eventType: 'invalid', timestamp: '12:00:00' }
            ]
        });
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.accepted.length, 1);
        assert.strictEqual(result.rejected.length, 1);
    });

    it('rejects payload without events', () => {
        const result = validateBatchPayload({ data: [] });
        assert.strictEqual(result.valid, false);
    });

    it('rejects null payload', () => {
        const result = validateBatchPayload(null);
        assert.strictEqual(result.valid, false);
    });

    it('handles Roku nested format in batch', () => {
        const result = validateBatchPayload({
            events: {
                screenViews: [{ eventType: 'screen_view', timestamp: '12:00:00', screenName: 'Home' }],
                plays: [{ eventType: 'content_play', timestamp: '12:00:00', contentId: 'vid1' }]
            }
        });
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.accepted.length, 2);
    });
});

describe('eventValidator - constants', () => {
    it('has all expected valid event types', () => {
        const expected = [
            'screen_view',
            'content_play',
            'deep_link',
            'error',
            'interaction',
            'playback_state',
            'unknown'
        ];
        assert.deepStrictEqual(VALID_EVENT_TYPES.sort(), expected.sort());
    });

    it('has required fields for each event type', () => {
        assert.ok(TYPE_REQUIRED_FIELDS.screen_view.includes('screenName'));
        assert.ok(TYPE_REQUIRED_FIELDS.content_play.includes('contentId'));
        assert.ok(TYPE_REQUIRED_FIELDS.deep_link.includes('contentId'));
        assert.ok(TYPE_REQUIRED_FIELDS.deep_link.includes('mediaType'));
        assert.ok(TYPE_REQUIRED_FIELDS.error.includes('errorType'));
        assert.ok(TYPE_REQUIRED_FIELDS.interaction.includes('action'));
        assert.ok(TYPE_REQUIRED_FIELDS.playback_state.includes('state'));
    });
});

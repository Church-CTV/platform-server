import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const schema = require('../../schemas/ctv-config-v1.json');
const Ajv = require('ajv');

// Why this file exists: measured 2026-11-08, the config block the feed generator writes into the
// feed carries `sermon` and `offline`, and the published client contract defines neither and
// refuses unknown keys. The live example-channel feed (channel.example.invalid/feed) ships both today, so a client
// that fail-closes on its own config - which is what the Roku template's self-test does - is
// handed a block it must refuse. The fix belongs at the producer, not in a lenient reader.
describe('the feed generator emits the client contract, not the legacy store', () => {
    const legacyStore = {
        channel: {
            name: 'Example Channel',
            description: 'MC Meets Here!',
            language: 'en',
            copyright: 'Copyright 2026'
        },
        branding: {
            colors: { background: '0x1A1A2E', accent: '0xE8B931' },
            images: { overhangLogo: 'pkg:/images/logo.png' }
        },
        cardStyle: { showTitle: false },
        features: { search: true, liveService: true },
        ui: { backgroundColor: '0x1A1A2E' },
        content: { sourceUrl: '/api/v2/feed', maxRows: 20 },
        analytics: { exportUrl: '/api/v2/analytics' },
        sermon: { scheduleUrl: '/api/schedule', liveStreamUrl: '/live' },
        offline: { maxDownloads: 10, preferredQuality: '720p' },
        navItems: [{ id: 'home', label: 'Home' }],
        pageRegistry: { home: { component: 'GridScreen' } },
        giving: { donationUrl: 'https://example.test/giving' },
        heartbeat: { intervalSeconds: 60, exportUrl: '/api/v2/heartbeat' }
    };

    it('builds a config block that the published contract accepts, key by key', () => {
        const { buildClientConfig } = require('../../lib/feedGenerator.js');
        assert.equal(typeof buildClientConfig, 'function', 'the emitted block has no seam to test');
        const block = buildClientConfig(legacyStore, 'https://example.test/api/v2');
        for (const key of Object.keys(block)) {
            assert.ok(key in schema.properties, `emitted a key the contract does not define: ${key}`);
        }
        assert.equal(block.sermon, undefined, 'the legacy sermon block still ships to clients');
        assert.equal(block.offline, undefined, 'the legacy offline block still ships to clients');
        assert.equal(block.channel.name, 'Example Channel');
        assert.equal(block.server.baseUrl, 'https://example.test/api/v2');
        assert.deepEqual(block.navItems, legacyStore.navItems);
        assert.deepEqual(block.giving, legacyStore.giving);
    });

    it('refuses to invent values for a contract key the store does not carry', () => {
        const { buildClientConfig } = require('../../lib/feedGenerator.js');
        const block = buildClientConfig({ channel: { name: 'Only A Name' } }, 'https://example.test/api/v2');
        assert.equal(block.branding, undefined, 'an absent block was fabricated out of a default');
        assert.equal(block.analytics, undefined, 'an absent analytics block was fabricated');
        assert.equal(block.channel.name, 'Only A Name');
        // `content` is the one block the contract requires and only this server can name, so it is
        // resolved rather than invented: it points at this server's own feed.
        assert.equal(block.content.sourceUrl, 'https://example.test/api/v2/feed');
    });

    it('a store carrying a key outside the contract does not pass it through to the feed', () => {
        const { buildClientConfig } = require('../../lib/feedGenerator.js');
        const block = buildClientConfig(
            { ...legacyStore, tomorrow: { plan: 'someday' } },
            'https://example.test/api/v2'
        );
        assert.equal(block.tomorrow, undefined, 'an unknown store key rode the feed out to every television');
    });

    it('the shape a real deployment produces validates against the published schema', () => {
        const validate = new Ajv({ allErrors: true }).compile(schema);
        const { buildClientConfig } = require('../../lib/feedGenerator.js');
        const config = require('../../config.json');
        const block = buildClientConfig(config, 'https://channel.example.invalid/api/v2');
        assert.ok(validate(block), JSON.stringify(validate.errors));
    });

    it('a fresh install seeded from the built-in defaults produces a store the contract accepts', () => {
        // `configStore.getDefaultConfig()` and `config.template.json` are what a first-run box ends
        // up editing, and that file is now the store the television reads. A store the layer gate
        // refuses means every admin edit is ignored - loudly, but still ignored - so the seeded
        // shape has to survive the gate. Measured 2026-11-08: the template shipped
        // `giving.donationUrl: ""` and `heartbeat.exportUrl: "/api/heartbeat"`, both of which the
        // client contract writes as `format: uri`, which is why the server resolves endpoints and
        // the operator file is not required to be absolute.
        const { resolve, validateEffective, normalizeEndpoints } = require('../../lib/effectiveConfig.js');
        const { getDefaultConfig } = require('../../lib/configStore.js');
        const { buildClientConfig } = require('../../lib/feedGenerator.js');
        const path = require('node:path');
        const os = require('node:os');
        const noStore = path.join(
            os.tmpdir(),
            `ctv-no-store-${process.pid}-${Math.random().toString(36).slice(2)}.json`
        );
        const origin = 'https://first-run.test';
        const defaults = getDefaultConfig();
        assert.equal(defaults.sermon, undefined, 'the seeded store still carries the legacy sermon block');
        assert.equal(defaults.offline, undefined, 'the seeded store still carries the legacy offline block');
        const seeded = resolve({
            base: require('../../config.template.json'),
            storePath: noStore,
            repair: (config) => normalizeEndpoints(config, origin)
        });
        // The committed template ships `content.sourceUrl: ""`, so a box that has been installed but
        // never configured is refused - correctly, because a channel with no content source is not a
        // channel. This is the line the first-run wizard exists to clear, and it must read as one
        // reason a UI can act on, not as a cascade of deleted values.
        assert.equal(seeded.config, null, 'an unconfigured install was served a config anyway');
        assert.match(seeded.reason, /missing-required:content\.sourceUrl/);
        writeFileSync(
            noStore,
            JSON.stringify({
                content: { sourceUrl: '/feed' },
                giving: { donationUrl: '' },
                heartbeat: { exportUrl: '/api/heartbeat' }
            })
        );
        const firstRun = resolve({
            base: require('../../config.template.json'),
            storePath: noStore,
            repair: (config) => normalizeEndpoints(config, origin)
        });
        assert.equal(firstRun.degraded, false, `a configured first run was refused: ${firstRun.reason}`);
        assert.deepEqual(validateEffective(firstRun.config), []);
        assert.equal(
            firstRun.config.content.sourceUrl,
            `${origin}/feed`,
            'a relative feed stayed relative on the wire'
        );
        assert.equal(
            firstRun.config.heartbeat.exportUrl,
            `${origin}/api/heartbeat`,
            'a relative endpoint stayed relative on the wire'
        );
        assert.equal(
            firstRun.config.giving.donationUrl,
            undefined,
            'an empty giving link was served as if it were a link'
        );
        assert.deepEqual(validateEffective(buildClientConfig(defaults, `${origin}/api/v2`)), []);
        assert.equal(defaults.sermon, undefined, 'the seeded defaults still carry the legacy sermon block');
        assert.equal(defaults.offline, undefined, 'the seeded defaults still carry the legacy offline block');
    });
});

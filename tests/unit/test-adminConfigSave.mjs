import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

it('actual admin config handler preserves unedited client configuration', () => {
    const store = require('../../lib/configStore.js');
    const audit = require('../../lib/auditLog.js');
    const router = require('../../routes/admin.js');
    const route = router.stack.find((layer) => layer.route?.path === '/config' && layer.route.methods.post);
    const handler = route.route.stack.at(-1).handle;
    const original = {
        load: store.loadConfig,
        save: store.saveConfig,
        validate: store.validateConfig,
        log: audit.logEvent
    };
    const existing = {
        channel: { name: 'example channel', description: 'Ministry', extra: 'preserved' },
        branding: { colors: { textPrimary: '0xFFFFFF', custom: '0x123456' }, images: { custom: 'image' } },
        features: { search: true },
        ui: { theme: 'dark' },
        cardStyle: { showTitle: false },
        content: { maxRows: 20 },
        analytics: { exportUrl: '/analytics' },
        unknown: { future: true }
    };
    let saved;
    const flashes = [];
    try {
        store.loadConfig = () => structuredClone(existing);
        store.saveConfig = (config) => {
            saved = config;
        };
        store.validateConfig = () => {};
        audit.logEvent = () => {};
        handler(
            {
                body: { channelName: 'Edited', channelDescription: 'New description', colorBackground: '#000000' },
                flash: (...args) => flashes.push(args)
            },
            { redirect: () => {} }
        );
        assert.ok(saved, JSON.stringify(flashes));
        for (const key of ['features', 'ui', 'cardStyle', 'content', 'analytics', 'unknown']) {
            assert.deepEqual(saved[key], existing[key], `lost ${key}`);
        }
        assert.equal(saved.channel.name, 'Edited');
        assert.equal(saved.channel.extra, 'preserved');
        assert.equal(saved.branding.colors.background, '0x000000');
        assert.equal(saved.branding.colors.custom, '0x123456');
        assert.equal(saved.branding.images.custom, 'image');
        assert.ok(flashes.some(([kind]) => kind === 'success'));
    } finally {
        store.loadConfig = original.load;
        store.saveConfig = original.save;
        store.validateConfig = original.validate;
        audit.logEvent = original.log;
    }
});

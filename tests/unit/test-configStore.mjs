import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const TEST_BACKUP = path.join(process.cwd(), 'config.json.configstore_backup');

function backupConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        if (fs.existsSync(TEST_BACKUP)) fs.rmSync(TEST_BACKUP);
        fs.copyFileSync(CONFIG_PATH, TEST_BACKUP);
    }
}

function restoreConfig() {
    if (fs.existsSync(TEST_BACKUP)) {
        fs.copyFileSync(TEST_BACKUP, CONFIG_PATH);
        fs.rmSync(TEST_BACKUP);
    }
}

describe('configStore', () => {
    let configStore;

    before(() => {
        backupConfig();
        configStore = require('../../lib/configStore.js');
    });

    after(() => {
        restoreConfig();
    });

    it('initializes config from template when missing', () => {
        const tempBackup = CONFIG_PATH + '.init_test';
        if (fs.existsSync(CONFIG_PATH)) {
            fs.renameSync(CONFIG_PATH, tempBackup);
        }
        assert.ok(!fs.existsSync(CONFIG_PATH));
        // Clear require cache so loadConfig re-evaluates file existence
        delete require.cache[require.resolve('../../lib/configStore.js')];
        const freshConfigStore = require('../../lib/configStore.js');
        const config = freshConfigStore.loadConfig();
        // Restore original config immediately to avoid race with other tests
        if (fs.existsSync(tempBackup)) {
            fs.renameSync(tempBackup, CONFIG_PATH);
        }
        assert.ok(fs.existsSync(CONFIG_PATH));
        assert.ok(config.channel);
        assert.ok(config.channel.name);
    });

    it('validates required channel.name', () => {
        assert.throws(() => configStore.validateConfig({ channel: {} }), /channel\.name is required/);
    });

    it('rejects invalid hex colors', () => {
        assert.throws(
            () =>
                configStore.validateConfig({
                    channel: { name: 'Test' },
                    branding: { colors: { background: 'not-hex' } }
                }),
            /must be a valid hex color/
        );
    });

    it('accepts valid config', () => {
        const valid = {
            channel: { name: 'Test Church' },
            branding: { colors: { background: '0x1A1A2E' } },
            features: { search: true, analytics: false },
            cardStyle: { showTitle: true, titleNumLines: 2 }
        };
        assert.doesNotThrow(() => configStore.validateConfig(valid));
    });

    it('rejects non-boolean feature flags', () => {
        assert.throws(
            () =>
                configStore.validateConfig({
                    channel: { name: 'Test' },
                    features: { search: 'yes' }
                }),
            /must be a boolean/
        );
    });

    it('rejects out-of-range cardStyle integers', () => {
        assert.throws(
            () =>
                configStore.validateConfig({
                    channel: { name: 'Test' },
                    cardStyle: { titleNumLines: 15 }
                }),
            /must be an integer between 1 and 10/
        );
    });

    it('getConfigValue traverses dot notation', () => {
        const config = { a: { b: { c: 42 } } };
        assert.strictEqual(configStore.getConfigValue(config, 'a.b.c'), 42);
        assert.strictEqual(configStore.getConfigValue(config, 'a.b.missing'), undefined);
    });

    it('setConfigValue creates intermediate objects', () => {
        const config = {};
        configStore.setConfigValue(config, 'x.y.z', 'hello');
        assert.strictEqual(config.x.y.z, 'hello');
    });
});

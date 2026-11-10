import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const temp = mkdtempSync(path.join(tmpdir(), 'ctv-effective-config-'));
after(() => rmSync(temp, { recursive: true, force: true }));

const schema = require('../../schemas/ctv-config-v1.json');
let caseCount = 0;
function file(name, value) {
    const p = path.join(temp, `${name}-${caseCount++}.json`);
    writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
    return p;
}
function loadModule() {
    return require('../../lib/effectiveConfig.js');
}
function baseConfig(overrides = {}) {
    return {
        version: '1.0.0',
        channel: { name: 'Feed Embedded TV', description: 'from the feed' },
        branding: { colors: { accent: '0x111111', background: '0x222222' } },
        content: { sourceUrl: 'https://example.test/feed', maxRows: 12 },
        features: { search: true, liveService: false },
        server: { baseUrl: 'https://example.test/api/v2', configRefreshSeconds: 5 },
        ...overrides
    };
}

describe('effectiveConfig: one store, fail closed, never a partial apply', () => {
    it('refuses to serve a config the client contract rejects, with a machine-readable reason', () => {
        const { resolve } = loadModule();
        const r = resolve({ storePath: file('absent-store', {}) });
        assert.equal(r.config, null, `no layer supplied a valid config, got ${JSON.stringify(r.config)}`);
        assert.match(r.reason, /invalid-effective-config/);
        assert.ok(Array.isArray(r.refusedKeys) && r.refusedKeys.length === 0, 'no keys were at fault here');
    });

    it('operator store wins field-wise and keeps unrelated defaults from lower layers', () => {
        const { resolve } = loadModule();
        const profile = file('profile', { clientConfig: baseConfig({ channel: { name: 'Profile TV' } }) });
        const store = file('store', {
            channel: { name: 'Edited By The Admin' },
            branding: { colors: { accent: '0xABCDEF' } }
        });
        const r = resolve({ base: baseConfig(), profilePath: profile, storePath: store });
        assert.equal(r.degraded, false, r.reason);
        assert.equal(r.config.channel.name, 'Edited By The Admin');
        assert.equal(r.config.channel.description, 'from the feed', 'merge deleted an untouched sibling field');
        assert.equal(r.config.branding.colors.accent, '0xABCDEF');
        assert.equal(r.config.branding.colors.background, '0x222222', 'merge lost a colour nobody edited');
        assert.equal(r.config.content.maxRows, 12, 'merge lost the content block');
        assert.deepEqual(
            r.source,
            ['feed', 'profile', 'store'],
            'every applied layer must be reportable, in precedence order'
        );
    });

    it('an explicit false, zero or empty value in the store overrides a truthy default', () => {
        const { resolve } = loadModule();
        const store = file('store-falsy', {
            features: { search: false },
            content: { maxRows: 0 },
            channel: { description: '' }
        });
        const r = resolve({ base: baseConfig(), storePath: store });
        assert.equal(r.degraded, false, r.reason);
        assert.equal(r.config.features.search, false);
        assert.equal(r.config.channel.description, '');
        assert.ok(r.degraded === false);
    });

    it('configVersion is the sha256 of the effective config and moves when the store moves', () => {
        const { resolve } = loadModule();
        const a = resolve({ base: baseConfig(), storePath: file('v1', { channel: { name: 'First' } }) });
        const b = resolve({ base: baseConfig(), storePath: file('v2', { channel: { name: 'Second' } }) });
        const again = resolve({ base: baseConfig(), storePath: a.storePath });
        assert.equal(a.configVersion, crypto.createHash('sha256').update(JSON.stringify(a.config)).digest('hex'));
        assert.equal(again.configVersion, a.configVersion, 'the same inputs produced a different version');
        assert.notEqual(b.configVersion, a.configVersion, 'an edit did not change the version the TVs compare');
    });

    it('a store key the contract does not know is reported, never served', () => {
        const { resolve } = loadModule();
        const store = file('store-unknown', { branding: { nope: 'surprise' }, features: { search: false } });
        const r = resolve({ base: baseConfig(), storePath: store });
        assert.equal(r.degraded, true, 'an invalid layer was served as if it were valid');
        assert.match(r.reason, /store-rejected/);
        assert.ok(r.refusedKeys.includes('unknown-key:branding.nope'), `refusedKeys=${JSON.stringify(r.refusedKeys)}`);
        assert.equal(r.config.features.search, true, 'a valid sibling edit was dropped along with the bad key');
        assert.equal(r.config.branding.nope, undefined, 'the refused key still reached the client');
        assert.equal(r.source.includes('store'), false, 'a rejected layer must not be listed as applied');
    });

    it('an unreadable store on disk is reported, and the last known good config still serves', () => {
        const { resolve } = loadModule();
        const broken = file('broken', '{ not json');
        const r = resolve({ base: baseConfig(), storePath: broken });
        assert.equal(r.degraded, true);
        assert.match(r.reason, /store-unreadable/);
        assert.equal(r.config.channel.name, 'Feed Embedded TV');
        assert.equal(typeof r.configVersion, 'string');
    });

    it('writeOverride validates before touching the file, and leaves the bytes alone when it refuses', () => {
        const { resolve, writeOverride } = loadModule();
        const store = file('write-target', { channel: { name: 'Before' } });
        const before = readFileSync(store, 'utf8');
        assert.throws(
            () => writeOverride({ storePath: store, config: { channel: { name: 'X' }, branding: { nope: 1 } } }),
            (error) => /unknown-key:branding\.nope/.test(error.message),
            'an unknown key was accepted by the writer'
        );
        assert.equal(readFileSync(store, 'utf8'), before, 'a refused write still changed the file');
        const written = writeOverride({ storePath: store, config: { channel: { name: 'After' } }, base: baseConfig() });
        assert.equal(resolve({ base: baseConfig(), storePath: store }).config.channel.name, 'After');
        assert.equal(written.effective.configVersion, resolve({ base: baseConfig(), storePath: store }).configVersion);
        assert.equal(written.effective.source.includes('store'), true, 'a valid write must report itself as applied');
        assert.ok(JSON.parse(readFileSync(store, 'utf8')).version, 'the store must carry the contract version');
    });

    it('a feed block carrying an unknown key is refused as a layer, every offending key named', () => {
        // Pinning the decision the v2 contract test forced (measured RED 200 !== 400 on
        // 2026-11-08): an unknown key in any layer refuses that whole layer. It is never patched
        // out key by key, because a silently repaired config is the "never partially apply" rail
        // failing quietly. The producer that emits the two legacy keys is lib/feedGenerator.js.
        const { resolve } = loadModule();
        // No store file: the feed layer is the only candidate, so its refusal has nowhere to hide.
        const r = resolve({
            base: { ...baseConfig(), features: { search: true, unknownFlag: true } },
            storePath: path.join(temp, 'no-store-here.json')
        });
        assert.equal(r.config, null, 'a refused feed layer was still served');
        assert.match(r.reason, /feed-rejected/);
        assert.ok(r.refusedKeys.includes('unknown-key:features.unknownFlag'), JSON.stringify(r.refusedKeys));
        assert.deepEqual(r.source, []);
    });

    it('a profile the contract refuses is dropped, and the operator store still serves', () => {
        const { resolve } = loadModule();
        const profile = file('profile-unknown', { clientConfig: { ...baseConfig(), rogue: { here: true } } });
        const store = file('store-after-bad-profile', { channel: { name: 'Store Still Wins' } });
        const r = resolve({ base: baseConfig(), profilePath: profile, storePath: store });
        assert.equal(r.config.channel.name, 'Store Still Wins');
        assert.equal(r.config.rogue, undefined, 'the refused profile layer still reached the client');
        assert.match(r.reason, /profile-rejected/);
        assert.ok(r.refusedKeys.includes('unknown-key:rogue'), JSON.stringify(r.refusedKeys));
        assert.deepEqual(r.source, ['feed', 'store'], 'a rejected layer must not be listed as applied');
    });

    it('the effective config always satisfies the published schema, including the profile-only path', () => {
        const Ajv = require('ajv');
        const validate = new Ajv({ allErrors: true }).compile(schema);
        const { resolve } = loadModule();
        const profile = file('profile-only', {
            clientConfig: {
                ...baseConfig(),
                channel: { name: 'Profile TV' },
                navItems: [],
                pageRegistry: {},
                giving: {},
                heartbeat: {}
            }
        });
        const r = resolve({ profilePath: profile, storePath: file('missing', {}) });
        assert.equal(r.degraded, false, r.reason);
        assert.ok(validate(r.config), JSON.stringify(validate.errors));
        for (const key of Object.keys(r.config)) {
            assert.ok(key in schema.properties, `served a key the schema does not define: ${key}`);
        }
    });
});

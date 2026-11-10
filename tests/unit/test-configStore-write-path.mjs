/**
 * M0 write path: one configured store, the contract gate before the bytes move, and a reason an
 * operator can act on.
 *
 * Why these tests exist (all measured 2026-11-08, `work/example-channel-server`):
 *  - `lib/configStore.js:4` captured `CONFIG_PATH` as the repo's own `config.json`, while
 *    `lib/effectiveConfig.js` reads `process.env.CTV_CHANNEL_CONFIG`. A deployment that names its
 *    store - which is how the v2 integration harness and any self-host install do it - therefore had
 *    the admin panel writing a file the television never reads. That is the split-brain the design
 *    calls "the single biggest correctness risk" (`DESIGN-admin-studio-2026-11-08.md` section 5), and
 *    the read side landing (C135) did not close it.
 *  - `configStore.validateConfig` is permissive AND stale: it checks five feature flags
 *    (`continueWatching`, `offlineMode`, `sermonCategories`, `serviceSchedule`, `watchLater`) that the
 *    published contract does not declare, and it accepts keys the contract refuses. Since C135 the
 *    reader drops a refused layer *whole*, so one stale checkbox accepted at save time silently
 *    discards everything the operator edited the moment the feed is regenerated.
 */

import { it, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const store = require('../../lib/configStore.js');
const effective = require('../../lib/effectiveConfig.js');

const REPO_CONFIG = path.join(process.cwd(), 'config.json');
const sha = (file) =>
    fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const readStore = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function tempStore(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ctv-store-${name}-`));
    return { dir, file: path.join(dir, 'channel-config.json') };
}

// Isolation rail, learned the honest way: the RED run of this file wrote the repository's own
// `config.json` (gitignored deployment state) because the code under test ignored the configured
// store. Snapshot the repo store here and put it back, so this suite can never leave a tree behind
// even if the code regresses to the old hardcoded path.
const REPO_SNAPSHOT = fs.existsSync(REPO_CONFIG) ? fs.readFileSync(REPO_CONFIG) : null;
const REPO_BAK_PREEXISTED = fs.existsSync(`${REPO_CONFIG}.bak`);
after(() => {
    if (REPO_SNAPSHOT) fs.writeFileSync(REPO_CONFIG, REPO_SNAPSHOT);
    if (!REPO_BAK_PREEXISTED && fs.existsSync(`${REPO_CONFIG}.bak`)) fs.rmSync(`${REPO_CONFIG}.bak`);
    for (const stray of [`${REPO_CONFIG}.tmp`, `${REPO_CONFIG}.configstore_backup`]) {
        if (fs.existsSync(stray)) fs.rmSync(stray);
    }
});

function withStore(file, body) {
    const previous = process.env.CTV_CHANNEL_CONFIG;
    process.env.CTV_CHANNEL_CONFIG = file;
    try {
        return body();
    } finally {
        if (previous === undefined) delete process.env.CTV_CHANNEL_CONFIG;
        else process.env.CTV_CHANNEL_CONFIG = previous;
    }
}

const baseStore = {
    channel: { name: 'Example Channel', description: 'Sermons', language: 'en', copyright: '(c) 2026' },
    content: { sourceUrl: 'https://channel.example.invalid/feed' },
    branding: { colors: { accent: '0xE8B931' } }
};

describe('M0 write path - one configured store', () => {
    it('the store the admin saves is the store the television reads', () => {
        const { dir, file } = tempStore('reader');
        const repoBefore = sha(REPO_CONFIG);
        try {
            // Writer and reader are the same process in a real deployment: one configuration names the
            // store, and both must honour it.
            withStore(file, () => {
                store.saveConfig(structuredClone(baseStore));
            });
            assert.ok(fs.existsSync(file), `saveConfig did not write the configured store ${file}`);
            const resolved = withStore(file, () =>
                effective.resolve({ repair: (c) => effective.normalizeEndpoints(c, 'https://channel.example.invalid') })
            );
            assert.equal(
                resolved.storePath,
                file,
                `the reader resolved ${resolved.storePath}, not the configured store`
            );
            assert.equal(resolved.source.includes('store'), true, `the store layer never applied: ${resolved.reason}`);
            assert.equal(resolved.config.channel.name, 'Example Channel');
            assert.match(resolved.configVersion, /^[0-9a-f]{64}$/);
            assert.equal(
                sha(REPO_CONFIG),
                repoBefore,
                'saveConfig touched the repo config.json while another store was configured'
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a key the published contract does not know is refused at save time, with the reason, and the old bytes survive', () => {
        const { dir, file } = tempStore('refuse');
        const edited = structuredClone(baseStore);
        try {
            withStore(file, () => {
                store.saveConfig(structuredClone(edited));
            });
            const before = sha(file);
            const junk = structuredClone(edited);
            junk.branding.colors.nope = '0x112233';
            junk.entitlement = { tier: 'cloud' };
            let failure;
            withStore(file, () => {
                try {
                    store.saveConfig(junk);
                } catch (err) {
                    failure = err;
                }
            });
            assert.ok(failure, 'an unknown key was saved without a refusal');
            const text = `${failure.message} ${(failure.reasons || []).join(' ')}`;
            assert.match(text, /unknown-key:branding\.colors\.nope/, text);
            assert.match(text, /unknown-key:entitlement/, text);
            assert.equal(sha(file), before, 'a refused save moved the store bytes anyway');
            assert.ok(!fs.existsSync(`${file}.tmp`), 'a refused save left a temp file behind');
            assert.equal(readStore(file).branding.colors.nope, undefined, 'the refused key reached the store');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the five legacy feature flags the old validator checked are refused now, not silently dropped by the reader later', () => {
        const stale = ['continueWatching', 'offlineMode', 'sermonCategories', 'serviceSchedule', 'watchLater'];
        const { dir, file } = tempStore('stale');
        try {
            withStore(file, () => {
                store.saveConfig(structuredClone(baseStore));
            });
            const before = sha(file);
            for (const flag of stale) {
                const candidate = structuredClone(baseStore);
                candidate.features = { [flag]: true };
                // The permissive validator is still here, and still accepts all five - that is the
                // defect, recorded as an assertion so nobody "fixes" the gate by trusting it again.
                assert.doesNotThrow(
                    () => store.validateConfig(candidate),
                    `the legacy validator changed its mind about ${flag}`
                );
                let failure;
                try {
                    withStore(file, () => store.saveConfig(candidate));
                } catch (err) {
                    failure = err;
                }
                assert.ok(
                    failure,
                    `features.${flag} was saved, and the contract reader will drop the whole store layer`
                );
                assert.match(
                    `${failure.message} ${(failure.reasons || []).join(' ')}`,
                    new RegExp(`unknown-key:features\\.${flag}`)
                );
                assert.equal(sha(file), before, `features.${flag} mutated the store on a refused save`);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a colours-only edit lands in the store and reaches the served config with the server rewriting the relative endpoint', () => {
        const { dir, file } = tempStore('edit');
        try {
            withStore(file, () => {
                store.saveConfig(structuredClone(baseStore));
            });
            const versionBefore = withStore(
                file,
                () =>
                    effective.resolve({
                        repair: (c) => effective.normalizeEndpoints(c, 'https://channel.example.invalid')
                    }).configVersion
            );
            const edited = structuredClone(baseStore);
            edited.branding.colors.accent = '0x22AA55';
            edited.heartbeat = { enabled: true, intervalSeconds: 600, exportUrl: '/api/heartbeat' };
            withStore(file, () => {
                store.saveConfig(edited);
            });
            const served = withStore(file, () =>
                effective.resolve({ repair: (c) => effective.normalizeEndpoints(c, 'https://channel.example.invalid') })
            );
            assert.equal(served.config.branding.colors.accent, '0x22AA55', 'the edit never reached the served config');
            assert.equal(
                served.config.heartbeat.exportUrl,
                'https://channel.example.invalid/api/heartbeat',
                'the operator wrote a relative endpoint and the server did not own the rewrite (decision D-T1-1)'
            );
            assert.notEqual(
                served.configVersion,
                versionBefore,
                'configVersion did not move for an edit a television can see'
            );
            assert.equal(served.degraded, false, `a clean edit reported degraded: ${served.reason}`);
            assert.equal(
                readStore(file).heartbeat.exportUrl,
                '/api/heartbeat',
                'the store was rewritten with the server-normalised value; the operator file must stay what they typed'
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('every refusal the write path can raise has operator-facing copy, and an unknown code is quoted, never hidden', () => {
        const { copyFor, CATALOGUE } = require('../../lib/reasonCopy.js');
        assert.ok(CATALOGUE.length > 0, 'the catalogue is empty');
        const known = [
            'unknown-key:features.watchLater',
            'missing-required:channel.name',
            'invalid-type:branding.colors.accent',
            'invalid-type:content.sourceUrl',
            'store-rejected',
            'store-unreadable:Unexpected end of JSON input',
            'profile-rejected',
            'feed-rejected',
            'no-config-layer',
            'invalid-effective-config:missing-required:content.sourceUrl',
            'schema-drift:work/roku-channel-template/config/schema.json aaaa != bbbb'
        ];
        for (const reason of known) {
            const copy = copyFor(reason);
            assert.ok(typeof copy === 'string' && copy.length > 12, `no operator copy for ${reason}`);
            assert.notEqual(copy, reason, `copy for ${reason} is just the code repeated`);
            assert.ok(!/something went wrong|unknown error/i.test(copy), `placeholder copy for ${reason}: ${copy}`);
        }
        const odd = copyFor('invented-code:something.new');
        assert.match(
            odd,
            /invented-code:something\.new/,
            'an unmapped code must still show the machine-readable reason'
        );
        // The detail must survive: an operator pastes it into a support message.
        assert.match(copyFor('unknown-key:branding.colors.nope'), /branding\.colors\.nope/);
    });

    it('the admin panel turns a refusal into an operator sentence and still shows the reason code', () => {
        const adminRouter = require('../../routes/admin.js');
        const audit = require('../../lib/auditLog.js');
        const route = adminRouter.stack.find((layer) => layer.route?.path === '/config' && layer.route.methods.post);
        const handler = route.route.stack.at(-1).handle;
        const original = {
            load: store.loadConfig,
            save: store.saveConfig,
            validate: store.validateConfig,
            log: audit.logEvent
        };
        const flashed = [];
        try {
            store.loadConfig = () => structuredClone(baseStore);
            store.validateConfig = () => {};
            audit.logEvent = () => {};
            store.saveConfig = () => {
                const error = new Error('invalid-channel-config: unknown-key:features.watchLater');
                error.reasons = ['unknown-key:features.watchLater'];
                throw error;
            };
            handler(
                {
                    body: { channelName: 'Example', channelDescription: 'Sermons', channelLanguage: 'en' },
                    flash: (kind, line) => flashed.push([kind, line])
                },
                { redirect: () => {} }
            );
            const errors = flashed.filter(([kind, line]) => kind === 'error' && line.includes('watchLater'));
            assert.equal(errors.length, 1, `no operator-facing refusal on screen: ${JSON.stringify(flashed)}`);
            assert.match(errors[0][1], /not a setting the television reads/, errors[0][1]);
            assert.match(
                errors[0][1],
                /\[unknown-key:features\.watchLater\]/,
                'the machine-readable reason disappeared from the operator screen'
            );
        } finally {
            store.loadConfig = original.load;
            store.saveConfig = original.save;
            store.validateConfig = original.validate;
            audit.logEvent = original.log;
        }
    });

    it('a restart seeds the store only when there is no store to seed', () => {
        // Measured 2026-11-08: `server.js` calls `initializeConfig()` on every start, and that function
        // wrote `config.template.json` over the target unconditionally - so a restart replaced whatever
        // the operator had saved (the comment above the call says "if missing"; the code did not).
        const { dir, file } = tempStore('seed');
        try {
            withStore(file, () => {
                store.initializeConfig();
            });
            assert.ok(fs.existsSync(file), 'a first run did not seed a store at all');
            const edited = structuredClone(readStore(file));
            edited.channel.name = 'First Church Edited';
            withStore(file, () => {
                store.saveConfig(edited);
            });
            const before = sha(file);
            withStore(file, () => {
                store.initializeConfig();
            });
            assert.equal(sha(file), before, 'a restart replaced the operator store with the template');
            assert.equal(readStore(file).channel.name, 'First Church Edited', 'a restart renamed the channel');
            fs.writeFileSync(file, '   ');
            withStore(file, () => {
                store.initializeConfig();
            });
            assert.ok(Object.keys(readStore(file)).length > 0, 'an empty store was not seeded on a first run');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a value the range checks know about is refused at the save seam, so that validator is not dead code', () => {
        const { dir, file } = tempStore('range');
        try {
            withStore(file, () => {
                store.saveConfig(structuredClone(baseStore));
            });
            const before = sha(file);
            for (const [path_, value, expect] of [
                ['branding.colors.background', 'not-hex', /valid hex color/],
                ['cardStyle.titleNumLines', 15, /between 1 and 10/],
                ['content.maxItemsPerRow', 0, /between 1 and 50/]
            ]) {
                const candidate = structuredClone(baseStore);
                const parts = path_.split('.');
                let node = candidate;
                for (const part of parts.slice(0, -1)) {
                    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
                    node = node[part];
                }
                node[parts.at(-1)] = value;
                let failure;
                try {
                    withStore(file, () => store.saveConfig(candidate));
                } catch (err) {
                    failure = err;
                }
                assert.ok(failure, `${path_} = ${JSON.stringify(value)} was saved`);
                assert.match(failure.message, expect, `${path_}: ${failure.message}`);
                assert.equal(sha(file), before, `${path_} mutated the store on a refused save`);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the configured store is the one every writer and reader agrees on', () => {
        const { dir, file } = tempStore('named');
        const previous = process.env.CTV_CHANNEL_CONFIG;
        try {
            withStore(file, () => {
                assert.equal(store.configPath(), file, 'configStore still points at the repository file');
                assert.equal(
                    effective.defaultStorePath(),
                    file,
                    'the reader and the writer disagree about where the store is'
                );
            });
            delete process.env.CTV_CHANNEL_CONFIG;
            assert.equal(
                store.configPath(),
                path.join(process.cwd(), 'config.json'),
                'with no store named, the writer must land on the repository default an operator has always found'
            );
            assert.equal(
                effective.defaultStorePath(),
                store.configPath(),
                'with no store named, writer and reader must land on the same file'
            );
        } finally {
            if (previous !== undefined) process.env.CTV_CHANNEL_CONFIG = previous;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

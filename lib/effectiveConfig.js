/**
 * Effective client configuration: the one store every consumer reads.
 *
 * Why this module exists (measured 2026-11-08): the admin panel wrote `config.json`
 * (`lib/configStore.js`), the feed generator read that same file, and the TVs read
 * `GET /api/v2/config`, which served the *server profile's* `clientConfig` instead. Two truths,
 * and the file the operator edited never reached a television. This module is the seam that
 * collapses them: one merge, one validation, one report, read by the v2 endpoint, the feed
 * generator and (from M1) the Studio writer.
 *
 * Precedence is fixed by ../CONFIGURATION.md and is not negotiable here:
 *   feed-embedded config < server profile `clientConfig` < operator store
 * Lower layers survive a rejected higher layer: a rejected layer is dropped whole, never applied
 * partially, and the result says so (`degraded`, `reason`, `refusedKeys`) instead of going quiet.
 *
 * Reason codes are machine-readable on purpose - the same vocabulary serves the operator UI, the
 * audit log and the alert router:
 *   unknown-key:<dot.path>      a key the published contract does not define (fail closed)
 *   missing-required:<dot.path> absent on the effective config
 *   invalid-type:<dot.path>     present with the wrong type/format
 *   store-unreadable | store-not-an-object | store-rejected
 *   profile-unreadable | profile-rejected
 *   no-config-layer | invalid-effective-config
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Ajv = require('ajv');

const schema = require('../schemas/ctv-config-v1.json');
const validateFull = new Ajv({ allErrors: true }).compile(schema);

// A layer is an override, so presence and absolute-URI form are not properties of an operator's
// file: a church that writes `/api/heartbeat` or leaves its giving link empty has written something
// sensible, and only the server knows its own origin. Both are enforced on the merged,
// endpoint-normalised result, which is the thing a client actually validates. Unknown keys and wrong
// types still fail at the layer, because that is where an edit is attributable to a person.
function withoutServerOwnedConstraints(node, seen = new Set()) {
    if (Array.isArray(node)) return node.map((item) => withoutServerOwnedConstraints(item, seen));
    if (!node || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);
    const copy = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === 'required' || key === 'format') continue;
        copy[key] = withoutServerOwnedConstraints(value, seen);
    }
    return copy;
}
const partialSchema = withoutServerOwnedConstraints(schema);
const validateLayer = new Ajv({ allErrors: true }).compile(partialSchema);

// Every leaf the contract declares as a URI, read off the schema so this list cannot drift from it.
const URI_FIELDS = (() => {
    const found = [];
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if (node.format === 'uri') found.push(path.join('.'));
        for (const [key, child] of Object.entries(node.properties || {})) walk(child, [...path, key]);
    };
    walk(schema, []);
    return found;
})();

function normalizeEndpoints(config, origin) {
    if (!config || typeof config !== 'object' || !origin) return config;
    const out = structuredClone(config);
    for (const field of URI_FIELDS) {
        const parts = field.split('.');
        let node = out;
        let missing = false;
        for (const part of parts.slice(0, -1)) {
            if (!node[part] || typeof node[part] !== 'object') {
                missing = true;
                break;
            }
            node = node[part];
        }
        if (missing) continue;
        const leaf = parts.at(-1);
        const value = node[leaf];
        if (typeof value !== 'string' || value.trim() === '') {
            delete node[leaf];
            continue;
        }
        try {
            node[leaf] = new URL(value, origin).toString();
        } catch {
            // Unparseable stays put, so the contract reports `invalid-type:<field>` instead of this
            // step inventing an address a television would fail on later.
        }
    }
    return out;
}

function defaultStorePath() {
    return process.env.CTV_CHANNEL_CONFIG || path.join(__dirname, '..', 'config.json');
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeLayer(target, source) {
    if (source === undefined) return target;
    if (!isPlainObject(source)) return source;
    const out = isPlainObject(target) ? { ...target } : {};
    for (const [key, value] of Object.entries(source)) {
        out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeLayer(out[key], value) : value;
    }
    return out;
}

function codes(errors) {
    const list = [];
    for (const error of errors || []) {
        const dotted = error.dataPath ? error.dataPath.replace(/^\./, '') : '';
        if (error.keyword === 'additionalProperties') {
            list.push(`unknown-key:${dotted ? dotted + '.' : ''}${error.params.additionalProperty}`);
        } else if (error.keyword === 'required') {
            list.push(`missing-required:${dotted ? dotted + '.' : ''}${error.params.missingProperty}`);
        } else {
            list.push(`invalid-type:${error.dataPath ? error.dataPath.replace(/^\./, '') : '<root>'}`);
        }
    }
    return [...new Set(list)];
}

function unknownKeys(errors) {
    return codes(errors).filter((code) => code.startsWith('unknown-key:'));
}

function layerReasons(config) {
    if (!isPlainObject(config)) return ['store-not-an-object'];
    return validateLayer(config) ? [] : codes(validateLayer.errors);
}

function readLayer(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        return {
            error: error.code === 'ENOENT' ? undefined : `unreadable:${error.message}`,
            missing: error.code === 'ENOENT'
        };
    }
    try {
        return { value: JSON.parse(text) };
    } catch (error) {
        return { error: `unreadable:${error.message}` };
    }
}

function version(config) {
    return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

/**
 * resolve({ base, profilePath, storePath, repair })
 *  - base: the config block embedded in the feed being served, if any
 *  - repair: an optional synchronising pass (the v2 route rewrites same-origin media and
 *    endpoint URLs to the serving origin) run on the merged config BEFORE final validation,
 *    because a relative URL is only relative until the server knows its own origin.
 */
function resolve({ base, profilePath, storePath, repair } = {}) {
    const store = storePath === undefined ? defaultStorePath() : storePath;
    const applied = [];
    const notes = [];
    const refusedKeys = [];
    let merged = {};

    if (isPlainObject(base) && Object.keys(base).length > 0) {
        const errors = validateLayer(base) ? [] : validateLayer.errors;
        const refused = unknownKeys(errors);
        if (refused.length > 0) {
            // Never partially apply: a feed block carrying a key the contract does not define is
            // refused as a layer (measured 2026-11-08: the live example-channel feed ships `sermon` and
            // `offline`, which lib/feedGenerator.js emits - the producer is the place to fix it),
            // every offending key is reported, and clients keep their validated defaults.
            refusedKeys.push(...refused);
            notes.push('feed-rejected');
        } else {
            merged = structuredClone(base);
            applied.push('feed');
        }
    }

    if (profilePath) {
        const layer = readLayer(profilePath);
        if (layer.error) {
            notes.push(`profile-unreadable:${layer.error}`);
        } else if (!layer.missing) {
            const clientConfig = layer.value && layer.value.clientConfig;
            if (isPlainObject(clientConfig) && Object.keys(clientConfig).length > 0) {
                const errors = validateLayer(clientConfig) ? [] : validateLayer.errors;
                if (unknownKeys(errors).length > 0) {
                    refusedKeys.push(...unknownKeys(errors));
                    notes.push('profile-rejected');
                } else {
                    merged = mergeLayer(merged, clientConfig);
                    applied.push('profile');
                }
            }
        }
    }

    const storeLayer = readLayer(store);
    if (storeLayer.error) {
        notes.push(`store-unreadable:${storeLayer.error}`);
    } else if (!storeLayer.missing) {
        if (!isPlainObject(storeLayer.value)) {
            notes.push('store-not-an-object');
        } else {
            const errors = validateLayer(storeLayer.value) ? [] : validateLayer.errors;
            const refused = unknownKeys(errors);
            if (refused.length > 0) {
                // Never partially apply an override the contract refuses: the whole store layer is
                // skipped, the lower layers keep serving, and the operator is told every key.
                refusedKeys.push(...refused);
                notes.push('store-rejected');
            } else {
                merged = mergeLayer(merged, storeLayer.value);
                applied.push('store');
            }
        }
    }

    const effective = typeof repair === 'function' ? repair(merged) : merged;
    if (applied.length === 0) {
        return {
            config: null,
            configVersion: null,
            source: [],
            degraded: true,
            reason: notes.length > 0 ? `${notes.join(',')}:${refusedKeys.join(',')}` : 'no-config-layer',
            refusedKeys,
            storePath: store
        };
    }
    if (!validateFull(effective)) {
        const failureCodes = codes(validateFull.errors);
        const onlyUnknown = unknownKeys(validateFull.errors);
        return {
            config: null,
            configVersion: null,
            source: applied,
            degraded: true,
            reason: `invalid-effective-config:${failureCodes.join(',')}`,
            refusedKeys: [...refusedKeys, ...onlyUnknown],
            storePath: store
        };
    }
    const degraded = notes.length > 0 || refusedKeys.length > 0;
    const reason = degraded ? [notes.join(','), refusedKeys.join(',')].filter(Boolean).join(':') : undefined;
    return {
        config: effective,
        configVersion: version(effective),
        source: applied,
        degraded,
        reason,
        refusedKeys,
        storePath: store
    };
}

function writeOverride({ storePath, config, base, profilePath, contractVersion = '1.0.0' } = {}) {
    const target = storePath || defaultStorePath();
    if (!isPlainObject(config)) throw new Error('invalid-channel-config:store-not-an-object');
    const errors = validateLayer(config) ? [] : validateLayer.errors;
    const refused = unknownKeys(errors);
    if (refused.length > 0) throw new Error(`invalid-channel-config:${refused.join(' ')}`);
    // The store is an override, so presence and format belong to the merged result, not to this
    // file: a church that edits only its colours must not be forced to re-send the whole contract.
    // resolve() is what refuses a config that would reach a television incomplete.
    const payload = { version: contractVersion, ...structuredClone(config) };
    const tmp = `${target}.tmp`;
    const bak = `${target}.bak`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    if (fs.existsSync(target)) fs.copyFileSync(target, bak);
    fs.renameSync(tmp, target);
    const effective = base || profilePath ? resolve({ base, profilePath, storePath: target }) : undefined;
    return { config: payload, storePath: target, effective };
}

module.exports = {
    resolve,
    writeOverride,
    normalizeEndpoints,
    defaultStorePath,
    // The writer's gate: the same layer rule `resolve()` applies to an incoming override, so an
    // operator is refused at save time for exactly the reason the reader would refuse it later
    // (`unknown-key:`, `invalid-type:`; presence and absolute-URI form belong to the merged result).
    layerReasons,
    validateEffective: (config) => (validateFull(config) ? [] : codes(validateFull.errors))
};

// The runtime contract: the build must load on the node the origin boxes actually run, and the validators
// must be the same on every machine that installs it. Both halves were learned by deploying on 2026-11-09.
//
//   node 18.19.1 (`example-channel`, the unit's `/usr/bin/node`) died at boot:
//     Error [ERR_REQUIRE_ESM]: require() of ES Module .../file-type/source/index.js from .../routes/admin.js
//   `bcryptjs` is ESM-only too. require(esm) is supported from node 22.12, so that is the floor.
//
//   And `format: "uri"` in schemas/ctv-config-v1.json is only enforced when `ajv-formats` is installed.
//   A clean `npm ci` on both origins pulled it in transitively; the development tree did not have it, so
//   the same config was refused on one machine and accepted on another. An optional dependency cannot be
//   allowed to decide whether a contract key is validated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Measured minimum: node 22.15.0 boots the server and loads both ESM-only deps; node 18.19.1 does not.
const MIN_NODE = { major: 22, minor: 12 };

// Dependencies that are ESM-only at the pinned version. Each needs a reason, because `require()` of one of
// them is what killed the first deploy attempt on a production box.
const ESM_ONLY_DEPS = {
    bcryptjs: 'v3 ships "type": "module"; required by lib/adminAuth.js and middleware/auth.js',
    'file-type': 'v19+ ships "type": "module"; required by routes/admin.js'
};

function enginesFloor(range) {
    const m = />=\s*(\d+)\.(\d+)/.exec(String(range || ''));
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function esmOnlyInstalled(pkgName) {
    const manifest = path.join(ROOT, 'node_modules', pkgName, 'package.json');
    if (!fs.existsSync(manifest)) return false;
    try {
        return JSON.parse(fs.readFileSync(manifest, 'utf8')).type === 'module';
    } catch {
        return false;
    }
}

function runtimeRequires() {
    const dirs = ['routes', 'lib', 'middleware', '.'];
    const seen = new Map();
    const skip = new Set(['node_modules', 'tests', 'docs', 'ops', 'services', 'data', 'output', 'Videos']);
    for (const dir of dirs) {
        if (!fs.existsSync(path.join(ROOT, dir))) continue;
        for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            if (ent.isDirectory()) continue;
            if (!ent.name.endsWith('.js')) continue;
            if (skip.has(ent.name)) continue;
            const file = path.join(dir, ent.name);
            const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
            for (const m of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
                let name = m[1];
                if (name.startsWith('.') || name.startsWith('node:')) continue;
                if (name.startsWith('@')) name = name.split('/').slice(0, 2).join('/');
                else name = name.split('/')[0];
                if (!seen.has(name)) seen.set(name, file);
            }
        }
    }
    return seen;
}

test('the declared node floor is the one the origins run, not a hope', () => {
    const floor = enginesFloor(pkg.engines && pkg.engines.node);
    assert.ok(floor, `engines.node must state a floor; found ${JSON.stringify(pkg.engines && pkg.engines.node)}`);
    const ok = floor.major > MIN_NODE.major || (floor.major === MIN_NODE.major && floor.minor >= MIN_NODE.minor);
    assert.ok(
        ok,
        `engines.node is >=${floor.major}.${floor.minor}, but the build cannot load before ${MIN_NODE.major}.${MIN_NODE.minor}: ` +
            `node 18.19.1 on the example channel origin died with ERR_REQUIRE_ESM on file-type/bcryptjs (deployed 2026-11-09)`
    );
});

test('the endpoint keys are format-checked, and the shipped template does not validate on its own', () => {
    // Measured on 2026-11-09 with the installed ajv@6.12.6, which validates the standard formats itself:
    // an earlier note in this project blamed a missing `ajv-formats` for accepting a garbage endpoint, and
    // that was wrong - the schema refuses it. What silently accepts it is the effective-config layer, which
    // repairs the value before validating. Decision D-T1-2 (refuse, or repair and say so) is still open.
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'ctv-config-v1.json'), 'utf8'));
    const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.template.json'), 'utf8'));
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const formatErrors = (cfg) =>
        (validate(cfg) ? [] : validate.errors)
            .filter((e) => e.keyword === 'format')
            .map((e) => `${e.dataPath}(${e.params.format})`);

    for (const bad of ['', 'not-a-url-at-all', 'Roku/14.1.0']) {
        const cfg = JSON.parse(JSON.stringify(template));
        cfg.content = cfg.content || {};
        cfg.content.sourceUrl = bad;
        assert.ok(
            formatErrors(cfg).includes('.content.sourceUrl(uri)'),
            `sourceUrl ${JSON.stringify(bad)} must be refused by the schema; errors: ${JSON.stringify(formatErrors(cfg))}`
        );
    }

    const good = JSON.parse(JSON.stringify(template));
    good.content = good.content || {};
    good.content.sourceUrl = 'https://channel.example.invalid/feed';
    good.analytics = good.analytics || {};
    good.analytics.exportUrl = 'https://channel.example.invalid/api/analytics';
    good.heartbeat = good.heartbeat || {};
    good.heartbeat.exportUrl = 'https://channel.example.invalid/api/heartbeat';
    assert.deepEqual(
        formatErrors(good),
        [],
        `a filled-in config must pass the format checks; refused: ${JSON.stringify(formatErrors(good))}`
    );

    // The shipped template, untouched, is what a new channel starts from - and it does not validate today:
    // `content.sourceUrl` is "" and `analytics.exportUrl` is the relative "/analytics", and ajv@6's built-in
    // `uri` format needs an absolute URI, so a brand-new store is refused from its first boot and only the
    // repair layer saves it.
    // That is D-T1-2's root cause, asserted so nobody can ship a fleet of channels whose first boot depends
    // on a silent repair.
    assert.ok(
        formatErrors(template).length > 0,
        'config.template.json now validates on its own: the D-T1-2 blocker has been fixed - update this test ' +
            'and the gate row, and stop calling the repair a workaround'
    );
});

test('every ESM-only dependency is known and reasoned, never discovered on a production box', () => {
    const requires = runtimeRequires();
    const found = [];
    for (const [name, file] of requires) {
        if (esmOnlyInstalled(name)) found.push([name, file]);
    }
    for (const [name, file] of found) {
        assert.ok(
            ESM_ONLY_DEPS[name],
            `${file} require()s "${name}", which is installed as an ES module. Under the declared node floor ` +
                `that works (require(esm)), but it killed the first attempt on a node 18 origin. Decide on purpose: ` +
                `add it to ESM_ONLY_DEPS with a reason, or make the require a dynamic import.`
        );
    }
    // and the list must not rot into fiction
    for (const name of Object.keys(ESM_ONLY_DEPS)) {
        assert.ok(requires.has(name), `ESM_ONLY_DEPS names "${name}", which no runtime file requires any more`);
    }
});

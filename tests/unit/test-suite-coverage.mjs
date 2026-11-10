/**
 * A test that never runs is not a test (night of 2026-11-09)
 *
 * `npm run test:all` runs the unit glob (`tests/unit/*.mjs`), then `tests/integration/test-client-contract.mjs`,
 * then the python suite, then `test:integration:isolated` - which is a **hand-maintained list of eight files**.
 * `tests/integration/test-admin-feed-regenerate.mjs` was written tonight and appeared in no script: the gate
 * reported "58 isolated checks" before it existed and 58 after, which is how a suite looks green while ignoring
 * a file. Same shape as the rest of this night's findings: a claim of coverage that no mechanism enforces.
 *
 * The unit half is glob-driven, so nothing can hide there; the integration half can. So the integration half gets
 * a check: every file under `tests/integration/` must be named by at least one script in `package.json`, and the
 * isolated script must not name a file that has been deleted.
 *
 * Mutation check (applied to `package.json` / `tests/integration/unwired.json`, run, restored byte-exactly; the
 * control marker `NO-IDENTICAL` prints when an anchor is absent):
 *   - S1 remove a wired file from the script: CAUGHT ("in no npm script and not registered")
 *   - S2 blank the `whyNotWired` of a registered entry: CAUGHT ("entries need measured/whyNotWired/nextStep")
 *   - S3 point a script at a deleted file: CAUGHT ("scripts reference deleted integration tests")
 *   - S4 replace the unit-glob tripwire with `true`: **NOT CAUGHT, honestly** - nothing in the suite verifies
 *     that check, so it is a tripwire for a human reading the failure, not an enforced invariant. Recorded
 *     rather than papered over; the file was restored and re-run green afterwards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
const integrationFiles = readdirSync(path.join(root, 'tests', 'integration'))
    .filter((name) => name.endsWith('.mjs'))
    .sort();
const scriptText = Object.entries(scripts)
    .map(([name, body]) => `${name} ${body}`)
    .join('\n');

const unwiredPath = path.join(root, 'tests', 'integration', 'unwired.json');
const unwired = existsSync(unwiredPath) ? JSON.parse(readFileSync(unwiredPath, 'utf8')).entries || [] : [];

test('every integration test file is named by a script that the gate runs, or is registered as unwired debt', () => {
    const orphans = integrationFiles.filter((name) => !scriptText.includes(`tests/integration/${name}`));
    const registered = unwired.filter((e) => e && e.file);
    const unexplained = registered.filter((e) => !e.measured || !e.whyNotWired || !e.nextStep);
    assert.deepEqual(
        unexplained.map((e) => e.file),
        [],
        `unwired.json entries need measured/whyNotWired/nextStep before they may hide a test: ${unexplained.map((e) => e.file).join(', ')}`
    );
    const undeclared = orphans.filter((name) => !registered.some((e) => e.file === name));
    assert.deepEqual(
        undeclared,
        [],
        `${undeclared.length} file(s) under tests/integration/ are in no npm script and not registered in unwired.json, so \`npm run test:all\` ignores them silently: ${undeclared.join(', ')}`
    );
    const stale = registered.filter(
        (e) => scriptText.includes(`tests/integration/${e.file}`) || !integrationFiles.includes(e.file)
    );
    assert.deepEqual(
        stale.map((e) => e.file),
        [],
        `unwired.json names files that are wired in or gone: ${stale.map((e) => e.file).join(', ')}`
    );
});

test('the scripts do not name an integration file that no longer exists', () => {
    const named = [...scriptText.matchAll(/tests\/integration\/([\w.-]+\.mjs)/g)].map((m) => m[1]);
    const missing = [...new Set(named)].filter((name) => !existsSync(path.join(root, 'tests', 'integration', name)));
    assert.deepEqual(missing, [], `scripts reference deleted integration tests: ${missing.join(', ')}`);
});

test('the unit half is glob-driven, which is what the previous two checks exist to compensate for', () => {
    const unitGlob = /tests\/unit\/\*\.mjs/.test(scriptText);
    assert.ok(unitGlob, 'no script runs tests/unit/*.mjs as a glob; a file added there would need the same guard');
    const unitFiles = readdirSync(path.join(root, 'tests', 'unit')).filter((name) => name.endsWith('.mjs'));
    assert.ok(unitFiles.length >= 20, `the unit directory unexpectedly holds ${unitFiles.length} files`);
});

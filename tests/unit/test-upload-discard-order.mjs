/**
 * When is a refused upload actually gone? (night of 2026-11-09)
 *
 * `discardRejectedUpload` (routes/admin.js) exists because rate limit, authentication and CSRF all run
 * after Multer has streamed a 500 MB body to disk, so every refusal can leave that body behind. Its
 * comment claims the removal is "synchronous on purpose" and that this closed the race. It closed one race
 * and left another: the removal hangs off `res.on("finish")`, which fires AFTER the response has been
 * flushed. Measured, not theorised: the integration harness `tests/integration/test-admin-upload.mjs`
 * failed 1 run in 4 standalone and 1 in 4 full-suite runs with
 * `the CSRF refusal left ["1794278705115-1d1e8d404bed58f8.mp4"] behind` - the client was already talking to
 * the server again while a refused body was still on disk. On a 451 GB volume that is not cosmetic.
 *
 * These are the deterministic cases the middleware must satisfy, with no listener involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adminRoutes = require('../../routes/admin.js');
const { discardRejectedUpload } = adminRoutes.__internals || {};

function fakeRes() {
    const handlers = {};
    const res = {
        statusCode: 200,
        atEnd: null,
        end() {
            res.atEnd = { exists: res.probe() };
            (handlers.finish || []).forEach((fn) => fn());
            return res;
        },
        on(event, fn) {
            handlers[event] = handlers[event] || [];
            handlers[event].push(fn);
            return res;
        }
    };
    return res;
}

function world() {
    const dir = mkdtempSync(path.join(tmpdir(), 'ctv-discard-'));
    const uploads = path.join(dir, 'uploads');
    mkdirSync(uploads, { recursive: true });
    const filePath = path.join(uploads, '1794278705115-1d1e8d404bed58f8.mp4');
    writeFileSync(filePath, 'a streamed body, refused for having no CSRF token');
    return { dir, uploads, filePath };
}

test('the seam exists: the middleware is reachable without a listener', () => {
    assert.equal(typeof discardRejectedUpload, 'function', 'discardRejectedUpload is not exported for testing');
});

test('a refusal removes the streamed body BEFORE the refusal is answered', () => {
    const { dir, filePath } = world();
    try {
        const req = { file: { path: filePath } };
        const res = fakeRes();
        res.statusCode = 403;
        res.probe = () => existsSync(filePath);
        discardRejectedUpload(req, res, () => {});
        res.end();
        assert.deepEqual(
            res.atEnd,
            { exists: false },
            `the body was still on disk at the moment the refusal was answered (${JSON.stringify(res.atEnd)}) - a client that acts on the response can see, and be told about, a file that is only deleted afterwards`
        );
        assert.ok(!existsSync(filePath), 'the refused body is still on disk after the response');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a 413 (body too large) refusal discards what was streamed', () => {
    const { dir, filePath } = world();
    try {
        const req = { file: { path: filePath } };
        const res = fakeRes();
        res.statusCode = 413;
        res.probe = () => existsSync(filePath);
        discardRejectedUpload(req, res, () => {});
        res.end();
        assert.equal(res.atEnd.exists, false, 'a too-large refusal left the oversized body on disk');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an accepted upload keeps its body for the handler to move', () => {
    const { dir, filePath } = world();
    try {
        const req = { file: { path: filePath } };
        const res = fakeRes();
        res.statusCode = 303;
        res.probe = () => existsSync(filePath);
        discardRejectedUpload(req, res, () => {});
        res.end();
        assert.equal(res.atEnd.exists, true, 'a success response deleted the body the handler still needs');
        assert.ok(existsSync(filePath), 'a non-refusal deleted the body');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a request that carried no file passes straight through', () => {
    let nextCalls = 0;
    discardRejectedUpload({ file: undefined }, fakeRes(), () => (nextCalls += 1));
    assert.equal(nextCalls, 1);
});

// The `catch` that warns about an undeletable refused body is NOT RUN here: this test host runs as root, so
// no permission trick makes `fs.removeSync` fail. Recorded rather than faked (nightly rule: an unrun check
// says NOT RUN).

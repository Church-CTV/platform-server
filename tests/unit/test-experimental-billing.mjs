import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createExperimentalBillingGuard } = require('../../middleware/experimentalBilling.js');

for (const environment of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'production', ENABLE_EXPERIMENTAL_BILLING: 'true' }, { NODE_ENV: 'test' }, { NODE_ENV: 'test', ENABLE_EXPERIMENTAL_BILLING: 'false' }]) {
    test(`billing is closed for ${JSON.stringify(environment)}`, () => {
        let status;
        let body;
        let continued = false;
        const response = { status(code) { status = code; return this; }, json(value) { body = value; } };
        createExperimentalBillingGuard(environment)({}, response, () => { continued = true; });
        assert.equal(status, 503);
        assert.equal(body.error, 'experimental_billing_disabled');
        assert.equal(continued, false);
    });
}

test('only an explicit isolated test environment may exercise the stub', () => {
    let continued = false;
    createExperimentalBillingGuard({ NODE_ENV: 'test', ENABLE_EXPERIMENTAL_BILLING: 'true' })({}, {}, () => { continued = true; });
    assert.equal(continued, true);
});

test('all legacy billing routes are guarded before handler registration', () => {
    const source = readFileSync(new URL('../../routes/api.js', import.meta.url), 'utf8');
    const guard = source.indexOf("router.use(['/checkout', '/subscription', '/webhook/stripe'], createExperimentalBillingGuard());");
    assert.ok(guard > 0);
    assert.ok(guard < source.indexOf("router.post('/checkout'"));
});

test('production HTTP requests cannot reach checkout, subscriber data, cancellation or webhooks', async () => {
    const express = require('express');
    const app = express();
    app.use(['/api/checkout', '/api/subscription', '/api/webhook/stripe'], createExperimentalBillingGuard({ NODE_ENV: 'production', ENABLE_EXPERIMENTAL_BILLING: 'true' }));
    app.use((_request, response) => response.json({ healthy: true }));
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        for (const [method, path] of [['POST', '/api/checkout'], ['GET', '/api/subscription/status?subscriberId=another-viewer'], ['POST', '/api/subscription/cancel'], ['POST', '/api/webhook/stripe'], ['GET', '/api/subscription/plans'], ['GET', '/api/subscription/prices']]) {
            const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(3000) });
            assert.equal(response.status, 503, path);
            assert.equal((await response.json()).error, 'experimental_billing_disabled');
        }
        assert.equal((await fetch(origin + '/health')).status, 200);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

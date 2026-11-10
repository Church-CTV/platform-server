/**
 * What the billing surface actually does, measured without Stripe (night of 2026-11-09)
 *
 * Billing in this repository is a stub - `POST /api/checkout` returns a URL it made itself
 * ("Generate checkout URL (simulated Stripe URL)", `routes/api.js:705`) and the deployment sets no billing
 * environment (`docs/deployment/PRODUCTION-DEPLOYMENT.md:43-44`). So nothing here is reachable by a real customer
 * today. It is still worth pinning down, because the subscription layer is where a future cutover will be judged,
 * and because three things about it are checkable right now.
 *
 * Isolated world: temp `DB_PATH`, temp channel-config store, temp output dir, probed port. No Stripe account, no
 * network - webhook signatures are HMACs, so a "valid" event is one signed with the harness's own
 * `STRIPE_WEBHOOK_SECRET`.
 *
 * Read the assertions as measured current behavior. Where current behavior is wrong, the check is written against
 * the wrong thing **on purpose**, names the finding in its title, and says so in a comment: a fix has to update the
 * assertion deliberately. They are not endorsements. `C204` carries the findings and the decisions they need.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

let srv;
let port;
let tmp;
let dbFile;
const WH_SECRET = 'whsec_harness_only';
const API_KEY = 'api_key_harness_only';

async function isPortFree(candidate) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        probe.listen(candidate, '127.0.0.1');
    });
}

async function pickPort(start = 32500) {
    for (let p = start; p < start + 400; p++) {
        if (await isPortFree(p)) return p;
    }
    throw new Error('no free port');
}

async function request(pathname, { method = 'GET', body, headers = {} } = {}) {
    // Node's raw `http.request` never received a response inside this harness (six requests sent, the server
    // answered curl on the same port in 2 ms), so the client here is `fetch` with a hard timeout: a hung
    // request fails the test instead of hanging the suite.
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        body,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(8000)
    });
    const text = await res.text();
    return { status: res.status, text, headers: Object.fromEntries(res.headers.entries()) };
}

function signed(event, { secret = WH_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
    const body = JSON.stringify(event);
    const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return { body, signature: `t=${timestamp},v1=${mac}` };
}

const CHECKOUT_EVENT = {
    type: 'checkout.session.completed',
    data: {
        object: {
            id: 'cs_test_harness',
            object: 'checkout.session',
            client_reference_id: 'subscriber-example',
            customer: 'cus_1',
            customer_email: 'subscriber@example.invalid',
            mode: 'subscription',
            metadata: { product_id: 'standard' },
            // A subscription-mode `checkout.session` carries no `expires_at`; the period end belongs to the
            // subscription object, which arrives in a later event.
            expires_at: null
        }
    }
};

const DELETED_EVENT = {
    type: 'customer.subscription.deleted',
    data: {
        object: {
            id: 'sub_test_harness',
            object: 'subscription',
            customer: 'cus_1',
            status: 'canceled',
            current_period_end: Math.floor(Date.now() / 1000) + 86400
        }
    }
};

before(async () => {
    port = await pickPort();
    tmp = path.join(os.tmpdir(), `ctv-billing-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    mkdirSync(path.join(tmp, 'out'), { recursive: true });
    mkdirSync(path.join(tmp, 'videos'), { recursive: true });
    dbFile = path.join(tmp, 'analytics.db');
    const store = path.join(tmp, 'channel-config.json');
    writeFileSync(
        store,
        JSON.stringify({
            channel: {
                id: 'harness',
                name: 'Harness Church',
                description: 'harness',
                language: 'en',
                copyright: 'x',
                feedUrl: 'http://127.0.0.1/feed'
            },
            branding: { colors: {} }
        })
    );
    srv = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            CTV_DISABLE_PROXY_TRUST: '1',
            // `lib/adminAuth.js` keeps its session state in this process, so a stray CTV_ADMIN_API_URL would
            // forward this harness's /admin traffic to somebody else's live instance.
            CTV_ADMIN_API_URL: '',
            PORT: String(port),
            URL: `http://127.0.0.1:${port}`,
            ADMIN_PASSWORD: 'local-billing-test-only',
            DB_PATH: dbFile,
            CTV_VIDEOS_DIR: path.join(tmp, 'videos'),
            CTV_CHANNEL_CONFIG: store,
            CTV_CONTENT_ROOT: tmp,
            CTV_OUTPUT_DIR: path.join(tmp, 'out'),
            STRIPE_WEBHOOK_SECRET: WH_SECRET,
            ANALYTICS_API_KEY: API_KEY,
            JWT_SECRET: 'harness-jwt-secret'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    srv.stdout.on('data', (d) => (out += d));
    srv.stderr.on('data', (d) => (out += d));
    for (let i = 0; i < 120; i++) {
        try {
            const res = await request('/api/subscription/plans');
            if (res.status) break;
        } catch {}
        await sleep(100);
    }
    srv.stdout.on('data', (d) => (out += d));
    srv.stderr.on('data', (d) => (out += d));
    globalThis.__billingBoot = () => out;
});

after(async () => {
    srv?.kill('SIGTERM');
    await sleep(250);
    try {
        rmSync(tmp, { recursive: true, force: true });
    } catch {}
});

function webhook(event, opts) {
    const { body, signature } = signed(event, opts);
    return request('/api/webhook/stripe', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'stripe-signature': signature }
    });
}

test('a webhook whose HMAC does not verify is refused, and moves nothing', async () => {
    const forged = signed(CHECKOUT_EVENT, { secret: 'whsec_somebody_elses' });
    const res = await request('/api/webhook/stripe', {
        method: 'POST',
        body: forged.body,
        headers: { 'content-type': 'application/json', 'stripe-signature': forged.signature }
    });
    assert.equal(res.status, 400, `forged signature answered ${res.status}: ${res.text.slice(0, 160)}`);
    assert.match(res.text, /Invalid webhook signature/);

    const missing = await request('/api/webhook/stripe', {
        method: 'POST',
        body: JSON.stringify(CHECKOUT_EVENT),
        headers: { 'content-type': 'application/json' }
    });
    assert.equal(missing.status, 400, `a signature-less webhook answered ${missing.status}`);
    assert.match(missing.text, /Missing Stripe signature/);

    const stale = signed(CHECKOUT_EVENT, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    const replay = await request('/api/webhook/stripe', {
        method: 'POST',
        body: stale.body,
        headers: { 'content-type': 'application/json', 'stripe-signature': stale.signature }
    });
    assert.equal(replay.status, 400, `a one-hour-old signed event was replayed (${replay.status})`);

    const status = await request('/api/subscription/status?subscriberId=subscriber-example');
    assert.deepEqual(
        JSON.parse(status.text),
        { active: false, subscriberId: 'subscriber-example' },
        'a refused webhook changed subscription state'
    );
});

test('a correctly signed checkout event is accepted and records a subscription row', async () => {
    const res = await webhook(CHECKOUT_EVENT);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(JSON.parse(res.text), { received: true });

    const status = JSON.parse((await request('/api/subscription/status?subscriberId=subscriber-example')).text);
    assert.equal(status.subscriberId, 'subscriber-example');
    assert.equal(status.productId, 'standard', 'the recorded row did not carry our product id');
    assert.ok(status.startedAt, 'the recorded row has no start time');

    // FINDING (`C204`): a subscription-mode `checkout.session.completed` carries no `expires_at`, and
    // `GET /api/subscription/status` decides `active` solely from `expires_at > now`. So the row we just recorded
    // from a realistic Stripe session reads `active: false` the moment it is written. Pinned against current
    // behavior on purpose; a fix has to change this assertion deliberately.
    assert.equal(status.active, false, 'current behavior says a freshly recorded subscription is not active');
});

test('FINDING (C204): cancellation events key on a different identity than checkout events, so a cancelled subscription stays recorded', async () => {
    const res = await webhook(DELETED_EVENT);
    assert.equal(res.status, 200, res.text);

    const status = JSON.parse((await request('/api/subscription/status?subscriberId=subscriber-example')).text);
    // The checkout row was keyed `client_reference_id` ("subscriber-example"); the subscription event is keyed
    // `customer` ("cus_1"), and the stored row keeps no Stripe customer id to match against. So the UPDATE
    // matches no row and the subscription survives its own cancellation.
    assert.equal(status.subscriberId, 'subscriber-example', 'the row disappeared, which contradicts the measured statement cache');
    assert.ok(status.productId, 'current behavior: the row is still there after customer.subscription.deleted');

    // And the same cancellation reaches nothing through the key the event actually carries.
    const byCustomer = JSON.parse((await request('/api/subscription/status?subscriberId=cus_1')).text);
    assert.deepEqual(byCustomer, { active: false, subscriberId: 'cus_1' });
});

test('FINDING (C204): the status lookup is public, and answers with another subscriber record to anyone who asks', async () => {
    // No API key, no session - `middleware/apiAuth.js:108-112` lists /subscription/status among public GETs.
    // That is deliberate (a Roku channel checks its own status), but there is no proof of possession: the id is
    // guessable, because `POST /api/checkout` mints customer ids as `cust_${productId}_${email-sanitized}`
    // (`routes/api.js:700`) - deterministic from data an attacker usually has.
    const anon = await request('/api/subscription/status?subscriberId=subscriber-example');
    assert.equal(anon.status, 200);
    const body = JSON.parse(anon.text);
    assert.equal(
        body.productId,
        'standard',
        'a stranger could not read the record - which is the behaviour we want, and is not what ships'
    );
    assert.ok(body.startedAt);

    // Cancelling, by contrast, does require the API key: the write side is not open.
    const anonCancel = await request('/api/subscription/cancel', {
        method: 'POST',
        body: JSON.stringify({ subscriberId: 'subscriber-example' }),
        headers: { 'content-type': 'application/json' }
    });
    assert.ok([401, 403].includes(anonCancel.status), `an unauthenticated cancel answered ${anonCancel.status}`);

    const keyed = await request('/api/subscription/cancel', {
        method: 'POST',
        body: JSON.stringify({ subscriberId: 'subscriber-example' }),
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }
    });
    assert.equal(keyed.status, 200);
    assert.deepEqual(JSON.parse(keyed.text), { status: 'cancelled', subscriberId: 'subscriber-example' });
});

test('the checkout endpoint makes no payment call; it fabricates a URL (pinned so a real cutover cannot hide it)', async () => {
    const res = await request('/api/checkout', {
        method: 'POST',
        body: JSON.stringify({ productId: 'standard', customerEmail: 'subscriber@example.invalid' }),
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }
    });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const body = JSON.parse(res.text);
    assert.match(body.url, /^https:\/\/checkout\.stripe\.com\/pay\/[A-Za-z0-9+/=]+$/);
    // No session id, no client_reference_id, nothing stored: the id that later arrives in a webhook
    // `client_reference_id` cannot have come from this response.
    assert.deepEqual(Object.keys(body).sort(), ['url']);
});

/**
 * lanRestrict: what it actually protects (2026-11-08).
 *
 * The exposure finding this file was written against (the private admin-studio design record section 3,
 * repeated as an open M0 item in the private record t8-admin-groundwork-2026-11-08 section 6): the middleware
 * was defined and mounted nowhere, and its IPv6 branch returned `next()` unconditionally - so an IPv6
 * client was allowed regardless of what `ALLOWED_NETWORKS` said. A church box behind a dual-stack
 * router therefore has an admin panel that "LAN only" does not mean.
 *
 * The rule being tested is the fail-closed one from `../CONFIGURATION.md`: a peer we cannot classify
 * is refused, not waved through with a warning. `tests/unit/test-lanRestrict.mjs` covers the IPv4
 * behaviour that already worked; this file covers what it did not.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('lanRestrict - the IPv6 and unknown-peer cases it used to wave through', () => {
    let lanRestrict;

    before(() => {
        delete require.cache[require.resolve('../../middleware/lanRestrict.js')];
        lanRestrict = require('../../middleware/lanRestrict.js').lanRestrict;
    });

    function run(ip, allow, { accept = 'application/json' } = {}) {
        const previous = process.env.ALLOWED_NETWORKS;
        if (allow === undefined) delete process.env.ALLOWED_NETWORKS;
        else process.env.ALLOWED_NETWORKS = allow;
        const req = { ip, connection: { remoteAddress: ip }, headers: { accept }, xhr: false };
        const res = {
            statusCode: 200,
            body: '',
            jsonData: null,
            headers: {},
            status(code) {
                this.statusCode = code;
                return this;
            },
            set(name, value) {
                this.headers[name.toLowerCase()] = value; // Express folds header names
                return this;
            },
            send(text) {
                this.body = text;
            },
            json(data) {
                this.jsonData = data;
            }
        };
        let allowed = false;
        try {
            lanRestrict(req, res, () => {
                allowed = true;
            });
        } finally {
            if (previous === undefined) delete process.env.ALLOWED_NETWORKS;
            else process.env.ALLOWED_NETWORKS = previous;
        }
        return { allowed, res };
    }

    it('refuses a public IPv6 peer when the allow-list only names IPv4 networks', () => {
        const { allowed, res } = run('2001:db8:0:1::dead:beef', '192.168.1.0/24,10.0.0.0/8');
        assert.equal(allowed, false, 'an IPv6 client walked through a "LAN only" admin panel');
        assert.equal(res.statusCode, 403);
    });

    it('refuses an IPv6 peer that does not match the configured IPv6 network', () => {
        const { allowed, res } = run('2400:cb00::5', '192.168.1.0/24,fd00::/8');
        assert.equal(allowed, false, 'a non-matching IPv6 address was served the admin panel');
        assert.equal(res.statusCode, 403);
    });

    it('allows an IPv6 peer inside a configured IPv6 network (a tailnet or site ULA)', () => {
        const { allowed } = run('fd12:3456::7', '192.168.1.0/24,fd00::/8');
        assert.equal(allowed, true, 'a legitimate site-IPv6 operator is locked out by their own allow-list');
    });

    it('allows an IPv6 link-local address with a zone id, which is what a machine on the LAN actually uses', () => {
        const { allowed } = run('fe80::2c:1234%eth0', 'fe80::/10');
        assert.equal(allowed, true, 'a link-local peer on the configured link was refused');
    });

    it('still maps ::ffff:a.b.c.d to its IPv4 form before matching', () => {
        const { allowed } = run('::ffff:192.168.1.20', '192.168.1.0/24');
        assert.equal(allowed, true);
        const mapped = run('::ffff:8.8.8.8', '192.168.1.0/24');
        assert.equal(mapped.allowed, false);
        assert.equal(mapped.res.statusCode, 403);
    });

    it('refuses a peer it cannot identify instead of throwing', () => {
        // Measured before the fix: `req.ip` undefined made `clientIp.replace` throw a TypeError, which
        // Express turns into a 500 - an access-control check that crashes is not access control.
        const previous = process.env.ALLOWED_NETWORKS;
        process.env.ALLOWED_NETWORKS = '192.168.1.0/24';
        const req = { ip: undefined, connection: {}, headers: { accept: 'application/json' }, xhr: false };
        const res = {
            statusCode: 200,
            body: '',
            jsonData: null,
            headers: {},
            status(code) {
                this.statusCode = code;
                return this;
            },
            set(name, value) {
                this.headers[name.toLowerCase()] = value; // Express folds header names
                return this;
            },
            send(text) {
                this.body = text;
            },
            json(data) {
                this.jsonData = data;
            }
        };
        let threw;
        let allowed = false;
        try {
            lanRestrict(req, res, () => {
                allowed = true;
            });
        } catch (err) {
            threw = err;
        } finally {
            process.env.ALLOWED_NETWORKS = previous;
        }
        assert.equal(threw, undefined, `the middleware threw instead of deciding: ${threw && threw.message}`);
        assert.equal(allowed, false);
        assert.equal(res.statusCode, 403);
        assert.equal(res.jsonData.reason, 'peer-address-unknown', JSON.stringify(res.jsonData));
    });

    it('names the refusal in machine-readable form for both HTML and JSON clients', () => {
        const json = run('203.0.113.9', '192.168.1.0/24');
        assert.equal(json.res.jsonData.error, 'lan-restricted', JSON.stringify(json.res.jsonData));
        assert.equal(json.res.jsonData.reason, 'address-not-allowed');
        assert.equal(json.res.jsonData.peer, '203.0.113.9');
        assert.deepEqual(json.res.jsonData.networks, ['192.168.1.0/24']);

        const html = run('203.0.113.9', '192.168.1.0/24', { accept: 'text/html' });
        assert.equal(html.res.statusCode, 403);
        assert.match(String(html.res.body), /LAN/i, 'the human being on the screen got no explanation');
        assert.equal(
            html.res.headers['x-ctv-denied'],
            'address-not-allowed',
            'the HTML refusal carries no machine-readable code for the log'
        );
    });

    it('treats an unparseable allow-list as locked, not open', () => {
        const { allowed, res } = run('192.168.1.5', '192.168.1.0'); // no prefix, as the other suite pins
        assert.equal(allowed, false);
        assert.equal(res.statusCode, 403);
        assert.equal(res.jsonData.reason, 'address-not-allowed');
    });

    it('honours an explicit global IPv6 allow (::/0) for an IPv6 peer', () => {
        const { allowed } = run('2606:4700:4700::1111', '::/0');
        assert.equal(allowed, true, '::/0 should mean everything, including IPv6');
    });

    it('is opt-in: with no ALLOWED_NETWORKS set, nothing is restricted', () => {
        const { allowed } = run('2001:db8::1', undefined);
        assert.equal(allowed, true, 'an unset allow-list must not lock the operator out of their own box');
    });
});
describe('requireAuth asks the same question and gets the same answer', () => {
    // There were two implementations of "is this peer on the LAN": `middleware/lanRestrict.js` and an
    // IPv4-only copy inside `middleware/adminAuth.js` with its own IPv6 bypass. The copy is gone; these
    // checks pin the call site, because a shared helper nobody calls fixes nothing.
    const adminMiddleware = require('../../middleware/adminAuth.js');

    function call(ip, allow, session, accept = 'application/json') {
        const previous = process.env.ALLOWED_NETWORKS;
        if (allow === undefined) delete process.env.ALLOWED_NETWORKS;
        else process.env.ALLOWED_NETWORKS = allow;
        // Express gives a request both `socket` and `connection`; `lib/adminAuth.getClientIp` reads the
        // socket first, so the mock has to carry it or the mock, not the policy, decides the test.
        const req = {
            ip,
            socket: { remoteAddress: ip },
            connection: { remoteAddress: ip },
            headers: { accept },
            xhr: false,
            session: session || {}
        };
        const res = {
            statusCode: 200,
            body: '',
            jsonData: null,
            headers: {},
            status(code) {
                this.statusCode = code;
                return this;
            },
            set(name, value) {
                this.headers[name.toLowerCase()] = value;
                return this;
            },
            send(text) {
                this.body = text;
            },
            json(data) {
                this.jsonData = data;
            },
            redirect(url) {
                this.statusCode = 302;
                this.body = `redirect:${url}`;
            }
        };
        let allowed = false;
        try {
            adminMiddleware.requireAuth(req, res, () => {
                allowed = true;
            });
        } finally {
            if (previous === undefined) delete process.env.ALLOWED_NETWORKS;
            else process.env.ALLOWED_NETWORKS = previous;
        }
        return { allowed, res };
    }

    it('refuses an IPv6 peer the allow-list cannot speak about, with the same reason code', () => {
        const { allowed, res } = call('2001:db8::66', '192.168.1.0/24', { adminAuthenticated: true });
        assert.equal(allowed, false, 'requireAuth still waves IPv6 through');
        assert.equal(res.statusCode, 403);
        assert.equal(res.headers['x-ctv-denied'], 'address-not-allowed');
        assert.equal(res.jsonData.reason, 'address-not-allowed', JSON.stringify(res.jsonData));
    });

    it('serves a peer on a configured network that is signed in', () => {
        const { allowed } = call('10.0.0.5', '10.0.0.0/8', { adminAuthenticated: true });
        assert.equal(allowed, true);
    });

    it('sends a signed-out browser to the login page rather than refusing it', () => {
        const { allowed, res } = call('10.0.0.5', '10.0.0.0/8', {}, 'text/html');
        assert.equal(allowed, false);
        assert.equal(res.statusCode, 302);
        assert.match(res.body, /\/admin\/login/);
    });

    it('answers 401, not a redirect, to a signed-out JSON client', () => {
        const { allowed, res } = call('10.0.0.5', '10.0.0.0/8', {}, 'application/json');
        assert.equal(allowed, false);
        assert.equal(res.statusCode, 401);
        assert.equal(res.jsonData.error, 'Authentication required', JSON.stringify(res.jsonData));
    });
});

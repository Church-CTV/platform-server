import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('lanRestrict middleware', () => {
    let lanRestrict;

    before(() => {
        delete require.cache[require.resolve('../../middleware/lanRestrict.js')];
        lanRestrict = require('../../middleware/lanRestrict.js').lanRestrict;
    });

    function createMockReq(ip, headers = {}) {
        return {
            ip,
            connection: { remoteAddress: ip },
            headers,
            xhr: false
        };
    }

    function createMockRes() {
        const res = {
            statusCode: 200,
            body: '',
            jsonData: null,
            headers: {},
            // `X-CTV-Denied` is set by the middleware on every refusal; Express' response has `set`, so
            // the mock has to model it or the mock, not the behaviour, decides the test.
            set(name, value) {
                this.headers[name.toLowerCase()] = value;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            send(text) {
                this.body = text;
            },
            json(data) {
                this.jsonData = data;
            }
        };
        return res;
    }

    it('allows request when ALLOWED_NETWORKS is empty', () => {
        const orig = process.env.ALLOWED_NETWORKS;
        delete process.env.ALLOWED_NETWORKS;
        let nextCalled = false;
        const req = createMockReq('192.168.1.100');
        const res = createMockRes();
        lanRestrict(req, res, () => {
            nextCalled = true;
        });
        assert.ok(nextCalled);
        process.env.ALLOWED_NETWORKS = orig;
    });

    it('allows request from matching /24 network', () => {
        process.env.ALLOWED_NETWORKS = '192.168.1.0/24';
        let nextCalled = false;
        const req = createMockReq('192.168.1.50');
        const res = createMockRes();
        lanRestrict(req, res, () => {
            nextCalled = true;
        });
        assert.ok(nextCalled);
        delete process.env.ALLOWED_NETWORKS;
    });

    it('blocks request from non-matching network', () => {
        process.env.ALLOWED_NETWORKS = '10.0.0.0/24';
        const req = createMockReq('192.168.1.50');
        const res = createMockRes();
        lanRestrict(req, res, () => {});
        assert.strictEqual(res.statusCode, 403);
        delete process.env.ALLOWED_NETWORKS;
    });

    it('blocks request when CIDR prefix is missing (no private IP fallback)', () => {
        process.env.ALLOWED_NETWORKS = '192.168.1.0';
        const req = createMockReq('10.0.0.1');
        const res = createMockRes();
        lanRestrict(req, res, () => {});
        assert.strictEqual(res.statusCode, 403);
        delete process.env.ALLOWED_NETWORKS;
    });

    it('allows all traffic with 0.0.0.0/0', () => {
        process.env.ALLOWED_NETWORKS = '0.0.0.0/0';
        let nextCalled = false;
        const req = createMockReq('203.0.113.50');
        const res = createMockRes();
        lanRestrict(req, res, () => {
            nextCalled = true;
        });
        assert.ok(nextCalled);
        delete process.env.ALLOWED_NETWORKS;
    });

    it('returns 403 JSON for XHR blocked requests', () => {
        process.env.ALLOWED_NETWORKS = '10.0.0.0/24';
        const req = createMockReq('192.168.1.50', { accept: 'application/json' });
        req.xhr = true;
        const res = createMockRes();
        lanRestrict(req, res, () => {});
        assert.strictEqual(res.statusCode, 403);
        assert.ok(res.jsonData.error);
        delete process.env.ALLOWED_NETWORKS;
    });

    it('handles IPv6-mapped IPv4 addresses', () => {
        process.env.ALLOWED_NETWORKS = '192.168.1.0/24';
        let nextCalled = false;
        const req = createMockReq('::ffff:192.168.1.100');
        const res = createMockRes();
        lanRestrict(req, res, () => {
            nextCalled = true;
        });
        assert.ok(nextCalled);
        delete process.env.ALLOWED_NETWORKS;
    });

    it('supports multiple comma-separated networks', () => {
        process.env.ALLOWED_NETWORKS = '10.0.0.0/24,192.168.2.0/24';
        let nextCalled = false;
        const req = createMockReq('192.168.2.10');
        const res = createMockRes();
        lanRestrict(req, res, () => {
            nextCalled = true;
        });
        assert.ok(nextCalled);
        delete process.env.ALLOWED_NETWORKS;
    });
});

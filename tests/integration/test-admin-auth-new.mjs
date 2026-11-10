import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import fs from 'fs-extra';
import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

// Import the new admin router and auth lib
const { flashMiddleware } = await import('../../middleware/adminAuth.js');
const adminRouter = (await import('../../routes/admin.js')).default;

// Simple cookie jar for session tracking
class CookieJar {
    constructor() {
        this.cookies = new Map();
    }
    getSetCookies(headers) {
        const setCookie = headers['set-cookie'];
        if (!setCookie) return;
        for (const cookie of setCookie.split(',')) {
            const name = cookie.split('=')[0];
            this.cookies.set(name, cookie);
        }
    }
    getCookies() {
        return [...this.cookies.values()].join('; ');
    }
}

let server;
let port;

beforeEach((done) => {
    // Reset auth state
    loginAttempts.clear();
    const hashFile = path.join(ROOT, '.admin_password_hash');
    if (fs.existsSync(hashFile)) {
        fs.rmSync(hashFile);
    }

    // Set a test password
    process.env.ADMIN_PASSWORD = 'testPassword123';

    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(ROOT, 'views'));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(
        session({
            secret: 'test-secret-for-integration-tests',
            resave: false,
            saveUninitialized: false,
            cookie: { secure: false, httpOnly: true }
        })
    );

    app.use(flashMiddleware);
    app.use('/admin', adminRouter);

    server = app.listen(0, () => {
        port = server.address().port;
        done();
    });
});

afterEach(() => {
    if (server) {
        server.close();
        server = null;
    }
});

/** Helper to make HTTP requests with cookie tracking */
async function request(method, urlPath, options = {}) {
    const jar = new CookieJar();
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (options.cookies) headers['Cookie'] = options.cookies;

    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: urlPath,
                method,
                headers
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    jar.getSetCookies(res.headers);
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body,
                        cookies: jar.getCookies()
                    });
                });
            }
        );
        req.on('error', reject);
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

test('GET /admin/login - returns 200 with login form', async () => {
    const res = await request('GET', '/admin/login');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('<title>Login'), 'Should have login page title');
    assert.ok(res.body.includes('name="password"'), 'Should have password field');
    assert.ok(res.body.includes('_csrf'), 'Should have CSRF token');
});

test('POST /admin/login - fails with wrong password', async () => {
    const res = await request('POST', '/admin/login', {
        body: 'password=wrongpassword'
    });
    assert.equal(res.status, 200); // Still returns page (with error)
    assert.ok(res.body.includes('Invalid username or password'), 'Should show error message');
});

test('POST /admin/login - succeeds with correct password', async () => {
    const res = await request('POST', '/admin/login', {
        body: 'password=testPassword123'
    });
    assert.equal(res.status, 302); // Redirect after success
    assert.ok(res.headers.location.startsWith('/admin'), 'Should redirect to /admin');
});

test('GET /admin - requires authentication', async () => {
    const res = await request('GET', '/admin');
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('/admin/login'), 'Should redirect to login');
});

test('POST /admin/login - rate limiting after 5 failed attempts', async () => {
    // Send 5 failed attempts
    for (let i = 0; i < 5; i++) {
        await request('POST', '/admin/login', {
            body: 'password=wrongpassword'
        });
    }

    // 6th attempt should be blocked
    const res = await request('POST', '/admin/login', {
        body: 'password=testPassword123'
    });
    assert.equal(res.status, 200);
    assert.ok(
        res.body.includes('Too many failed attempts') || res.body.includes('locked'),
        'Should show lockout message'
    );
});

test('GET /admin/logout - redirects to login', async () => {
    // Login first
    const loginRes = await request('POST', '/admin/login', {
        body: 'password=testPassword123'
    });
    assert.equal(loginRes.status, 302);

    // Logout
    const res = await request('GET', '/admin/logout');
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('/admin/login'), 'Should redirect to login after logout');
});

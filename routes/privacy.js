const express = require('express');
const fs = require('fs-extra');
const path = require('path');

const contentRoot = require('../lib/contentRoot');
const { readFeed } = require('../lib/feedSource');
const { resolve: resolveEffectiveConfig } = require('../lib/effectiveConfig');

const router = express.Router();

// The privacy URL a store submission quotes.
//
// The Example origin has served `GET /privacy` as an HTML page since before this repository existed,
// and its own comment says why: "required by Play + Amazon review". Measured live 2026-11-09: 200,
// text/html, 2,702 bytes, sha256 `4152934c093b7c92de8f1e3f12e14466edf794e42e15450e14db917d314cae7a`.
// The new server had no such route, so the swap would have replaced a legal page a store reviewer may
// follow with a 404 - the kind of break no automated smoke test of the television would ever see.
//
// Two ways to answer, in order:
//   1. the organisation's own file, `<outputDir>/privacy.html`, next to the feed and the artwork. A
//      church's legal wording is the church's to write, and it is text - it does not belong in code.
//   2. a page generated from the effective configuration, for an organisation that has not written one.
// A file that exists but is empty or unreadable is REFUSED with a machine-readable reason: a blank
// legal page is worse than a 500 someone notices, and neither is a reason to serve the wrong words.

const PRIVACY_FILE = 'privacy.html';
const UPDATED_ENV = 'CTV_PRIVACY_UPDATED';
const UPDATED_DATE = /^\d{4}-\d{2}-\d{2}$/;

function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The name in the title and the first line is the channel's own name, from the same merge a
// television is handed - never a string this file invents.
async function publishedIdentity() {
    let feed = null;
    try {
        const input = await readFeed();
        if (input) feed = JSON.parse(input.raw);
    } catch {
        // an unreadable feed must not take the legal page down; the fallback is the operator store
    }
    let name = null;
    let updatedAt = null;
    try {
        const resolved = resolveEffectiveConfig({
            base: feed && feed.config,
            profilePath: process.env.CTV_SERVER_PROFILE,
            storePath: process.env.CTV_CHANNEL_CONFIG
        });
        name = resolved.config && resolved.config.channel && resolved.config.channel.name;
    } catch {
        // resolve() already reports the reason to the config endpoint; here we only need a name
    }
    if (!name) name = feed && feed.providerName;
    const configured = process.env[UPDATED_ENV];
    if (configured && UPDATED_DATE.test(configured)) updatedAt = configured;
    else if (feed && typeof feed.lastUpdated === 'string' && UPDATED_DATE.test(feed.lastUpdated.slice(0, 10)))
        updatedAt = feed.lastUpdated.slice(0, 10);
    return { name: name || 'this channel', updatedAt };
}

function generatedPage({ name, updatedAt }) {
    const when = updatedAt
        ? `<p><em>Last updated: ${escapeHtml(updatedAt)}</em></p>`
        : '<p><em>This page is generated from the channel&#39;s published configuration.</em></p>';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — ${escapeHtml(name)} App</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;color:#1a1a1a;max-width:760px;margin:2rem auto;padding:0 1.2rem}
h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:1.6rem}
</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p><strong>${escapeHtml(name)}</strong></p>
${when}

<h2>Overview</h2>
<p>The ${escapeHtml(name)} app (the &quot;App&quot;) is a streaming channel for live services, recorded talks and related content on television apps.</p>

<h2>Data We Collect</h2>
<p>We use the following categories of data:</p>
<ol>
<li><strong>Content usage (analytics events)</strong> — We send anonymous usage events to measure how the App is used. These include: page impressions, play and playback-position events, searches, and deep links. Events are sent in batches to our server. They are tied to an anonymous session and device, not to your identity.</li>
<li><strong>Device information</strong> — Basic device information (device model, operating-system version) to help debug issues and improve the App.</li>
<li><strong>Crash reports</strong> — If the App crashes we collect an anonymous crash log, which includes a stack trace but no personal information.</li>
<li><strong>Continue-watching</strong> — Play positions are stored on your device and restored when you return.</li>
</ol>

<h2>Data We Do NOT Collect</h2>
<ul>
<li>We do not collect your name, email address or any other direct identifier.</li>
<li>We do not sell your data to third parties.</li>
<li>We do not collect sensitive personal data (health, finances, precise location and so on).</li>
</ul>

<h2>Cookies and Tracking</h2>
<p>The App does not use cookies. It makes ordinary HTTPS requests to fetch content and to send usage events.</p>

<h2>Data Sharing</h2>
<p>We do not share your personal data with third parties. Content is delivered from the channel&#39;s own server.</p>

<h2>Your Choices</h2>
<p>Analytics are collected to improve the App. You can close the App at any time. If you have questions or want your data removed, contact the church office.</p>

<h2>Children&#39;s Privacy</h2>
<p>This App is not directed to children under 13 and does not knowingly collect personal information from children.</p>

<h2>Updates</h2>
<p>We may update this privacy policy. Changes are reflected here with a new &quot;last updated&quot; date.</p>
</body>
</html>`;
}

router.get('/privacy', async (req, res, next) => {
    const file = path.join(contentRoot.outputDir(), PRIVACY_FILE);
    try {
        if (await fs.pathExists(file)) {
            const html = await fs.readFile(file, 'utf8');
            if (!html.trim()) {
                return res.status(500).json({ error: 'privacy-file-empty', file });
            }
            return res.type('html').send(html);
        }
        res.type('html').send(generatedPage(await publishedIdentity()));
    } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
            return res.status(500).json({ error: 'privacy-file-unreadable', reason: err.code });
        }
        next(err);
    }
});

module.exports = router;

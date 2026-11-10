import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);

// Why this file exists: the feed pipeline used to read one hard-coded ../Videos directory and one
// hard-coded ../videos.json, so every unit test mutated the working tree and "npm test" answers changed
// depending on what ran before it (test-feedGenerator failed with a stray 'CI test video' after any
// integration run). Generation must take its content root as an input - which is also what running one
// server for several organisations needs. These tests pin that seam, and they never touch the repo tree.
describe('content root is an input, not a constant', () => {
    let tmp;
    let saved = {};

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-content-root-'));
        for (const k of ['CTV_VIDEOS_DIR', 'CTV_VIDEOS_METADATA', 'CTV_FEED_OUTPUT_DIR']) {
            saved[k] = process.env[k];
        }
    });

    after(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('defaults to the repository layout when nothing is set', () => {
        const contentRoot = require('../../lib/contentRoot.js');
        delete process.env.CTV_VIDEOS_DIR;
        delete process.env.CTV_VIDEOS_METADATA;
        assert.equal(contentRoot.videosDir(), path.join(process.cwd(), 'Videos'));
        assert.equal(contentRoot.metadataPath(), path.join(process.cwd(), 'videos.json'));
    });

    it('honours an override, so a second organisation can have its own content root', () => {
        const contentRoot = require('../../lib/contentRoot.js');
        const dir = path.join(tmp, 'org-b-videos');
        fs.mkdirSync(dir, { recursive: true });
        process.env.CTV_VIDEOS_DIR = dir;
        process.env.CTV_VIDEOS_METADATA = path.join(tmp, 'org-b-videos.json');
        assert.equal(contentRoot.videosDir(), dir);
        assert.equal(contentRoot.metadataPath(), path.join(tmp, 'org-b-videos.json'));
        delete process.env.CTV_VIDEOS_DIR;
        delete process.env.CTV_VIDEOS_METADATA;
    });

    it('refuses a content root that does not exist instead of generating an empty feed', () => {
        const contentRoot = require('../../lib/contentRoot.js');
        process.env.CTV_VIDEOS_DIR = path.join(tmp, 'nope');
        assert.throws(() => contentRoot.requireVideosDir(), /videos-dir-missing/);
        delete process.env.CTV_VIDEOS_DIR;
    });

    it('generates a feed from a content root nobody else can pollute', async () => {
        const dir = path.join(tmp, 'hermetic-videos');
        const meta = path.join(tmp, 'hermetic-videos.json');
        fs.mkdirSync(dir, { recursive: true });
        process.env.CTV_VIDEOS_DIR = dir;
        process.env.CTV_VIDEOS_METADATA = meta;
        process.env.CTV_FEED_OUTPUT_DIR = path.join(tmp, 'hermetic-output');
        const fixtures = [
            ['z-oct-new.mp4', 'Newer October video', '2026-10-20'],
            ['a-oct-old.mp4', 'Older October video', '2026-10-01'],
            ['sep-one.mp4', 'September video', '2026-09-30']
        ];
        const metadata = {};
        for (const [filename, title, releaseDate] of fixtures) {
            // created oldest-first on purpose: the names make directory order oppose the expected sort,
            // so a comparator that stops working cannot pass by inheriting the input order
            execSync(
                `ffmpeg -f lavfi -i color=c=black:s=320x240:d=1 -c:v libx264 -pix_fmt yuv420p -y ${path.join(dir, filename)}`,
                { stdio: 'pipe' }
            );
            metadata[filename] = { title, description: title, releaseDate };
        }
        fs.writeFileSync(meta, JSON.stringify(metadata));

        const feedGen = require('../../lib/feedGenerator.js');
        const feed = await feedGen.generateFeed({ baseUrl: 'http://hermetic.local:3000' });
        const rows = Object.keys(feed).filter((k) => Array.isArray(feed[k]));
        // the point: exactly these three items, whatever is sitting in the repository's Videos/ directory
        assert.deepEqual(rows, ['October 2026', 'September 2026']);
        assert.deepEqual(
            feed['October 2026'].map((i) => i.title),
            ['Newer October video', 'Older October video']
        );
        assert.equal(feed['September 2026'].length, 1);
        assert.equal(feed['September 2026'][0].content.videos[0].url.startsWith('http://hermetic.local:3000/'), true);
        delete process.env.CTV_VIDEOS_DIR;
        delete process.env.CTV_VIDEOS_METADATA;
        delete process.env.CTV_FEED_OUTPUT_DIR;
    });

    it('leaves the repository working tree exactly as it found it', () => {
        // a suite that dirties the content paths cannot be used to verify a release build: the artifact it
        // just tested is not the artifact that would ship. Scoped to the generated paths on purpose.
        const dirty = execSync('git status --porcelain -- Videos videos.json output', { cwd: process.cwd() })
            .toString()
            .trim();
        assert.equal(dirty, '', `the suite left the tree dirty:\n${dirty}`);
    });
});

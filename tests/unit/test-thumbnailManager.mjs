import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const OUTPUT_DIR = path.join(process.cwd(), 'output');
const THUMBS_DIR = path.join(OUTPUT_DIR, 'thumbnails');
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const UPLOAD_THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbnails');
const VIDEOS_DIR = path.join(process.cwd(), 'Videos');
const TEST_VIDEO = path.join(VIDEOS_DIR, 'test-thumb.mp4');
const REGEN_THUMB_PATH = path.join(VIDEOS_DIR, 'thumb-mgr-regen.mp4');
const METADATA_PATH = path.join(process.cwd(), 'videos.json');
const METADATA_BACKUP = path.join(process.cwd(), 'videos.json.test_backup');

let metadataExisted = false;
let videosDirExisted = false;
let thumbsDirExisted = false;
let uploadsDirExisted = false;
let uploadThumbsDirExisted = false;

function saveMetadata() {
    metadataExisted = fs.existsSync(METADATA_PATH);
    if (metadataExisted) {
        fs.copyFileSync(METADATA_PATH, METADATA_BACKUP);
    }
}

function restoreMetadata() {
    if (fs.existsSync(METADATA_BACKUP)) {
        fs.copyFileSync(METADATA_BACKUP, METADATA_PATH);
        fs.rmSync(METADATA_BACKUP);
    } else if (!metadataExisted && fs.existsSync(METADATA_PATH)) {
        fs.rmSync(METADATA_PATH);
    }
}

describe('thumbnailManager', () => {
    let thumbManager;

    before(() => {
        saveMetadata();
        videosDirExisted = fs.existsSync(VIDEOS_DIR);
        thumbsDirExisted = fs.existsSync(THUMBS_DIR);
        uploadsDirExisted = fs.existsSync(UPLOADS_DIR);
        uploadThumbsDirExisted = fs.existsSync(UPLOAD_THUMBS_DIR);
        if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });
        if (!fs.existsSync(UPLOAD_THUMBS_DIR)) fs.mkdirSync(UPLOAD_THUMBS_DIR, { recursive: true });
        if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
        // Create test video in before() so it survives feedGenerator's cleanup
        const { execSync } = require('child_process');
        execSync(
            `ffmpeg -f lavfi -i color=c=black:s=320x240:d=2 -c:v libx264 -pix_fmt yuv420p -y ${REGEN_THUMB_PATH}`,
            { stdio: 'pipe' }
        );
        thumbManager = require('../../lib/thumbnailManager.js');
    });

    after(() => {
        restoreMetadata();
        for (const file of [TEST_VIDEO, REGEN_THUMB_PATH]) {
            if (fs.existsSync(file)) fs.rmSync(file);
        }
        const testArtifacts = [
            path.join(THUMBS_DIR, 'test-thumb.jpg'),
            path.join(THUMBS_DIR, 'thumb-mgr-regen.jpg'),
            path.join(UPLOAD_THUMBS_DIR, 'test-thumb.jpg'),
            path.join(UPLOAD_THUMBS_DIR, 'test-thumb2.png')
        ];
        for (const file of testArtifacts) {
            if (fs.existsSync(file)) fs.rmSync(file);
        }
        const managedDirs = [
            [UPLOAD_THUMBS_DIR, uploadThumbsDirExisted],
            [UPLOADS_DIR, uploadsDirExisted],
            [THUMBS_DIR, thumbsDirExisted],
            [VIDEOS_DIR, videosDirExisted]
        ];
        for (const [dir, existed] of managedDirs) {
            if (!existed && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                fs.rmSync(dir, { recursive: true });
            }
        }
    });

    it('getThumbnailPath returns uploaded thumbnail URL when set', async () => {
        const { updateVideoThumbnail, deleteVideoMetadata } = require('../../lib/videoMetadata.js');
        updateVideoThumbnail('test-thumb.mp4', '/uploads/thumbnails/custom.jpg');
        const result = await thumbManager.getThumbnailPath('test-thumb.mp4');
        assert.strictEqual(result, '/uploads/thumbnails/custom.jpg');
        updateVideoThumbnail('test-thumb.mp4', null);
        deleteVideoMetadata('test-thumb.mp4');
    });

    it('getThumbnailPath returns null when no thumbnail exists', async () => {
        const result = await thumbManager.getThumbnailPath('nonexistent-video.mp4');
        assert.strictEqual(result, null);
    });

    it('getThumbnailPath returns auto thumbnail when exists', async () => {
        fs.writeFileSync(TEST_VIDEO, Buffer.alloc(1024, 'test'));
        const autoThumbPath = path.join(THUMBS_DIR, 'test-thumb.jpg');
        fs.writeFileSync(autoThumbPath, Buffer.alloc(100, 'thumb'));
        const result = await thumbManager.getThumbnailPath('test-thumb.mp4');
        assert.ok(typeof result === 'string' && result.includes('test-thumb'));
        fs.rmSync(autoThumbPath);
        fs.rmSync(TEST_VIDEO);
    });

    it('uploadThumbnail saves and registers thumbnail', async () => {
        const buffer = Buffer.alloc(100, 'png-data');
        const result = await thumbManager.uploadThumbnail('test-thumb2.mp4', buffer, 'image/png');
        assert.ok(typeof result === 'string' && result.includes('test-thumb2'));
        const thumbPath = path.join(UPLOAD_THUMBS_DIR, 'test-thumb2.png');
        assert.ok(fs.existsSync(thumbPath));
        fs.rmSync(thumbPath);
        const { updateVideoThumbnail } = require('../../lib/videoMetadata.js');
        updateVideoThumbnail('test-thumb2.mp4', null);
    });

    it('regenerateThumbnail creates new auto thumbnail', async () => {
        const result = await thumbManager.regenerateThumbnail('thumb-mgr-regen.mp4');
        assert.ok(result);
        const autoThumbPath = path.join(THUMBS_DIR, 'thumb-mgr-regen.jpg');
        assert.ok(fs.existsSync(autoThumbPath));
        fs.rmSync(autoThumbPath);
    });

    it('regenerateThumbnail throws for missing video', async () => {
        try {
            await thumbManager.regenerateThumbnail('missing.mp4');
            assert.fail('Should have thrown');
        } catch (err) {
            assert.ok(err.message.includes('Video file not found'));
        }
    });

    it('deleteThumbnail removes auto and upload thumbnails', () => {
        const autoThumb = path.join(THUMBS_DIR, 'test-thumb.jpg');
        const uploadThumb = path.join(UPLOAD_THUMBS_DIR, 'test-thumb.jpg');
        fs.writeFileSync(autoThumb, Buffer.alloc(100, 'data'));
        fs.writeFileSync(uploadThumb, Buffer.alloc(100, 'data'));
        thumbManager.deleteThumbnail('test-thumb.jpg');
        assert.ok(!fs.existsSync(autoThumb));
        assert.ok(!fs.existsSync(uploadThumb));
    });

    it('sanitizeTitle handles special characters', () => {
        const result = thumbManager.sanitizeTitle('Test|Video: Special!@#$%');
        assert.strictEqual(result, 'Test Video Special');
    });

    it('sanitizeTitle handles empty string', () => {
        const result = thumbManager.sanitizeTitle('');
        assert.strictEqual(result, '');
    });

    it('sanitizeTitle trims whitespace', () => {
        const result = thumbManager.sanitizeTitle('  hello   world  ');
        assert.strictEqual(result, 'hello world');
    });
});

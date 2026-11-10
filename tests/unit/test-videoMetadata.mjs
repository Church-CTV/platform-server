import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const METADATA_PATH = path.join(process.cwd(), 'videos.json');
const BACKUP_PATH = path.join(process.cwd(), 'videos.json.test_backup');

let metadataExisted = false;

function cleanup() {
    metadataExisted = fs.existsSync(METADATA_PATH);
    if (metadataExisted) {
        if (fs.existsSync(BACKUP_PATH)) fs.rmSync(BACKUP_PATH);
        fs.renameSync(METADATA_PATH, BACKUP_PATH);
    }
}

function restore() {
    if (fs.existsSync(BACKUP_PATH)) {
        fs.renameSync(BACKUP_PATH, METADATA_PATH);
    } else if (!metadataExisted && fs.existsSync(METADATA_PATH)) {
        fs.rmSync(METADATA_PATH);
    }
}

describe('videoMetadata', () => {
    let vm;

    before(() => {
        cleanup();
        fs.writeFileSync(METADATA_PATH, '{}');
        delete require.cache[require.resolve('../../lib/videoMetadata.js')];
        vm = require('../../lib/videoMetadata.js');
    });

    it('returns empty object when no metadata exists', () => {
        const all = vm.getAllVideos();
        assert.deepStrictEqual(all, {});
    });

    it('returns null for unknown video', () => {
        assert.strictEqual(vm.getVideoMetadata('nonexistent.mp4'), null);
    });

    it('sets and retrieves metadata', () => {
        vm.setVideoMetadata('test.mp4', { title: 'Test Video', category: 'Sermons' });
        const meta = vm.getVideoMetadata('test.mp4');
        assert.strictEqual(meta.title, 'Test Video');
        assert.strictEqual(meta.category, 'Sermons');
    });

    it('merges metadata on update', () => {
        vm.setVideoMetadata('test.mp4', { description: 'A test' });
        const meta = vm.getVideoMetadata('test.mp4');
        assert.strictEqual(meta.title, 'Test Video');
        assert.strictEqual(meta.description, 'A test');
    });

    it('deletes metadata', () => {
        vm.deleteVideoMetadata('test.mp4');
        assert.strictEqual(vm.getVideoMetadata('test.mp4'), null);
    });

    it('convenience: updateVideoTitle', () => {
        vm.setVideoMetadata('vid.mp4', {});
        vm.updateVideoTitle('vid.mp4', 'New Title');
        assert.strictEqual(vm.getVideoMetadata('vid.mp4').title, 'New Title');
        vm.deleteVideoMetadata('vid.mp4');
    });

    it('updateVideoDescription sets description', () => {
        vm.setVideoMetadata('desc-test.mp4', {});
        vm.updateVideoDescription('desc-test.mp4', 'A great description');
        assert.strictEqual(vm.getVideoMetadata('desc-test.mp4').description, 'A great description');
        vm.deleteVideoMetadata('desc-test.mp4');
    });

    it('updateVideoReleaseDate sets releaseDate', () => {
        vm.setVideoMetadata('date-test.mp4', {});
        vm.updateVideoReleaseDate('date-test.mp4', '2025-01-15');
        assert.strictEqual(vm.getVideoMetadata('date-test.mp4').releaseDate, '2025-01-15');
        vm.deleteVideoMetadata('date-test.mp4');
    });

    it('updateVideoCategory sets category', () => {
        vm.setVideoMetadata('cat-test.mp4', {});
        vm.updateVideoCategory('cat-test.mp4', 'Sermons');
        assert.strictEqual(vm.getVideoMetadata('cat-test.mp4').category, 'Sermons');
        vm.deleteVideoMetadata('cat-test.mp4');
    });

    after(() => {
        restore();
    });
});

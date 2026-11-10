import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const fsExtra = require('fs-extra');

const VIDEOS_DIR = path.join(process.cwd(), 'Videos');
const TEST_VIDEO_NAME = `roku-stream-test-${process.pid}.mp4`;
const TEST_VIDEO = path.join(VIDEOS_DIR, TEST_VIDEO_NAME);
const TEST_MKV_NAME = `roku-test-${process.pid}.mkv`;
const TEST_MKV_PATH = path.join(VIDEOS_DIR, TEST_MKV_NAME);
let videosDirExisted = false;

describe('stream route', () => {
    let streamRouter;

    before(() => {
        videosDirExisted = fs.existsSync(VIDEOS_DIR);
        if (!videosDirExisted) {
            fs.mkdirSync(VIDEOS_DIR, { recursive: true });
        }
        streamRouter = require('../../routes/stream.js');
    });

    after(() => {
        for (const file of [TEST_VIDEO, TEST_MKV_PATH]) {
            if (fs.existsSync(file)) fs.rmSync(file);
        }
        if (!videosDirExisted && fs.existsSync(VIDEOS_DIR) && fs.readdirSync(VIDEOS_DIR).length === 0) {
            fs.rmSync(VIDEOS_DIR, { recursive: true });
        }
    });

    function createMockReq(params, headers = {}) {
        return {
            params,
            headers
        };
    }

    function createMockRes() {
        const res = {
            headersSent: false,
            statusCode: 200,
            chunks: [],
            status(code) {
                this.statusCode = code;
                return this;
            },
            writeHead(status, headers) {
                this.headersSent = true;
                this.statusCode = status;
                this.responseHeaders = headers;
            },
            send(text) {
                this.body = text;
            },
            end(data) {
                if (data) this.chunks.push(Buffer.from(data));
            },
            on(_event, _fn) {
                return this;
            },
            once(_event, _fn) {
                return this;
            },
            emit(_event, ..._args) {
                return true;
            },
            write(_data) {
                return true;
            },
            pipe(dest) {
                setImmediate(() => dest.emit('end'));
                return dest;
            }
        };
        return res;
    }

    it('returns 404 for non-existent video', () => {
        const req = createMockReq({ videoName: 'does-not-exist.mp4' });
        const res = createMockRes();
        streamRouter.stack[0].route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 404);
    });

    it('returns 200 for existing video without range', () => {
        fs.writeFileSync(TEST_VIDEO, Buffer.alloc(1024, 'test'));
        const req = createMockReq({ videoName: TEST_VIDEO_NAME });
        const res = createMockRes();
        streamRouter.stack[0].route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.responseHeaders['Content-Type'], 'video/mp4');
    });

    it('returns 206 for existing video with range header', () => {
        fs.writeFileSync(TEST_VIDEO, Buffer.alloc(1024, 'test'));
        const req = createMockReq({ videoName: TEST_VIDEO_NAME }, { range: 'bytes=0-511' });
        const res = createMockRes();
        streamRouter.stack[0].route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 206);
        assert.strictEqual(res.responseHeaders['Accept-Ranges'], 'bytes');
    });

    it('sets correct content type for mkv files', () => {
        const mkvPath = TEST_MKV_PATH;
        fs.writeFileSync(mkvPath, Buffer.alloc(1024, 'test'));
        const req = createMockReq({ videoName: TEST_MKV_NAME });
        const res = createMockRes();
        streamRouter.stack[0].route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.responseHeaders['Content-Type'], 'video/x-matroska');
        fs.rmSync(mkvPath);
    });

    it('handles stream error gracefully', async () => {
        fs.writeFileSync(TEST_VIDEO, Buffer.alloc(1024, 'test'));
        const req = createMockReq({ videoName: TEST_VIDEO_NAME });
        const res = createMockRes();
        const routeHandler = streamRouter.stack[0].route.stack[0].handle;

        let errorHandled = false;
        await new Promise((resolve) => {
            const originalCreateReadStream = fsExtra.createReadStream.bind(fsExtra);
            fsExtra.createReadStream = function (...args) {
                const stream = originalCreateReadStream(...args);
                const originalOn = stream.on.bind(stream);
                stream.on = function (event, handler) {
                    if (event === 'error') {
                        const wrappedHandler = (err) => {
                            errorHandled = true;
                            handler(err);
                        };
                        setImmediate(() => wrappedHandler(new Error('Read error')));
                    }
                    return originalOn(event, handler);
                };
                return stream;
            };
            routeHandler(req, res, () => {});
            setTimeout(resolve, 50);
            fsExtra.createReadStream = originalCreateReadStream;
        });
        assert.strictEqual(errorHandled, true);
    });

    it('handles suffix range (bytes=-512) for last 512 bytes', () => {
        fs.writeFileSync(TEST_VIDEO, Buffer.alloc(1024, 'test'));
        const req = createMockReq({ videoName: TEST_VIDEO_NAME }, { range: 'bytes=-512' });
        const res = createMockRes();
        streamRouter.stack[0].route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 206);
        assert.strictEqual(res.responseHeaders['Content-Range'], 'bytes 512-1023/1024');
        assert.strictEqual(res.responseHeaders['Content-Length'], 512);
    });

    it('handles open-ended range (bytes=512-) from byte 512 to end', () => {
        fs.writeFileSync(TEST_VIDEO, Buffer.alloc(1024, 'test'));
        const req = createMockReq({ videoName: TEST_VIDEO_NAME }, { range: 'bytes=512-' });
        const res = createMockRes();
        streamRouter.stack[0].route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 206);
        assert.strictEqual(res.responseHeaders['Content-Range'], 'bytes 512-1023/1024');
        assert.strictEqual(res.responseHeaders['Content-Length'], 512);
    });

    it('returns 416 for invalid suffix range (bytes=-0)', () => {
        fs.writeFileSync(TEST_VIDEO, Buffer.alloc(1024, 'test'));
        const req = createMockReq({ videoName: TEST_VIDEO_NAME }, { range: 'bytes=-0' });
        const res = createMockRes();
        streamRouter.stack[0].route.stack[0].handle(req, res, () => {});
        assert.strictEqual(res.statusCode, 416);
    });
});

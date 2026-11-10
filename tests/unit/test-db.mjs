import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const DB_PATH = path.join(process.cwd(), 'analytics.db');
const BACKUP_PATH = path.join(process.cwd(), 'analytics.db.test_backup');

function cleanup() {
    if (fs.existsSync(DB_PATH)) {
        if (fs.existsSync(BACKUP_PATH)) fs.rmSync(BACKUP_PATH);
        fs.renameSync(DB_PATH, BACKUP_PATH);
    }
}

function restore() {
    if (fs.existsSync(BACKUP_PATH)) {
        fs.renameSync(BACKUP_PATH, DB_PATH);
    } else if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH);
    }
}

describe('db', () => {
    let dbModule;

    before(() => {
        cleanup();
        // Force fresh require
        delete require.cache[require.resolve('../../lib/db.js')];
        dbModule = require('../../lib/db.js');
    });

    after(() => {
        dbModule.closeDb();
        restore();
    });

    it('getDb returns a database instance', () => {
        const db = dbModule.getDb();
        assert.ok(db);
        assert.strictEqual(typeof db.pragma, 'function');
    });

    it('getDb returns the same instance on subsequent calls', () => {
        const db1 = dbModule.getDb();
        const db2 = dbModule.getDb();
        assert.strictEqual(db1, db2);
    });

    it('creates events table if not exists', () => {
        const db = dbModule.getDb();
        const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
        assert.ok(tableInfo);
        assert.strictEqual(tableInfo.name, 'events');
    });

    it('creates summary table if not exists', () => {
        const db = dbModule.getDb();
        const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='summary'").get();
        assert.ok(tableInfo);
        assert.strictEqual(tableInfo.name, 'summary');
    });

    it('closeDb closes and nullifies the connection', () => {
        dbModule.closeDb();
        // After close, next getDb should create a new connection
        const db1 = dbModule.getDb();
        dbModule.closeDb();
        const db2 = dbModule.getDb();
        assert.ok(db1 !== db2 || !db1); // Either different instances or both null
    });

    it('WAL journal mode is set', () => {
        const db = dbModule.getDb();
        const result = db.pragma('journal_mode', { simple: true });
        assert.strictEqual(result, 'wal');
    });
});

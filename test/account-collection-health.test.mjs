import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MonitorDatabase } from '../lib/database.mjs';
import { collectionFailureCode } from '../lib/collection-failure-code.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';

function fixture(t) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: '测试账号',
    locator: 'MS4wLjABAAAAhealthFixture123456789', provider: 'manual',
    metadata: { platform: 'douyin' } });
  return { database, target };
}

test('error categories are bounded and do not persist arbitrary codes', () => {
  assert.equal(collectionFailureCode({ code: 'blocked' }), 'blocked');
  assert.equal(collectionFailureCode({ code: 'ETIMEDOUT' }), 'network_error');
  assert.equal(collectionFailureCode({ code: 'secret=abc' }), 'unknown');
});

test('each failed account attempt increments only that account; a saved collection resets it', t => {
  const { database, target } = fixture(t);
  const other = database.createTarget({ type: 'account', label: '其他账号',
    locator: 'MS4wLjABAAAAotherFixture123456789', provider: 'manual',
    metadata: { platform: 'douyin' } });
  for (let index = 1; index <= 3; index++) {
    database.recordFailure(target, null, Object.assign(new Error('公开来源拒绝'), { code: 'blocked' }));
    const row = database.getTarget(target.id);
    assert.equal(row.consecutive_failures, index);
    assert.equal(row.last_error_code, 'blocked');
    assert.equal(row.last_status, 'error');
  }
  const projected = getProductInsights(database, { period: 'day', timeZone: 'Asia/Shanghai' });
  const current = projected.accounts.find(account => account.id === target.id);
  assert.equal(current.status.consecutiveFailures, 3);
  assert.equal(current.status.lastErrorCode, 'blocked');
  assert.equal(database.getTarget(other.id).consecutive_failures, null);
  database.saveCollection(target, null, { snapshot: { followers: 12, totalLikes: 7, totalPosts: 0 },
    posts: [], raw: {}, accountStatus: 'available', worksCoverage: 'unknown' });
  const saved = database.getTarget(target.id);
  assert.equal(saved.consecutive_failures, 0);
  assert.equal(saved.last_error_code, null);
  assert.notEqual(saved.last_status, 'error');
  const healthy = getProductInsights(database, { period: 'day', timeZone: 'Asia/Shanghai' });
  assert.equal(healthy.accounts.find(account => account.id === target.id).status.consecutiveFailures, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM audits WHERE target_id=?').get(target.id).n, 4);
});

test('an unclassified failure remains explicit unknown rather than guessing from prose', t => {
  const { database, target } = fixture(t);
  database.recordFailure(target, null, new Error('new upstream text'));
  assert.equal(database.getTarget(target.id).last_error_code, 'unknown');
});

test('health streak and audit roll back together when the audit write fails', t => {
  const { database, target } = fixture(t);
  database.db.exec(`CREATE TEMP TRIGGER reject_health_audit BEFORE INSERT ON audits
    BEGIN SELECT RAISE(ABORT, 'audit write failed'); END`);
  assert.throws(() => database.recordFailure(target, null, { code: 'blocked', message: 'HTTP 403' }), /audit write failed/);
  const row = database.getTarget(target.id);
  assert.equal(row.consecutive_failures, null);
  assert.equal(row.last_error_code, null);
  assert.equal(row.last_status, 'pending');
});

test('pre-feature failed accounts keep an unknown streak until a real success resets the baseline', t => {
  const { database, target } = fixture(t);
  database.db.prepare("UPDATE targets SET last_status='error',last_error='old failure' WHERE id=?").run(target.id);
  database.recordFailure(target, null, { code: 'blocked', message: 'new failure' });
  assert.equal(database.getTarget(target.id).consecutive_failures, null);
  database.saveCollection(target, null, { snapshot: { followers: 2, totalLikes: 3, totalPosts: 0 },
    posts: [], raw: {}, accountStatus: 'available', worksCoverage: 'unknown' });
  database.recordFailure(target, null, { code: 'blocked', message: 'after baseline' });
  assert.equal(database.getTarget(target.id).consecutive_failures, 1);
});

test('older target schema migrates without erasing its account or inventing a failure streak', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mcn-health-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('account','hashtag')),
    label TEXT NOT NULL, locator TEXT NOT NULL, provider TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_checked_at TEXT,
    next_check_at TEXT, last_status TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
    UNIQUE(type, locator, provider));`);
  old.prepare(`INSERT INTO targets(type,label,locator,provider,metadata_json,created_at,updated_at,last_status,last_error)
    VALUES('account','既有作者','MS4wLjABAAAAexisting123','public-web','{}','2026-10-01T00:00:00Z',
      '2026-10-01T00:00:00Z','error','旧的失败原因')`).run();
  old.close();
  const database = new MonitorDatabase(path);
  t.after(() => database.close());
  const target = database.db.prepare('SELECT * FROM targets WHERE id=1').get();
  assert.equal(target.label, '既有作者');
  assert.equal(target.last_error, '旧的失败原因');
  assert.equal(target.consecutive_failures, null);
  assert.equal(target.last_error_code, null);
  assert.equal(database.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
});

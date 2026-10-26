import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditShadowFiles, auditShadowWorksSource } from '../scripts/audit-shadow-works-source.mjs';

const sec = 'MS4wLjABAAAA' + 'a'.repeat(40);
const other = 'MS4wLjABAAAA' + 'b'.repeat(40);
const id = n => String(7300000000000000000n + BigInt(n));
const work = n => ({ contentId: id(n), publishEpoch: 1792440000, likes: 1, comments: 0,
  shares: 0, collects: 0, plays: null, playsSource: 'unavailable', sourcePlayValue: 0 });
const record = (targetId, works) => ({ targetId, observedAt: '2026-10-21T10:00:00.123456+00:00',
  finishedAt: '2026-10-21T10:00:20.123456+00:00', status: 'sampled', profile: null, works });

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE targets(id INTEGER,type TEXT,provider TEXT,locator TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE posts(id INTEGER,target_id INTEGER,external_id TEXT,author_id TEXT,raw_json TEXT,first_seen_at TEXT);
    CREATE INDEX idx_post_external ON posts(external_id);`);
  for (const [target, locator] of [[1, sec], [2, other]]) db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)')
    .run(target, 'account', 'public-web', locator, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z');
  const post = (n, target, author, rawAuthor = author) => db.prepare('INSERT INTO posts VALUES(?,?,?,?,?,?)')
    .run(n, target, id(n), author, JSON.stringify({ aweme_id: id(n), author: { sec_uid: rawAuthor } }), '2026-10-21T10:00:10Z');
  post(1, 1, sec); post(3, 1, sec, other); post(4, 2, other); post(5, 1, sec);
  return db;
}

test('shadow audit separates exact overlap, new, wrong target, conflict, invalid ID and zero placeholders', () => {
  const db = fixture();
  try {
    const jsonl = [record(1, [work(1), work(2), work(3), work(4), work(5), { ...work(6), contentId: 'invalid' }]),
      record(2, [work(1)])].map(value => JSON.stringify(value)).join('\n');
    const result = auditShadowWorksSource({ jsonl, db, inputSha256: 'sha', inputBytes: jsonl.length,
      auditedAt: '2026-10-24T00:00:00Z' });
    assert.equal(result.account.sampled, 2);
    assert.equal(result.works.rows, 7);
    assert.equal(result.works.crossTargetVideoIds, 1);
    assert.equal(result.works.counts.exact_post_author_overlap, 2);
    assert.equal(result.works.counts.eligible_external_evidence_stage_only, 1);
    assert.equal(result.works.counts.not_in_posts, 1);
    assert.equal(result.works.counts.other_target_only, 2);
    assert.equal(result.works.counts.same_target_identity_conflict, 1);
    assert.equal(result.works.counts.invalid_video_id, 1);
    assert.equal(result.works.counts.plays_explicitly_unavailable, 7);
    assert.equal(result.works.counts.raw_play_placeholder_zero, 7);
    assert.equal(result.fusionPolicy.forbiddenDirectPostMetricsRows, 7);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, 6, 'audit performs no DB writes');
  } finally { db.close(); }
});

test('invalid sample or future publication cannot be staged, and output never overwrites source or database', async t => {
  const db = fixture();
  try {
    const bad = record(1, [{ ...work(5), publishEpoch: 1892440000 }]);
    bad.finishedAt = '2026-10-21T09:59:00Z';
    const result = auditShadowWorksSource({ jsonl: JSON.stringify(bad), db, inputSha256: 'sha', inputBytes: 1,
      auditedAt: '2026-10-24T00:00:00Z' });
    assert.equal(result.works.counts.invalid_record_time, 1);
    assert.equal(result.works.counts.invalid_publish_time, 1);
    assert.equal(result.works.counts.eligible_external_evidence_stage_only || 0, 0);
  } finally { db.close(); }
  const dir = await mkdtemp(join(tmpdir(), 'shadow-audit-test-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }); });
  const inputPath = join(dir, 'source.jsonl'), databasePath = join(dir, 'db.sqlite'), outputPath = join(dir, 'audit.json');
  await writeFile(inputPath, JSON.stringify(record(1, [work(1)])) + '\n');
  const disk = new DatabaseSync(databasePath);
  disk.exec(`CREATE TABLE targets(id INTEGER,type TEXT,provider TEXT,locator TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE posts(id INTEGER,target_id INTEGER,external_id TEXT,author_id TEXT,raw_json TEXT,first_seen_at TEXT);`);
  disk.close();
  await assert.rejects(auditShadowFiles({ inputPath, databasePath, outputPath: inputPath }), /不可覆盖/);
  const saved = await auditShadowFiles({ inputPath, databasePath, outputPath });
  assert.equal(saved.source.records, 1);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), saved);
  await assert.rejects(auditShadowFiles({ inputPath, databasePath, outputPath }), /EEXIST/);
});

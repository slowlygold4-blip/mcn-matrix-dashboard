// Read-only ordinary-run observation after exact production promotion.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checksum } from '../lib/utils.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const promotion = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase87-promotion.json')));
assert.ok(Number.isFinite(Date.parse(promotion.completedAt)));
for (const [file, hash] of Object.entries(promotion.afterHashes)) assert.equal(sha(await readFile(join(root, file))), hash);
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
const result = { checkedAt: new Date().toISOString(), promotionCompletedAt: promotion.completedAt,
  productionHashes: promotion.afterHashes, noManualSampling: true, noReviewCompletion: true, observations: [] };
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  const rows = db.prepare("SELECT r.id,r.target_id,r.started_at,r.finished_at,r.status,o.* FROM runs r JOIN works_observations o ON o.run_id=r.id WHERE r.trigger_type='works-only' AND julianday(r.started_at)>=julianday(?) AND r.finished_at IS NOT NULL ORDER BY r.id LIMIT 15").all(promotion.completedAt);
  const verified = rows.length ? loadVerifiedWorksOnlyRows(db, result.checkedAt, null, { runIds: rows.map(row => row.run_id) }) : [];
  for (const row of rows) {
    const raw = JSON.parse(row.raw_json), canonical = validateWorksOnlyEvidence(raw);
    assert.equal(new Set([sha(row.raw_json), checksum(raw), checksum(canonical), row.source_checksum]).size, 1);
    assert.ok(verified.some(item => item.run_id === row.run_id && item.target_id === row.target_id));
    const target = db.prepare('SELECT locator FROM targets WHERE id=?').get(row.target_id);
    assert.equal(raw.identity.secUid, target.locator);
    result.observations.push({ runId: row.run_id, targetId: row.target_id, startedAt: row.started_at,
      finishedAt: row.finished_at, status: raw.status, coverage: row.coverage, sourceSha256: row.source_checksum,
      fourHashesEqual: true, actualReaderAccepted: true, postCount: raw.posts.length,
      pages: raw.pagination?.pages?.map(page => ({ requestCursor: page.requestCursor, observedAt: page.observedAt, count: page.acceptedCount })) ?? [],
      stopReason: raw.pagination?.stopReason ?? null, errorCode: row.error_code });
  }
  result.pendingRunIds = db.prepare("SELECT id FROM runs WHERE trigger_type='works-only' AND julianday(started_at)>=julianday(?) AND finished_at IS NULL ORDER BY id LIMIT 15").all(promotion.completedAt).map(row => row.id);
  assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, 0); db.exec('ROLLBACK');
} finally { db.close(); }
result.platformAllWorksRestored = false; result.macOffCollectionProven = false;
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase87-post-promotion.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result));

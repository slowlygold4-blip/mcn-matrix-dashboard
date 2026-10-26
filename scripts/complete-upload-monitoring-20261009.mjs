import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, copyFile, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateProfileMonitoringRecovery, applyProfileMonitoringRecovery } from '../lib/profile-monitoring-recovery.mjs';
import { recordPostIngestionReview } from '../lib/post-ingestion-review.mjs';

// One-off, explicitly invoked recovery. No scheduling, network or source edits.
const mode = process.argv[2];
assert.ok(['clone', 'apply'].includes(mode));
assert.ok(Date.now() < Date.parse('2026-10-09T15:49:00Z'), 'Evidence freshness gate expired; re-review required');
const root = resolve(new URL('../', import.meta.url).pathname);
const out = join(root, 'data/maintenance-journal/20261009-onboarding');
const backup = join(root, 'data/backups/20261009-onboarding/douyin-monitor-auto-20261009T152323740Z-before-profile-recovery-da411d11.sqlite');
const sidecar = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-09-paused-profile-probes-1791559173793/checksum-disclosure-sidecar.json'), 'utf8'));
const inputs = await Promise.all(sidecar.rows.map(async sourceReceipt => ({
  sourceReceipt, sourcePath: resolve(root, sourceReceipt.evidenceFile),
  evidenceText: await readFile(resolve(root, sourceReceipt.evidenceFile), 'utf8'),
})));
assert.equal(inputs.length, 11);
if (mode === 'apply') {
  const clone = JSON.parse(await readFile(join(out, 'recovery-clone.json'), 'utf8'));
  assert.equal(clone.integrity, 'ok');
  assert.equal(clone.applied.length, 11);
  assert.equal(clone.allPreserved, true);
}
let path = join(root, 'data/douyin-monitor.sqlite');
if (mode === 'clone') {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-profile-recovery-'));
  path = join(dir, 'restored.sqlite');
  await copyFile(backup, path, constants.COPYFILE_FICLONE);
}
const db = new DatabaseSync(path);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000');
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const ids = inputs.map(x => x.sourceReceipt.targetId);
const marks = ids.map(() => '?').join(',');
const historicalUpperId = db.prepare('SELECT max(id) AS id FROM snapshots').get().id;
const invariants = () => ({
  frozenRoster: hash(db.prepare('SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key').all()),
  oldImport: hash(db.prepare('SELECT result_json FROM author_resolution_jobs WHERE id=?').get('24ed9508-815c-4c08-81f6-b73266d0f304').result_json),
  metadata: hash(db.prepare(`SELECT id,locator,metadata_json FROM targets WHERE id IN (${marks}) ORDER BY id`).all(...ids)),
  oldHistory: hash(db.prepare(`SELECT id,source_checksum FROM snapshots WHERE target_id IN (${marks}) AND id<=? ORDER BY id`).all(...ids, historicalUpperId)),
  holds: hash(db.prepare(`SELECT id,status,last_error,source_rows_json,source_metadata_json,evidence_version FROM author_resolution_queue WHERE resolved_target_id IN (${marks}) ORDER BY id`).all(...ids)),
});
const report = { startedAt: new Date().toISOString(), mode, databasePath: path, backupPath: backup, applied: [] };
try {
  report.integrity = db.prepare('PRAGMA quick_check').get().quick_check;
  assert.equal(report.integrity, 'ok');
  report.before = invariants();
  assert.equal(report.before.frozenRoster, '5e7b062105a441ea48febf674949229bbb908b6ce4bb5f25eb26e48032db0ab2');
  assert.equal(report.before.oldImport, '0eb5608b368befd7f344e6cc5e1898947094da9f36a52a50a21efd0b3bf59e27');
  for (const input of inputs) {
    const checked = validateProfileMonitoringRecovery(db, input);
    assert.equal(checked.status, 'ready', `${input.sourceReceipt.targetId}: ${checked.reason}`);
    const receipt = applyProfileMonitoringRecovery(db, input, { expectedPlanSha256: checked.planSha256 });
    assert.equal(receipt.status, 'applied');
    const row = db.prepare('SELECT * FROM snapshots WHERE id=?').get(receipt.snapshotId);
    assert.equal(row.captured_at, checked.plan.capturedAt);
    assert.deepEqual([row.followers, row.total_likes, row.total_posts], checked.plan.metrics);
    assert.equal(row.works_coverage, 'unavailable');
    assert.equal(db.prepare('SELECT enabled FROM targets WHERE id=?').get(receipt.targetId).enabled, 1);
    assert.equal(applyProfileMonitoringRecovery(db, input, { expectedPlanSha256: checked.planSha256 }).status, 'already-applied');
    report.applied.push(receipt);
  }
  report.after = invariants();
  assert.deepEqual(report.after, report.before);
  report.allPreserved = true;
  report.foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  assert.equal(report.foreignKeyViolations, 0);
  if (mode === 'apply') {
    report.ingestionReviews = [];
    for (const receipt of report.applied) report.ingestionReviews.push(await recordPostIngestionReview({
      database: db, ledgerDir: join(root, 'data/ingestion-reviews'), runId: receipt.runId,
    }));
  }
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  db.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, `recovery-${mode}${report.error ? '-failed-' + Date.now() : ''}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report));
}

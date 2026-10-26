import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readImportMonitoringStatus } from '../lib/import-monitoring-status.mjs';
import { readMasterRoster } from '../lib/master-roster.mjs';
import { validatedSuccessProof } from '../lib/master-roster-supplement.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), out = root + 'data/maintenance-journal/20261009-id-correction/';
const mode = process.argv[2]; assert.ok(['baseline', 'readback'].includes(mode));
const db = new DatabaseSync(root + 'data/douyin-monitor.sqlite', { readOnly: true });
let report;
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  const stored = db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get('c9895a58-14ef-4f1f-8c88-428fb3ce8d6f');
  const job = { id: stored.id, status: stored.status, request: JSON.parse(stored.request_json) };
  const status = readImportMonitoringStatus(db, job, { limit: 100 }), items = [...status.items];
  for (let offset = 100; offset < status.pagination.total; offset += 100) items.push(...readImportMonitoringStatus(db, job, { offset, limit: 100 }).items);
  const target = db.prepare('SELECT id,label,locator,provider,enabled,metadata_json FROM targets WHERE id=2289').get(); assert.ok(target);
  const original = items.find(value => value.submittedId === '没有后悔药'); assert.ok(original);
  report = { at: new Date().toISOString(), original, counts: status.counts, target,
    uniqueBoundTargets: new Set(items.map(value => value.targetId).filter(Boolean)).size,
    globalTargetCount: db.prepare('SELECT count(*) n FROM targets').get().n,
    globalSuccessReceiptCount: db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n,
    sourceRequest: stored.request_json, sourceResult: stored.result_json, auditWrites: db.prepare('SELECT total_changes() n').get().n };
  if (mode === 'readback') {
    const baseline = JSON.parse(await readFile(out + 'row85-baseline.json', 'utf8'));
    assert.equal(original.status, 'enabled'); assert.equal(original.targetId, 2289);
    assert.deepEqual(original.identityCorrection, { originalAccountId: '没有后悔药', correctedAccountId: '51058454595', status: 'verified' });
    assert.equal(target.label, baseline.target.label); assert.equal(target.locator, baseline.target.locator);
    assert.equal(target.enabled, baseline.target.enabled);
    const withoutResolution = json => { const { resolution, ...userFields } = JSON.parse(json); return userFields; };
    assert.deepEqual(withoutResolution(target.metadata_json), withoutResolution(baseline.target.metadata_json));
    assert.equal(stored.request_json, baseline.sourceRequest); assert.equal(stored.result_json, baseline.sourceResult);
    const roster = readMasterRoster(db), entry = roster.items.find(value => value.accountIds.includes('没有后悔药'));
    assert.equal(entry.targetId, 2289); assert.equal(entry.identityCorrection.status, 'verified');
    const correctionJobId = entry.supplement.jobId;
    const saved = db.prepare('SELECT * FROM author_resolution_success_receipts WHERE target_id=2289 ORDER BY id DESC').all()
      .find(value => validatedSuccessProof(value)?.resolution.authorisedDetailReceipt?.source.jobId === correctionJobId);
    const proof = validatedSuccessProof(saved); assert.ok(proof);
    assert.equal(proof.evidence.douyinId, '51058454595'); assert.equal(proof.resolution.authorisedDetailReceipt.metricsSampled, false);
    const correctionJob = db.prepare('SELECT request_json,finished_at FROM author_resolution_jobs WHERE id=?').get(correctionJobId);
    assert.ok(Date.parse(proof.verifiedAt) >= Date.parse(correctionJob.finished_at));
    assert.equal(JSON.parse(correctionJob.request_json).masterRosterSupplement.version, 2);
    report.correction = { jobId: correctionJobId, targetId: target.id, receiptId: saved.id,
      receiptSha256: saved.receipt_sha256, observedAt: proof.verifiedAt, committedAt: proof.committedAt,
      originalEntryKey: entry.key, reusedExistingTarget: true, userFieldsPreserved: true, fabricatedSnapshots: 0 };
    delete report.sourceRequest; delete report.sourceResult;
  }
  db.exec('ROLLBACK');
} finally { db.close(); }
const path = out + (mode === 'baseline' ? 'row85-baseline' : 'row85-readback-' + Date.now()) + '.json';
await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ path, counts: report.counts, uniqueBoundTargets: report.uniqueBoundTargets,
  globalTargetCount: report.globalTargetCount, globalSuccessReceiptCount: report.globalSuccessReceiptCount, correction: report.correction, auditWrites: report.auditWrites }));

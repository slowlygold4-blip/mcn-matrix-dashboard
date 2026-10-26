import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readImportMonitoringStatus } from '../lib/import-monitoring-status.mjs';
const root = new URL('../', import.meta.url).pathname;
const out = root + 'data/maintenance-journal/20261009-import-pipeline/';
const before = JSON.parse(await readFile(out + 'verification.json', 'utf8'));
const load = JSON.parse(await readFile(out + 'runtime-load.json', 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const db = new DatabaseSync(root + 'data/douyin-monitor.sqlite', { readOnly: true });
db.exec('BEGIN'); let report;
try {
  const row = db.prepare('SELECT id,status,request_json,result_json FROM author_resolution_jobs WHERE id=?').get(before.monitoring.jobId);
  const status = readImportMonitoringStatus(db, { id: row.id, status: row.status, request: JSON.parse(row.request_json) });
  assert.equal(sha(row.request_json), before.newImportRequestSha256);
  assert.equal(sha(row.result_json), before.newImportResultSha256);
  assert.equal(sha(JSON.stringify(db.prepare('SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key').all())), before.frozenRosterSha256);
  const snapshotCount = db.prepare('SELECT count(*) n FROM snapshots').get().n;
  assert.ok(snapshotCount >= before.snapshots);
  const claims = db.prepare("SELECT created_at,count(*) n,count(DISTINCT resource_id) identities FROM activity_log WHERE action='author-resolution.claimed' AND created_at>=? GROUP BY created_at ORDER BY created_at").all(load.signalledAt);
  const results = db.prepare(`SELECT q.status,CASE WHEN q.last_error LIKE '%blocked%' THEN 'platform-blocked'
      WHEN q.last_error LIKE '%403%' THEN 'HTTP-403' WHEN q.last_error IS NULL OR q.last_error='' THEN 'none' ELSE 'other-recorded-error' END reason,COUNT(*) n
    FROM author_resolution_queue q WHERE q.id IN (SELECT CAST(json_extract(details_json,'$.queueId') AS INTEGER)
      FROM activity_log WHERE action='author-resolution.claimed' AND created_at>=?) GROUP BY q.status,reason`).all(load.signalledAt);
  const recentWorks = db.prepare(`SELECT count(*) total,
    SUM(CASE WHEN json_valid(raw_json) AND (json_type(raw_json,'$.author.unique_id')='text' OR json_type(raw_json,'$.author.short_id')='text') THEN 1 ELSE 0 END) withPublicIds
    FROM posts WHERE last_seen_at>=?`).get(load.signalledAt);
  report = { checkedAt: new Date().toISOString(), monitoring: { counts: status.counts, sourceAvailable: status.sourceAvailable,
    inputRows: status.inputRows, checkedAt: status.checkedAt }, preservedOriginalRequestAndResults: true,
    preservedFrozenRoster: true, snapshotCountBefore: before.snapshots, snapshotCountNow: snapshotCount,
    runtimeNaturalClaims: claims, runtimeCurrentClaimResults: results, recentWorks,
    browserChecks: ['当前394/153/241', '尚未接入241按20条翻页', '已启用153筛选', 'Enter只读刷新', '全部状态复原', '控制台error为空'],
    screenshot: 'import-monitoring-ui.png', fullyOnboarded: status.counts.enabled === status.counts.submittedIdentities,
    originalFileSha256: sha(await readFile('/Users/tyke/Downloads/一条小团团切片作品登记表.xlsx')),
    completeGoal: false, userDataMutatedByThisValidation: false };
  assert.equal(report.originalFileSha256, before.originalFileSha256);
} finally { db.exec('ROLLBACK'); db.close(); }
await writeFile(out + 'final-readback.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report));

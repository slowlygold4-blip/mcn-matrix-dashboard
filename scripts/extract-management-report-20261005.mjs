import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MonitorDatabase, normalizeBoardKey } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';
import { readMasterRoster } from '../lib/master-roster.mjs';

const dir = new URL('../reports/2026-10-05/evidence/', import.meta.url);
mkdirSync(dir, { recursive: true });
const filePath = new URL('../data/douyin-monitor.sqlite', import.meta.url).pathname;
const db = new DatabaseSync(filePath, { readOnly: true });
db.function('normalize_board_key', { deterministic: true }, normalizeBoardKey);
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
const adapter = Object.assign(Object.create(MonitorDatabase.prototype), { db, filePath });
const at = new Date().toISOString();
const metadata = { extractedAt: at, timeZone: 'Asia/Shanghai', source: filePath,
  snapshot: db.prepare('SELECT count(*) AS count,min(captured_at) AS firstAt,max(captured_at) AS lastAt,max(id) AS maxId FROM snapshots').get(),
  accountSnapshots: db.prepare("SELECT count(*) AS count,min(s.captured_at) AS firstAt,max(s.captured_at) AS lastAt FROM snapshots s JOIN targets t ON t.id=s.target_id WHERE t.type='account'").get(),
  platforms: db.prepare("SELECT coalesce(json_extract(metadata_json,'$.platform'),'douyin') platform,enabled,count(*) count FROM targets WHERE type='account' GROUP BY 1,2").all(),
  roster: readMasterRoster(db)?.summary,
  schema: 'mcn-report-readonly-v1', ranges: {} };
try {
  for (const [key, startDate, endDate] of [
    ['accumulated','2026-09-12','2026-10-04'],
    ['week','2026-09-28','2026-10-04'],
    ['priorWeek','2026-09-21','2026-09-27'],
    ['month','2026-10-01','2026-10-04'],
    ['today','2026-10-05','2026-10-05'],
  ]) {
    const begun = performance.now();
    const report = getProductInsights(adapter, { period: 'custom', startDate, endDate,
      reference: at, timeZone: 'Asia/Shanghai', includeRecordedWindow: key === 'accumulated' });
    const body = JSON.stringify(report);
    writeFileSync(new URL(`${key}.json`, dir), body);
    metadata.ranges[key] = { startDate,endDate,sha256:createHash('sha256').update(body).digest('hex'),bytes:Buffer.byteLength(body) };
    console.log(JSON.stringify({ key, seconds: +(performance.now()-begun).toFixed(0)/1000, accounts:report.summary.enabledCount,
      metrics:report.summary.metrics, recordedWindow: report.recordedWindow ? {baselineDate:report.recordedWindow.baselineDate,endDate:report.recordedWindow.endDate,comparableCount:report.recordedWindow.comparableCount,metrics:report.recordedWindow.metrics}:null }));
  }
  const topics = adapter.listTopicHistory({ startDate:'2026-09-12',endDate:'2026-10-05' });
  writeFileSync(new URL('topics.json',dir),JSON.stringify(topics));
  metadata.topicsSha256=createHash('sha256').update(JSON.stringify(topics)).digest('hex');
  db.exec('COMMIT');
  writeFileSync(new URL('manifest.json',dir),JSON.stringify(metadata,null,2));
  console.log(JSON.stringify({ metadata }));
} finally { db.close(); }

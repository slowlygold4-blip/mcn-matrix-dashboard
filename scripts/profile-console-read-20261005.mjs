import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MonitorDatabase, normalizeBoardKey } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';

const mode = process.argv[2] || 'before';
if (!['before', 'after', 'live-before', 'live-after'].includes(mode)) throw new Error('Invalid profile mode');
const directory = new URL('../data/maintenance-journal/20261005-read-latency/', import.meta.url);
mkdirSync(directory, { recursive: true });
const filePath = new URL('../data/douyin-monitor.sqlite', import.meta.url).pathname;
const db = new DatabaseSync(filePath, { readOnly: true });
db.function('normalize_board_key', { deterministic: true }, normalizeBoardKey);
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
const adapter = mode.startsWith('live-') ? { db, listBoards() {
  const catalog = db.prepare("SELECT board_key,board_name,enabled,source_type,created_at,updated_at FROM board_catalog WHERE enabled=1 ORDER BY board_name COLLATE NOCASE").all();
  const count = db.prepare("SELECT COUNT(*) AS count FROM targets WHERE type='account' AND enabled=1 AND EXISTS (SELECT 1 FROM target_boards x WHERE x.target_id=targets.id AND x.board_key=?)");
  return catalog.map(row => ({ key: row.board_key, name: row.board_name, label: row.board_name,
    enabled: Boolean(row.enabled), sourceType: row.source_type, createdAt: row.created_at, updatedAt: row.updated_at,
    targetCount: Number(count.get(row.board_key)?.count) || 0, queuedCount: 0, pendingCount: 0, rejectedCount: 0 }));
} } : Object.assign(Object.create(MonitorDatabase.prototype), { db, filePath });
const options = { period: 'custom', timeZone: 'Asia/Shanghai', theme: 'tuantuan',
  startDate: '2026-10-01', endDate: '2026-10-05', reference: '2026-10-05T16:59:59.999Z' };
const started = performance.now();
try {
  const result = getProductInsights(adapter, options);
  db.exec('COMMIT');
  const elapsedMs = performance.now() - started;
  const bytes = JSON.stringify(result);
  const report = { mode, measuredAt: new Date().toISOString(), elapsedMs,
    enabled: result.summary.enabledCount, options,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes),
    metrics: result.summary.metrics };
  writeFileSync(new URL(`${mode}.json`, directory), JSON.stringify(report, null, 2));
  writeFileSync(new URL(`${mode}-result.json`, directory), bytes);
  console.log(JSON.stringify({mode,elapsedMs,enabled:report.enabled,sha256:report.sha256,bytes:report.bytes}));
} finally { db.close(); }

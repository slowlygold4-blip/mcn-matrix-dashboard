import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { getProductInsights } from '../lib/product-insights.mjs';
const root = new URL('../', import.meta.url), lib = new URL('lib/', root);
const before = new URL('data/backups/code/20261005-anchor-source-before/', root);
const absolute = (source, replacements = new Map()) => source.replace(/from (["'])(\.{1,2}\/[^"']+)\1/g,
  (_, quote, path) => `from ${quote}${replacements.get(path) ?? new URL(path, lib).href}${quote}`);
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const oldWorks = moduleUrl(absolute(readFileSync(new URL('works-observation.mjs', before), 'utf8')));
const oldProduct = await import(moduleUrl(absolute(readFileSync(new URL('product-insights.mjs', before), 'utf8'),
  new Map([['./works-observation.mjs', oldWorks]]))));
const db = new DatabaseSync(new URL('data/douyin-monitor.sqlite', root).pathname, { readOnly: true });
const adapter = { db, listBoards() {
  const catalog = db.prepare('SELECT board_key,board_name,enabled,source_type,created_at,updated_at FROM board_catalog WHERE enabled=1 ORDER BY board_name COLLATE NOCASE').all();
  const count = db.prepare("SELECT COUNT(*) AS count FROM targets WHERE type='account' AND enabled=1 AND EXISTS (SELECT 1 FROM target_boards x WHERE x.target_id=targets.id AND x.board_key=?)");
  return catalog.map(row => ({ key: row.board_key, name: row.board_name, label: row.board_name,
    enabled: Boolean(row.enabled), sourceType: row.source_type, createdAt: row.created_at, updatedAt: row.updated_at,
    targetCount: Number(count.get(row.board_key)?.count) || 0, queuedCount: 0, pendingCount: 0, rejectedCount: 0 }));
} };
const options = { period: 'custom', timeZone: 'Asia/Shanghai', theme: 'tuantuan',
  startDate: '2026-10-01', endDate: '2026-10-05', reference: '2026-10-05T16:59:59.999Z' };
const records = [], results = new Map();
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
try {
  const beforeChanges = db.prepare('SELECT total_changes() n').get().n;
  // Alternating order limits first-read/JIT bias; the product response cache
  // is bypassed. This measures data-read computation, not browser load time.
  for (const mode of ['before', 'after', 'after', 'before', 'before', 'after']) {
    const started = performance.now();
    const result = (mode === 'before' ? oldProduct.getProductInsights : getProductInsights)(adapter, options);
    const elapsedMs = performance.now() - started;
    const bytes = JSON.stringify(result), hash = createHash('sha256').update(bytes).digest('hex');
    if (results.size) assert.deepStrictEqual(result, results.values().next().value);
    results.set(mode, result);
    records.push({ mode, elapsedMs, bytes: Buffer.byteLength(bytes), hash });
    console.log(JSON.stringify(records.at(-1)));
  }
  assert.equal(db.prepare('SELECT total_changes() n').get().n, beforeChanges);
  const median = mode => records.filter(row => row.mode === mode).map(row => row.elapsedMs).sort((a, b) => a - b)[1];
  const report = { measuredAt: new Date().toISOString(), options, records, exactOutputsEqual: true,
    sourceWrites: 0, enabled: results.get('after').summary.enabledCount,
    medianBeforeMs: median('before'), medianAfterMs: median('after'),
    medianReductionPercent: (1 - median('after') / median('before')) * 100 };
  writeFileSync(new URL('data/maintenance-journal/20261005-read-latency/comparison.json', root), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ before: report.medianBeforeMs, after: report.medianAfterMs, reduction: report.medianReductionPercent }));
  db.exec('COMMIT');
} finally { db.close(); }

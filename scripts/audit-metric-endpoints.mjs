// Independent SQL tie-out against a read-only consistent snapshot. No network,
// collection, migrations, or reconstructed historical values.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';

const [databasePath, reportPath] = process.argv.slice(2);
if (!databasePath || !reportPath) throw new Error('Usage: node scripts/audit-metric-endpoints.mjs <snapshot.sqlite> <new-report.json>');
const db = new DatabaseSync(databasePath, { readOnly: true });
const reference = new Date();
const errors = [], checks = [];
const model = { db, listBoards: () => MonitorDatabase.prototype.listBoards.call({ db }) };
const equal = (actual, expected, label) => {
  if (actual !== expected) errors.push({ label, actual, expected });
};
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  const endDate = db.prepare("SELECT date(?,'+8 hours') AS date").get(reference.toISOString()).date;
  const trailingStart = (days) => db.prepare("SELECT date(?,'+8 hours',?) AS date").get(reference.toISOString(), `-${days - 1} days`).date;
  for (const options of [
    { period: 'day' }, { period: 'week' }, { period: 'month' },
    { period: 'custom', startDate: trailingStart(7), endDate },
    { period: 'custom', startDate: trailingStart(30), endDate },
    { period: 'custom', startDate: '2026-09-12', endDate },
    { period: 'custom', startDate: '2026-09-12', endDate, theme: 'tuantuan' },
  ]) {
    const insight = getProductInsights(model, { ...options, reference, timeZone: 'Asia/Shanghai' });
    const ids = insight.accounts.filter((account) => account.enabled).map((account) => account.id);
    const selectedIds = new Set(ids);
    const metricChecks = {};
    for (const [name, column] of Object.entries({ followers: 'followers', likes: 'total_likes', posts: 'total_posts' })) {
      // Select independently by calendar endpoint, not the implementation's
      // intermediate account.metrics or baseline-selection helper.
      const rows = db.prepare(`WITH valid AS (
        SELECT target_id,${column} AS value,id,julianday(captured_at) AS instant,
          date(captured_at,'+8 hours') AS day
        FROM snapshots WHERE quality_status IS NOT 'rejected'
          AND typeof(${column}) IN ('integer','real') AND ${column}>=0
          AND julianday(captured_at)<=julianday(?)
      ), latest AS (
        SELECT *,ROW_NUMBER() OVER(PARTITION BY target_id ORDER BY instant DESC,id DESC) n FROM valid
      ), previous AS (
        SELECT *,ROW_NUMBER() OVER(PARTITION BY target_id ORDER BY instant DESC,id DESC) n FROM valid
        WHERE day=date(?,'+8 hours','-1 day')
      ) SELECT l.target_id,l.value,
        CASE WHEN l.day=date(?,'+8 hours') AND p.value IS NOT NULL THEN l.value-p.value END AS delta,
        CASE WHEN l.day=date(?,'+8 hours') AND p.value IS NOT NULL THEN p.value END AS baseline
      FROM latest l LEFT JOIN previous p ON p.target_id=l.target_id AND p.n=1 WHERE l.n=1`)
        .all(insight.end, insight.start, insight.end, insight.end)
        .filter((row) => selectedIds.has(Number(row.target_id)));
      const byId = new Map(rows.map((row) => [Number(row.target_id), row]));
      const comparable = rows.filter((row) => row.delta !== null);
      const sum = (values) => values.length ? values.reduce((total, value) => total + value, 0) : null;
      const expectedDelta = sum(comparable.map((row) => row.delta));
      const expectedBaseline = sum(comparable.map((row) => row.baseline));
      const expectedKnown = sum(rows.map((row) => row.value));
      const metric = insight.summary.metrics[name];
      const prefix = `${options.theme || 'all'}/${options.period}/${name}`;
      equal(metric.delta, expectedDelta, `${prefix}/delta`);
      equal(metric.baseline, expectedBaseline, `${prefix}/baseline`);
      equal(metric.knownValue, expectedKnown, `${prefix}/knownValue`);
      equal(metric.comparableCount, comparable.length, `${prefix}/cohort-count`);
      equal(metric.percent, expectedDelta === null || expectedBaseline === 0 ? null : expectedDelta / expectedBaseline * 100, `${prefix}/percent`);
      for (const account of insight.accounts.filter((value) => value.enabled)) {
        const row = byId.get(account.id);
        equal(account.metrics[name].delta, row?.delta ?? null, `${prefix}/account-${account.id}`);
      }
      metricChecks[name] = { delta: metric.delta, comparableCount: comparable.length, enabledCount: ids.length,
        knownValue: metric.knownValue, deltaReliable: metric.deltaReliable };
    }
    const proxy = insight.summary.metrics.estimatedPlays;
    equal(proxy.delta, metricChecks.likes.delta === null ? null : metricChecks.likes.delta * 100, `${options.theme || 'all'}/${options.period}/estimate-delta`);
    equal(proxy.proxy, true, `${options.theme || 'all'}/${options.period}/estimate-label`);
    checks.push({ scope: options.theme || 'all', period: options.period, start: insight.start, end: insight.end, metricChecks });
  }
  db.exec('COMMIT');
  const report = { checkedAt: new Date().toISOString(), referenceAt: reference.toISOString(), databasePath,
    readOnly: true, noNetwork: true, method: 'independent-sql-calendar-endpoints-vs-product-report', checks, errors, passed: errors.length === 0 };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, comparisons: checks.length, errors, reportPath }));
  if (errors.length) process.exitCode = 1;
} finally { db.close(); }

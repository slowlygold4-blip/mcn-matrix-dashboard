// Independent SQL tie-out against a read-only consistent snapshot. No network,
// collection, migrations, or reconstructed historical values.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checksum, businessDateKey } from '../lib/utils.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';

const databasePath=new URL('../data/douyin-monitor.sqlite',import.meta.url).pathname;
const reportPath=new URL('../data/maintenance-journal/2026-10-02-phase92-data-mcn-endpoints.json',import.meta.url).pathname;
const sha=b=>createHash('sha256').update(b).digest('hex');
const proofBytes=readFileSync(new URL('../data/maintenance-journal/2026-10-02-phase92-data-audit.json',import.meta.url));
assert.equal(sha(proofBytes),'803ffce096b07632394dd350ab800b8aaa901f053953c81ee51a63e58f480211');
const proof=JSON.parse(proofBytes),endpointProofs=[];
const db = new DatabaseSync(databasePath, { readOnly: true });
const reference = new Date('2026-10-02T01:21:47.929Z');
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
    { period: 'custom', startDate: '2026-09-12', endDate, theme: 'tuantuan', classification: 'slice' },
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
    
    const top=insight.accounts.filter(a=>a.enabled&&a.metrics.likes.delta!==null).sort((a,b)=>Math.abs(b.metrics.likes.delta)-Math.abs(a.metrics.likes.delta)).slice(0,5);
    const topContributions=[];
    for(const a of top){
      const endpointRows=[];
      for(const moment of [a.metrics.likes.baselineAt,a.metrics.likes.currentAt]){
        const row=db.prepare('SELECT * FROM snapshots WHERE target_id=? AND julianday(captured_at)=julianday(?) ORDER BY id DESC LIMIT 1').get(a.id,moment);
        assert.ok(row, 'actual endpoint source missing for target '+a.id+' at '+moment); assert.equal(Date.parse(row.captured_at),Date.parse(moment)); const raw=JSON.parse(row.raw_json),target=db.prepare('SELECT * FROM targets WHERE id=?').get(a.id);
        const normalized=normalizeCollection(target,raw,{capturedAt:row.captured_at});
        assert.equal(checksum(raw),row.source_checksum);assert.equal(normalized.snapshot.totalLikes,row.total_likes);
        endpointRows.push({id:row.id,date:businessDateKey(row.captured_at),capturedAt:row.captured_at,likes:row.total_likes,posts:row.total_posts,
          sourceChecksum:row.source_checksum,rawBytesSha256:sha(row.raw_json),originalNormalizedLikesEqual:true});
      }
      assert.equal(endpointRows[1].likes-endpointRows[0].likes,a.metrics.likes.delta);
      topContributions.push({targetId:a.id,likesDelta:a.metrics.likes.delta,estimatedPlaysDelta:a.metrics.estimatedPlays.delta,
        postsInventoryDelta:a.metrics.posts.delta,publishedSamples:a.publishedSamples,endpoints:endpointRows});
    }
    checks.push({ scope: options.theme || 'all',classification:options.classification??'all',period: options.period,
      start: insight.start, end: insight.end,metricChecks,estimatedPlays:proxy,publishedSamples:insight.summary.publishedSamples,
      recordedWindow:insight.recordedWindow?{baselineDate:insight.recordedWindow.baselineDate,endDate:insight.recordedWindow.endDate,
        enabledCount:insight.recordedWindow.enabledCount,comparableCount:insight.recordedWindow.comparableCount,
        metrics:insight.recordedWindow.metrics,reason:insight.recordedWindow.reason}:null,
      topContributions,accountsWithMissingLikesEndpoints:insight.accounts.filter(a=>a.enabled&&a.metrics.likes.delta===null).map(a=>({targetId:a.id,reason:a.metrics.likes.reason,delta:a.metrics.likes.delta})),
      positive:insight.accounts.filter(a=>a.enabled&&a.metrics.likes.delta>0).length,
      negative:insight.accounts.filter(a=>a.enabled&&a.metrics.likes.delta<0).length,
      explicitZero:insight.accounts.filter(a=>a.enabled&&a.metrics.likes.delta===0).length});

  }
  const independentReadback={auditedRunIds:proof.runIds,receiptSha256:sha(proofBytes),sourceAndEventChecks:[]};
  for(const p of proof.proofs){
    const row=db.prepare('SELECT raw_json,source_checksum FROM works_observations WHERE run_id=?').get(p.runId),raw=JSON.parse(row.raw_json);
    assert.equal(sha(row.raw_json),p.sourceSha256);assert.equal(checksum(raw),p.sourceSha256);assert.equal(row.source_checksum,p.sourceSha256);
    assert.equal(sha(readFileSync(new URL('../data/ingestion-reviews/run-'+p.runId+'.json',import.meta.url))),p.originalEventSha256);
    for(const v of p.sourceVectors){
      const metric=db.prepare('SELECT * FROM post_metrics WHERE id=?').get(v.metricId),post=db.prepare('SELECT id,first_seen_at FROM posts WHERE id=?').get(v.postId);
      assert.equal(metric.post_id,v.postId);assert.equal(metric.captured_at,v.observedAt);assert.equal(post.first_seen_at,v.firstSeenAt);
      assert.equal(checksum(Object.fromEntries(['likes','comments','shares','collects','plays'].map(k=>[k,metric[k]??null]))),v.metricVectorSha256);
    }
    independentReadback.sourceAndEventChecks.push({runId:p.runId,sourceSha256:p.sourceSha256,eventSha256:p.originalEventSha256,verifiedMetricRows:p.sourceVectors.length});
  }
  for(const p of proof.oldOriginalEventPreservation.files)assert.equal(sha(readFileSync(new URL('../data/ingestion-reviews/'+p.file,import.meta.url))),p.sha256);
  assert.equal(sha(readFileSync(new URL('../data/source-poll/manifest.json',import.meta.url))),proof.source.sha256);
  independentReadback.oldEventCount=proof.oldOriginalEventPreservation.fileCount;independentReadback.sourceManifestSha256=proof.source.sha256;
  independentReadback.queryOnly=db.prepare('PRAGMA query_only').get().query_only;independentReadback.totalChanges=db.prepare('SELECT total_changes() n').get().n;
  assert.equal(independentReadback.queryOnly,1);assert.equal(independentReadback.totalChanges,0);db.exec('ROLLBACK');
  const report = { checkedAt: new Date().toISOString(), referenceAt: reference.toISOString(), databasePath,
    readOnly: true, noNetwork: true, method: 'independent-sql-calendar-endpoints-vs-product-report', independentReadback, scriptSha256:sha(readFileSync(new URL('./phase92-data-mcn-endpoints.mjs',import.meta.url))),
    noPlatformActualPlayClaim:true,noInventoryAsPublicationClaim:true,noMissingDatesFilled:true, checks, errors, passed: errors.length === 0 };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, comparisons: checks.length, errors, reportPath,sha256:sha(readFileSync(reportPath)),summaries:checks.map(c=>({scope:c.scope,classification:c.classification,period:c.period,start:c.start,end:c.end,metrics:c.metricChecks,publishedSamples:c.publishedSamples,top:c.topContributions.map(t=>({targetId:t.targetId,likes:t.likesDelta,estimated:t.estimatedPlaysDelta,inventory:t.postsInventoryDelta,samples:t.publishedSamples.value})),recordedWindow:c.recordedWindow?{baselineDate:c.recordedWindow.baselineDate,endDate:c.recordedWindow.endDate,comparableCount:c.recordedWindow.comparableCount}:null,positive:c.positive,negative:c.negative,zero:c.explicitZero}))}));
  if (errors.length) process.exitCode = 1;
} finally { db.close(); }

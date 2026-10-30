// Operational counters from local storage; no platform network or model calls.
import {readWorkLikeComparability} from './work-like-comparability.mjs';
const PLATFORMS = ['douyin', 'bilibili', 'xiaohongshu', 'kuaishou', 'unknown'];
export const collectionPlatform = value => PLATFORMS.includes(value) ? value : 'unknown';
function platformSql(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(targets)').all().map(row => row.name));
  const declared = columns.has('metadata_json') ? "CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.platform') END" : 'NULL';
  // An exact canonical Douyin sec_uid is a platform locator, unlike a nickname.
  // Do not override an explicitly different/invalid platform declaration.
  const legacy = columns.has('locator') ? "substr(locator,1,6)='MS4wLj' AND length(locator) BETWEEN 18 AND 226 AND locator NOT GLOB '*[^A-Za-z0-9_-]*'" : '0';
  return `CASE WHEN (${declared}) IN ('douyin','bilibili','xiaohongshu','kuaishou') THEN (${declared})
    WHEN (${declared}) IS NULL AND (${legacy}) THEN 'douyin' ELSE 'unknown' END`;
}
export function enabledCollectionTargets(db) {
  return db.prepare(`SELECT id,type,${platformSql(db)} platform FROM targets WHERE enabled=1`).all();
}

/** Legacy batch flags are hints, not counter evidence. Read accepted snapshots
 * bound to an audit and its real run clocks; never rewrite historical flags.
 * The last whole-batch view retains paused targets that belonged to that run,
 * while rolling coverage counts only currently enabled targets. */
export function committedProfileProgress(db,{runIds,since,now,latestRunId}) {
  const rolling=new Set(),latest=new Set();
  const required={audits:['run_id','target_id','source_checksum','status','created_at'],
    snapshots:['target_id','source_checksum','quality_status','captured_at','account_status','followers','total_likes','total_posts']};
  for(const [table,names]of Object.entries(required)){
    const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));
    if(names.some(name=>!columns.has(name)))return {rolling,latest};
  }
  const ids=[...new Set([...runIds,latestRunId].filter(id=>Number.isSafeInteger(id)&&id>0))];
  if(!ids.length)return {rolling,latest};
  const rows=db.prepare(`SELECT DISTINCT a.run_id runId,s.target_id targetId,t.enabled,
    (julianday(s.captured_at)>=julianday(?)) recent
    FROM audits a JOIN runs r ON r.id=a.run_id JOIN targets t ON t.id=a.target_id
    JOIN snapshots s ON s.target_id=a.target_id AND s.source_checksum=a.source_checksum
    WHERE a.run_id IN(SELECT value FROM json_each(?)) AND t.type='account'
      AND a.source_checksum IS NOT NULL AND a.source_checksum<>''
      AND a.status IN('validated','warning') AND s.quality_status IN('validated','warning')
      AND s.account_status IN('available','partial')
      AND julianday(r.started_at)<=julianday(?)
      AND (r.finished_at IS NULL OR julianday(r.finished_at) BETWEEN julianday(r.started_at) AND julianday(?))
      AND julianday(s.captured_at)>=julianday(r.started_at)
      AND julianday(s.captured_at)<=julianday(a.created_at)
      AND julianday(a.created_at)<=julianday(COALESCE(r.finished_at,?))
      AND typeof(s.followers)='integer' AND s.followers BETWEEN 0 AND 9007199254740991
      AND typeof(s.total_likes)='integer' AND s.total_likes BETWEEN 0 AND 9007199254740991
      AND typeof(s.total_posts)='integer' AND s.total_posts BETWEEN 0 AND 9007199254740991`)
    .iterate(since,JSON.stringify(ids),now,now,now);
  for(const row of rows){if(row.enabled&&row.recent)rolling.add(row.targetId);if(row.runId===latestRunId)latest.add(row.targetId);}
  return {rolling,latest};
}
export function platformRollingProgress(enabled, { profiles, works, failures }) {
  const rows = new Map();
  for (const target of enabled) {
    if (target.type !== 'account') continue;
    const platform = collectionPlatform(target.platform);
    const row = rows.get(platform) ?? { platform, accounts: 0, profiles: 0, worksComplete: 0, worksLimited: 0, workIssues: 0 };
    row.accounts++;
    row.profiles += profiles.has(target.id) ? 1 : 0;
    row.worksComplete += works.get(target.id) === 'complete' ? 1 : 0;
    row.worksLimited += ['limited', 'latest-public-window'].includes(works.get(target.id)) ? 1 : 0;
    row.workIssues += failures.has(target.id) ? 1 : 0;
    rows.set(platform, row);
  }
  return PLATFORMS.flatMap(platform => rows.has(platform) ? [rows.get(platform)] : []);
}

/** Counts distinct saved works with a known like observation today, not all
 * platform works, successful API requests, or an independent source verifier.
 * Absent legacy tables/schema mean unavailable, never fabricated zero. */
export function dailyStoredWorkLikes(db, enabled, now) {
  const required = { posts: ['id', 'target_id', 'external_id', 'first_seen_at'],
    post_metrics: ['post_id', 'captured_at', 'likes'] };
  for (const [table, columns] of Object.entries(required)) {
    const stored = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (columns.some(name => !stored.has(name))) return null;
  }
  const end = Date.parse(now);
  if (!Number.isFinite(end)) throw Error('invalid telemetry clock');
  const date = new Date(end + 8 * 3600000).toISOString().slice(0, 10);
  const since = new Date(Date.parse(date + 'T00:00:00.000Z') - 8 * 3600000).toISOString();
  const targets = new Map(enabled.filter(t => t.type === 'account').map(t => [t.id, collectionPlatform(t.platform)]));
  const rows = new Map([...new Set(targets.values())].map(platform => [platform,
    { platform, storedWorks: 0, observedWorks: 0, observedAccounts: 0 }]));
  const observations = db.prepare(`WITH platform_targets AS MATERIALIZED (
      SELECT id,${platformSql(db)} platform FROM targets WHERE type='account' AND enabled=1
    ), known_today AS MATERIALIZED (
      SELECT DISTINCT m.post_id FROM post_metrics m WHERE m.captured_at>=?
        AND julianday(m.captured_at)>=julianday(?) AND julianday(m.captured_at)<=julianday(?)
        AND typeof(m.likes)='integer' AND m.likes>=0 AND m.likes<=9007199254740991
    ) SELECT t.platform,COUNT(DISTINCT p.external_id) storedWorks,
      COUNT(DISTINCT CASE WHEN k.post_id IS NOT NULL THEN p.external_id END) observedWorks,
      COUNT(DISTINCT CASE WHEN k.post_id IS NOT NULL THEN p.target_id END) observedAccounts
    FROM platform_targets t LEFT JOIN posts p ON p.target_id=t.id AND p.external_id<>''
      AND julianday(p.first_seen_at)<=julianday(?)
    LEFT JOIN known_today k ON k.post_id=p.id GROUP BY t.platform`).all(since.slice(0, 10), since, now, now);
  for (const item of observations) {
    if (rows.has(item.platform)) rows.set(item.platform, { ...item });
  }
  return { date, since, asOf: now, basis: 'stored-work-like-observations',
    platforms: PLATFORMS.flatMap(platform => rows.has(platform) ? [rows.get(platform)] : []),
    comparability:readWorkLikeComparability(db,enabled,now) };
}

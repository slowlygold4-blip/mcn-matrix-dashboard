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

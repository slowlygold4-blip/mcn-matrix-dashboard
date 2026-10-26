/** Read-only audit of an interrupted, normalized Douyin works probe.
 * Never inserts snapshots/post_metrics: the archive omits each work's raw
 * author.sec_uid, so even an exact DB overlap is evidence, not a new platform
 * metric observation. Usage: node scripts/audit-shadow-works-source.mjs
 *   --input data/shadow-works-all-20261022/accounts.jsonl
 *   --database data/douyin-monitor.sqlite --output /private/path/audit.json
 */
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const validVideoId = n => typeof n === 'string' && /^\d{15,25}$/.test(n);
const validSecUid = n => typeof n === 'string' && /^MS4wLjAB[A-Za-z0-9_-]{16,}$/.test(n);
const isoMs = value => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const count = (map, key, amount = 1) => { map[key] = (map[key] || 0) + amount; };
const example = (map, key, value, limit = 5) => {
  if (!map[key]) map[key] = [];
  if (map[key].length < limit) map[key].push(value);
};
const batches = (array, size) => Array.from({ length: Math.ceil(array.length / size) }, (_, index) => array.slice(index * size, (index + 1) * size));

function dbRowsByIds(db, table, columns, field, ids) {
  const result = [];
  for (const chunk of batches([...new Set(ids)], 250)) {
    if (!chunk.length) continue;
    result.push(...db.prepare(`SELECT ${columns} FROM ${table} WHERE ${field} IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  return result;
}

/** Returns aggregate evidence only: no captions, account locators or cookies. */
export function auditShadowWorksSource({ jsonl, db, inputSha256, inputBytes, collectorSha256 = null,
  summaryPresent = false, auditedAt = new Date().toISOString() }) {
  const lines = jsonl.split(/\r?\n/).filter(line => line.trim());
  const records = [], errors = [], counts = {}, examples = {}, workRows = [], unmatchedWorks = [];
  for (const [index, line] of lines.entries()) {
    let record;
    try { record = JSON.parse(line); } catch { errors.push({ line: index + 1, code: 'invalid_json' }); continue; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push({ line: index + 1, code: 'invalid_record' }); continue;
    }
    records.push({ ...record, line: index + 1 });
  }
  const targetIds = records.map(r => r.targetId).filter(n => Number.isSafeInteger(n) && n > 0);
  const targets = new Map(dbRowsByIds(db, 'targets', 'id,type,provider,locator,created_at,updated_at', 'id', targetIds)
    .map(row => [row.id, row]));
  const repeatedTargets = new Map();
  for (const record of records) count(repeatedTargets, String(record.targetId));
  const duplicateTargets = new Set(Object.entries(repeatedTargets).filter(([, n]) => n > 1).map(([id]) => id));
  const now = isoMs(auditedAt);
  const perTargetVideo = new Set(), allVideos = new Map();
  for (const record of records) {
    const sample = { targetId: record.targetId, line: record.line };
    count(counts, `status_${record.status || 'missing'}`);
    const target = targets.get(record.targetId);
    const start = isoMs(record.observedAt), finish = isoMs(record.finishedAt);
    const timestampsValid = start !== null && finish !== null && finish >= start && finish - start <= 5 * 60_000
      && (now === null || finish <= now + 5 * 60_000);
    if (!timestampsValid) { count(counts, 'invalid_record_time'); example(examples, 'invalidRecordTime', sample); }
    if (!target) { count(counts, 'target_missing'); example(examples, 'missingTarget', sample); }
    else if (target.type !== 'account' || target.provider !== 'public-web' || !validSecUid(target.locator)) {
      count(counts, 'target_identity_invalid'); example(examples, 'invalidTarget', sample);
    } else if (start !== null && isoMs(target.created_at) !== null && isoMs(target.created_at) > start) {
      count(counts, 'target_created_after_sample'); example(examples, 'targetCreatedAfterSample', sample);
    } else count(counts, 'target_identity_shape_valid');
    if (target && finish !== null && isoMs(target.updated_at) !== null && isoMs(target.updated_at) > finish)
      count(counts, 'target_updated_after_sample');
    if (duplicateTargets.has(String(record.targetId))) count(counts, 'duplicate_target_record');
    if (record.profile !== null && record.profile !== undefined) count(counts, 'profile_present');
    const works = Array.isArray(record.works) ? record.works : [];
    if (!Array.isArray(record.works)) { count(counts, 'works_array_missing'); example(examples, 'missingWorksArray', sample); }
    if (record.status === 'sampled' && works.length === 0) count(counts, 'sampled_without_works');
    if (record.status !== 'sampled' && works.length) count(counts, 'works_without_sampled_status');
    for (const work of works) {
      count(counts, 'work_rows');
      const id = work?.contentId, mark = { ...sample, contentId: typeof id === 'string' ? id : null };
      const validId = validVideoId(id);
      if (!validId) { count(counts, 'invalid_video_id'); example(examples, 'invalidVideoId', mark); }
      const key = `${record.targetId}|${id}`;
      if (perTargetVideo.has(key)) { count(counts, 'duplicate_target_video'); example(examples, 'duplicateTargetVideo', mark); }
      perTargetVideo.add(key);
      if (validId) {
        if (!allVideos.has(id)) allVideos.set(id, new Set());
        allVideos.get(id).add(record.targetId);
      }
      const publish = validCount(work?.publishEpoch) ? work.publishEpoch * 1000 : null;
      const publishValid = publish !== null && Number.isSafeInteger(publish) && publish >= Date.UTC(2010, 0, 1)
        && timestampsValid && publish <= finish + 5 * 60_000;
      if (!publishValid) { count(counts, 'invalid_publish_time'); example(examples, 'invalidPublishTime', mark); }
      const countersValid = ['likes', 'comments', 'shares', 'collects'].every(field => work?.[field] === null || validCount(work?.[field]));
      if (!countersValid) { count(counts, 'invalid_counters'); example(examples, 'invalidCounters', mark); }
      if (work?.plays === null && work?.playsSource === 'unavailable') count(counts, 'plays_explicitly_unavailable');
      else { count(counts, 'plays_semantics_conflict'); example(examples, 'playsSemanticsConflict', mark); }
      if (work?.sourcePlayValue === 0) count(counts, 'raw_play_placeholder_zero');
      else if (validCount(work?.sourcePlayValue)) count(counts, 'raw_play_nonzero_unverified');
      else count(counts, 'raw_play_missing');
      workRows.push({ targetId: record.targetId, line: record.line, id,
        validId, timestampsValid, publishValid, countersValid, finish, target });
    }
  }
  const crossTargetIds = new Set([...allVideos].filter(([, ids]) => ids.size > 1).map(([id]) => id));
  for (const row of workRows) if (crossTargetIds.has(row.id)) {
    count(counts, 'work_rows_cross_target_duplicate');
    example(examples, 'crossTargetDuplicate', { targetId: row.targetId, contentId: row.id });
  }
  const indexed = new Map();
  const validIds = [...allVideos.keys()];
  for (const row of dbRowsByIds(db, 'posts', 'id,target_id,external_id,author_id,raw_json,first_seen_at', 'external_id', validIds)) {
    if (!indexed.has(row.external_id)) indexed.set(row.external_id, []);
    indexed.get(row.external_id).push(row);
  }
  for (const row of workRows) {
    if (!row.validId) continue;
    const found = indexed.get(row.id) || [], same = found.find(post => post.target_id === row.targetId);
    const mark = { targetId: row.targetId, contentId: row.id };
    if (!same) {
      const key = found.length ? 'other_target_only' : 'not_in_posts';
      count(counts, key); example(examples, key, mark);
      if (key === 'not_in_posts' && unmatchedWorks.length < 500) unmatchedWorks.push(mark);
      continue;
    }
    let raw;
    try { raw = JSON.parse(same.raw_json); } catch { raw = null; }
    const exact = row.target && validSecUid(row.target.locator) && same.author_id === row.target.locator
      && raw?.aweme_id === row.id && raw?.author?.sec_uid === row.target.locator;
    if (!exact) { count(counts, 'same_target_identity_conflict'); example(examples, 'sameTargetIdentityConflict', mark); continue; }
    count(counts, 'exact_post_author_overlap');
    if (isoMs(same.first_seen_at) !== null && same.first_seen_at && isoMs(same.first_seen_at) <= row.finish)
      count(counts, 'post_first_seen_by_shadow_finish');
    else count(counts, 'post_first_seen_after_shadow_finish');
    if (row.timestampsValid && row.publishValid && row.countersValid && !duplicateTargets.has(String(row.targetId))
      && !crossTargetIds.has(row.id)) count(counts, 'eligible_external_evidence_stage_only');
    else { count(counts, 'exact_overlap_with_integrity_issue'); example(examples, 'exactOverlapIntegrityIssue', mark); }
  }
  const rows = workRows.length;
  const starts = records.map(record => isoMs(record.observedAt)).filter(value => value !== null);
  const finishes = records.map(record => isoMs(record.finishedAt)).filter(value => value !== null);
  return {
    format: 'mcn-shadow-works-audit-v1', auditedAt, source: { records: lines.length, parsedRecords: records.length,
      sha256: inputSha256, bytes: inputBytes, collectorSha256, summaryPresent,
      firstObservedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      lastFinishedAt: finishes.length ? new Date(Math.max(...finishes)).toISOString() : null,
      scope: 'interrupted checkpoint; at most 30 collected works per attempted account; not the full intended target set' },
    account: { uniqueTargetIds: new Set(targetIds).size, duplicateTargetIds: [...duplicateTargets].length,
      sampled: counts.status_sampled || 0, profileOnly: counts.status_profile_only || 0,
      unavailable: counts.status_unavailable || 0, profilePresent: counts.profile_present || 0 },
    works: { rows, uniqueVideoIds: allVideos.size, uniqueTargetVideoPairs: perTargetVideo.size,
      crossTargetVideoIds: crossTargetIds.size, counts: Object.fromEntries(Object.entries(counts)
        .filter(([key]) => !key.startsWith('status_')).sort(([a], [b]) => a.localeCompare(b))) },
    errors, examples,
    fusionPolicy: {
      exactPostAuthorOverlap: counts.exact_post_author_overlap || 0,
      eligibleExternalEvidenceStageOnly: counts.eligible_external_evidence_stage_only || 0,
      identityUnconfirmedNewWorks: counts.not_in_posts || 0,
      identityUnconfirmedNewWorkCandidates: unmatchedWorks,
      identityUnconfirmedNewWorkCandidatesTruncated: (counts.not_in_posts || 0) > unmatchedWorks.length,
      forbiddenDirectPostMetricsRows: rows,
      note: '归档未保留逐作品原始 author.sec_uid、响应来源与完整分页证明。严格重合可作为带来源和真实采样区间的辅助证据候选；不能直接写 post_metrics、当作全量作品，或把 play_count=0 当实播。未入 posts 的作品需原始响应/重新采样验证身份。',
      targetUpdatedAfterSampleNote: 'targets.updated_at 可能只是后续采集/状态更新，并非身份变更证据；本审查仅把它计数，不用它单独证明或否定身份。',
    },
  };
}

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!['--input', '--database', '--output'].includes(name) || !value) throw Error('用法：--input FILE --database SQLITE [--output JSON]');
    if (Object.hasOwn(result, name)) throw Error(`重复参数 ${name}`);
    result[name] = value;
  }
  if (!result['--input'] || !result['--database']) throw Error('必须提供 --input 和 --database');
  return result;
}

export async function auditShadowFiles({ inputPath, databasePath, outputPath }) {
  const [input, sourceStat] = await Promise.all([readFile(inputPath), stat(inputPath)]);
  const codePath = join(dirname(fileURLToPath(import.meta.url)), 'probes/shadow_douyin_works_once.py');
  const collectorSha256 = existsSync(codePath) ? sha(await readFile(codePath)) : null;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const report = auditShadowWorksSource({ jsonl: input.toString('utf8'), db,
      inputSha256: sha(input), inputBytes: sourceStat.size, collectorSha256,
      summaryPresent: existsSync(join(dirname(inputPath), 'summary.json')) });
    if (outputPath) {
      if (resolve(outputPath) === resolve(inputPath) || resolve(outputPath) === resolve(databasePath))
        throw Error('审查报告不可覆盖来源或数据库');
      await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    return report;
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = args(process.argv.slice(2));
    const result = await auditShadowFiles({ inputPath: resolve(options['--input']), databasePath: resolve(options['--database']),
      outputPath: options['--output'] ? resolve(options['--output']) : null });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

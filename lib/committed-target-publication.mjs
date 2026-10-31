import { checksum, safeJson } from './utils.mjs';
import { canonicalAccountLocator } from './author-spreadsheet.mjs';
import { normalizeCollection } from './providers/normalize.mjs';
import { OFFICIAL_DOUYIN_PROFILE_ENDPOINT, isOfficialScheduledProfileEnvelope } from './official-profile-evidence.mjs';
import { preparePublicReplicaPublication } from './public-replica-sync.mjs';
import { COMMITTED_TOPIC_EVIDENCE, readCommittedTopicProofs } from './committed-topic-publication.mjs';

export const COMMITTED_TARGET_PUBLICATION = 'committed-target-atomic-audit-v1';
const receipts = new WeakMap();
const baselines = new WeakMap();
const accepted = value => ['validated', 'warning'].includes(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const failure = () => { throw new TypeError('invalid-committed-target-publication'); };
const LEGACY_WORK_REVISIONS = new Set(['catalog-date-range-v1', 'catalog-date-range-v2-roster-classification']);
const CURRENT_WORK_REVISIONS = new Set([
  'catalog-date-range-v3-work-publication-date',
  'catalog-date-range-v3-unified-source-works',
  'catalog-date-range-v4-continuous-publishing',
  'catalog-date-range-v5-live-author-links',
  'catalog-date-range-v6-account-clock-precision',
  'catalog-date-range-v7-live-creator-corpus',
  'catalog-date-range-v8-live-table-foundation',
  'catalog-date-range-v9-work-topic-evidence',
  'catalog-date-range-v10-work-observation-adoption',
  'catalog-date-range-v11-source-time-provenance','catalog-date-range-v12-unified-work-metrics','catalog-date-range-v13-publication-scope',
  'catalog-date-range-v14-independent-work-publishers',
  'catalog-date-range-v15-source-field-order',
  'catalog-date-range-v16-source-work-classification',
  'catalog-date-range-v17-publication-date-basis',
  'catalog-date-range-v18-registration-work-facts',
  'catalog-date-range-v19-original-row-projection',
]);

// Python's original collector wrote UTC observation seconds without `.000`.
// These are real ISO instants, not absent timestamps. Keep source bytes and
// checksum bindings unchanged and compare validated instants numerically.
// Publication cutoffs/manifests still require the canonical `iso` contract.
function observationTime(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const time=Date.parse(value);
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,19)===value.slice(0,19)?time:NaN;
}

function runningProfile(row, target, asOf) {
  try {
    if ((safeJson(target.metadata_json, {})?.platform ?? 'douyin') !== 'douyin'
      || !['available', 'partial'].includes(row.account_status)) return false;
    const raw = JSON.parse(row.raw_json), profile = raw.profile?.user, p = raw.provenance;
    const expected = canonicalAccountLocator(target.locator, 'douyin');
    if (!expected || ['user','user_info','creator','source','roster','snapshot'].some(key => Object.hasOwn(raw,key))
      || !raw.profile || Object.keys(raw.profile).length !== 1
      || canonicalAccountLocator(profile?.sec_uid, 'douyin') !== expected
      || typeof profile?.uid !== 'string' || !/^[1-9]\d{1,24}$/.test(profile.uid)
      || checksum(raw) !== row.source_checksum || raw.capturedAt !== row.captured_at
      || raw.accountStatus !== 'validated' || raw.accountError !== null
      || ![['followers','follower_count'],['total_likes','total_favorited'],['total_posts','aweme_count']]
        .every(([stored,source])=>row[stored]===(profile[source]??null))
      || profile.user_deleted === true || (raw.status_code !== undefined && raw.status_code !== 0)
      || [raw.need_login, raw.login_required, raw.captcha_required, raw.verify_required].some(Boolean)
      || !['guest-ttwid-unsigned-profile', 'guest-ttwid-unsigned-profile-with-x-bogus-fallback'].includes(p?.profileMode)
      || (p.mode !== p.profileMode && !isOfficialScheduledProfileEnvelope(raw))
      || p.profileEndpoint !== OFFICIAL_DOUYIN_PROFILE_ENDPOINT
      || p.accountLocator !== 'sec_uid' || p.cookiePersisted !== false || p.runtimeAI !== false || p.paidAPI !== false) return false;
    if (raw.profileResponse !== undefined) {
      const response = raw.profileResponse, profiles = [response?.user, response?.user_info].filter(x => x && typeof x === 'object');
      if (response?.status_code !== 0 || profiles.length !== 1
        || profiles[0].sec_uid !== profile.sec_uid || profiles[0].uid !== profile.uid
        || [response.need_login, response.login_required, response.captcha_required, response.verify_required, profiles[0].user_deleted].some(Boolean)) return false;
      if (![['followers','follower_count'],['total_likes','total_favorited'],['total_posts','aweme_count']]
        .every(([stored,source])=>row[stored]===(profiles[0][source]??null))) return false;
      const responseSnapshot = normalizeCollection(target, { profile: { user: profiles[0] } }, { capturedAt: row.captured_at }).snapshot;
      if (![['followers','followers'],['total_likes','totalLikes'],['total_posts','totalPosts']]
        .every(([stored,value])=>row[stored]===(responseSnapshot[value]??null))) return false;
    }
    const normalized = normalizeCollection(target, raw, { capturedAt: row.captured_at });
    return [['followers','followers'], ['total_likes','totalLikes'], ['total_posts','totalPosts']]
      .every(([stored, value]) => (row[stored] === null || count(row[stored]))
        && row[stored] === (normalized.snapshot[value] ?? null))
      && Date.parse(row.captured_at) <= Date.parse(asOf);
  } catch { return false; }
}

/** Explicit opt-in receipt, bound to an already-open caller read transaction.
 * No run is marked completed/reviewed. Only a paired, committed snapshot plus
 * same-source audit is eligible; lifecycle-only warning audits cannot enter.
 * Running works completeness is deliberately NOT authorized here. */
export async function preparePublishedSnapshotBaseline(serialized, { asOf, manifestSha256, exportRevision } = {}) {
  if (!iso(asOf) || !/^[a-f0-9]{64}$/.test(manifestSha256 ?? '')) failure();
  // The private publisher state records which schema sealed the preceding
  // generation. Do not reinterpret its immutable v1/v2 work bytes as v3, and
  // never let this compatibility mode relax validation of a new generation.
  if (exportRevision !== undefined && !CURRENT_WORK_REVISIONS.has(exportRevision)
    && !LEGACY_WORK_REVISIONS.has(exportRevision)) failure();
  const workSchemaVersion = LEGACY_WORK_REVISIONS.has(exportRevision) ? 'v2' : 'v3';
  const publication = await preparePublicReplicaPublication(serialized, { dateIndex: true, workSchemaVersion });
  if (publication.manifest.asOf !== asOf || checksum(publication.manifest) !== manifestSha256) failure();
  const catalog = JSON.parse(publication.files.find(file=>file.path==='catalog.json').content);
  const baseline = Object.freeze({ asOf, manifestSha256 });
  const sources = new Map();
  for(const file of publication.files.filter(file=>file.kind==='daily')){
    const acceptedSources=new Set();
    for(const row of JSON.parse(file.content).items){
      for(const [at,hash] of [[row.capturedAt,row.sourceChecksum],
        ...['followers','likes','posts'].map(name=>[row[name+'At'],row[name+'Checksum']])]){
        if(iso(at)&&/^[a-f0-9]{64}$/.test(hash??''))acceptedSources.add(Date.parse(at)+'@'+hash);
      }
    }
    sources.set(file.targetId,acceptedSources);
  }
  baselines.set(baseline, { caps:new Map(catalog.accounts.map(account=>[account.id,account.historyRevision.snapshotMaxId])),sources });
  return baseline;
}

export function readCommittedTargetPublication(database, { asOf, baseline } = {}) {
  const db = database?.db ?? database;
  if (!db?.isTransaction || !iso(asOf) || Date.parse(asOf) > Date.now()) failure();
  if (baseline !== undefined && (!baselines.has(baseline) || baseline.asOf > asOf)) failure();
  const targets = new Map(db.prepare("SELECT id,type,provider,locator,metadata_json FROM targets WHERE type='account' AND provider='public-web'").all().map(t => [t.id, t]));
  const rows = db.prepare(`SELECT s.id,s.target_id,s.captured_at,s.source_checksum,s.quality_status,s.account_status,
      s.followers,s.total_likes,s.total_posts,CASE WHEN r.status='running' THEN s.raw_json ELSE NULL END raw_json,
      a.id audit_id,a.target_id audit_target_id,a.provider audit_provider,a.status audit_status,a.created_at audit_at,
      a.source_checksum audit_checksum,a.run_id,r.target_id run_target_id,r.trigger_type,r.status run_status,r.started_at,r.finished_at
    FROM snapshots s JOIN targets t ON t.id=s.target_id
    JOIN audits a ON a.target_id=s.target_id AND a.source_checksum=s.source_checksum
    JOIN runs r ON r.id=a.run_id WHERE t.type='account' AND t.provider='public-web'
      AND s.quality_status IN ('validated','warning') AND a.status IN ('validated','warning')
      AND a.provider='public-web' AND julianday(s.captured_at)<=julianday(?)
      AND julianday(a.created_at)<=julianday(?)
    ORDER BY s.id,a.id`).all(asOf, asOf);
  const allowed = new Map(), running = [];
  for (const row of rows) {
    const target = targets.get(row.target_id);
    const [started,captured,audited]=[row.started_at,row.captured_at,row.audit_at].map(observationTime);
    const cutoff=Date.parse(asOf),finished=observationTime(row.finished_at);
    if (!target || !positive(row.id) || !positive(row.audit_id) || !positive(row.run_id)
      || row.audit_target_id !== target.id || row.audit_checksum !== row.source_checksum
      || !/^[a-f0-9]{64}$/.test(row.source_checksum ?? '') || !accepted(row.quality_status)
      || row.audit_status !== row.quality_status
      || (row.run_target_id !== null && row.run_target_id !== target.id)
      || ![started,captured,audited].every(Number.isFinite)
      || !(started <= captured && captured <= audited && audited <= cutoff)) continue;
    const terminal = ['success','partial'].includes(row.run_status) && Number.isFinite(finished)
      && audited <= finished && finished <= cutoff;
    const inProgress = row.run_status === 'running' && row.finished_at === null && row.trigger_type === 'scheduled'
      && runningProfile(row, target, asOf);
    if (!terminal && !inProgress) continue;
    const proof = { id: row.id, targetId: row.target_id, sourceChecksum: row.source_checksum,
      capturedAt: row.captured_at, auditId: row.audit_id, auditAt: row.audit_at, runId: row.run_id };
    allowed.set(row.id, proof);
    if (inProgress) running.push(proof);
  }
  const topics = readCommittedTopicProofs(db,{asOf});
  const runningProfileCount = new Set(running.map(row => row.id)).size;
  const runningTopicCount = new Set(topics.map(row => row.id)).size;
  const receipt = Object.freeze({ version: COMMITTED_TARGET_PUBLICATION, asOf,
    topicEvidenceVersion: COMMITTED_TOPIC_EVIDENCE, runningProfileCount, runningTopicCount,
    runningSnapshotCount: runningProfileCount + runningTopicCount,
    marker: topics.length ? checksum({domain:COMMITTED_TOPIC_EVIDENCE,profiles:running,topics}) : checksum(running) });
  receipts.set(receipt, { db, asOf, allowed, topicAllowed: new Map(topics.map(row=>[row.id,row])), runningIds: new Set(running.map(row => row.id)),
    baseline, legacyCaps: baselines.get(baseline)?.caps, legacySources:baselines.get(baseline)?.sources,
    totalChanges: db.prepare('SELECT total_changes() n').get().n,
    dataVersion: db.prepare('PRAGMA data_version').get().data_version });
  return receipt;
}

export function assertCommittedTargetPublication(receipt, database, asOf) {
  const db = database?.db ?? database, proof = receipts.get(receipt);
  if (!proof || proof.db !== db || proof.asOf !== asOf || !db.isTransaction
    || db.prepare('SELECT total_changes() n').get().n !== proof.totalChanges
    || db.prepare('PRAGMA data_version').get().data_version !== proof.dataVersion) failure();
  return receipt;
}

export function isCommittedTargetPublication(receipt) {
  const proof = receipts.get(receipt);
  if (!proof) return false;
  try { assertCommittedTargetPublication(receipt, proof.db, proof.asOf); return true; } catch { return false; }
}
export function releaseCommittedTargetPublication(receipt) { receipts.delete(receipt); }

export function attachPublishedSnapshotBaseline(receipt, baseline) {
  const proof = receipts.get(receipt);
  if (!proof || !baselines.has(baseline) || baseline.asOf > proof.asOf) failure();
  assertCommittedTargetPublication(receipt,proof.db,proof.asOf);
  proof.baseline=baseline;proof.legacyCaps=baselines.get(baseline).caps;proof.legacySources=baselines.get(baseline).sources;
}

export function committedRunningSnapshotIds(receipt, targetId) {
  const proof = receipts.get(receipt);
  return proof ? [...proof.runningIds].filter(id => proof.allowed.get(id)?.targetId === targetId) : [];
}

export function committedSnapshotAllowed(receipt, row, { runningOnly = false } = {}) {
  const proof = receipts.get(receipt), allowed = proof?.allowed.get(row.id);
  if (!runningOnly && proof?.legacyCaps && row.id <= (proof.legacyCaps.get(row.target_id) ?? -1)
    && typeof row.captured_at === 'string' && Number.isFinite(Date.parse(row.captured_at))
    && Date.parse(row.captured_at) <= Date.parse(proof.baseline.asOf)
    && proof.legacySources?.get(row.target_id)?.has(Date.parse(row.captured_at)+'@'+row.source_checksum)) return true;
  return Boolean(allowed && allowed.targetId === row.target_id && allowed.sourceChecksum === row.source_checksum
    && allowed.capturedAt === row.captured_at && (!runningOnly || proof.runningIds.has(row.id)));
}

export function committedTopicAllowed(receipt, row) {
  const proof = receipts.get(receipt), allowed = proof?.topicAllowed.get(row.id);
  return Boolean(allowed && isCommittedTargetPublication(receipt)
    && allowed.targetId === row.target_id && allowed.sourceChecksum === row.source_checksum
    && allowed.capturedAt === row.captured_at && allowed.participants === row.hashtag_participants
    && allowed.views === row.hashtag_views);
}

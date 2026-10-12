import { checksum, safeJson } from './utils.mjs';
import { selectVerifiedTopicIdentity } from './topic-identity-reuse.mjs';

export const COMMITTED_TOPIC_EVIDENCE = 'committed-topic-source-parent-v1';
const endpoint = 'https://www.douyin.com/aweme/v1/web/challenge/detail/';
const positive = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const accepted = value => ['validated', 'warning'].includes(value);
const topicKey = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/^#+/, '').trim().toLowerCase() : '';
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const result = Date.parse(value);
  return Number.isFinite(result) && new Date(result).toISOString() === (value.includes('.') ? value : value.replace(/Z$/, '.000Z')) ? result : NaN;
};
const currentKeys = new Set(['scope','businessStatusCode','challengeId','label','officialName','participants','views','provenance','identityReuse','capturedAt']);
const provenanceKeys = new Set(['mode','endpoint','authenticated','runtimeAI','paidAPI']);
const reuseKeys = ['scope','snapshotId','auditId','runId','capturedAt','sourceChecksum'];

function paired(row, target, at) {
  return positive(row.id) && positive(row.audit_id) && positive(row.run_id)
    && row.target_id === target.id && row.audit_target_id === target.id && row.audit_provider === 'public-web'
    && accepted(row.quality_status) && row.audit_status === row.quality_status
    && row.source_checksum === row.audit_checksum && /^[a-f0-9]{64}$/.test(row.source_checksum ?? '')
    && (row.run_target_id === null || row.run_target_id === target.id)
    && [row.started_at,row.captured_at,row.audit_created_at].every(value => Number.isFinite(time(value)))
    && time(row.started_at) <= time(row.captured_at) && time(row.captured_at) <= time(row.audit_created_at)
    && time(row.audit_created_at) <= at;
}

function currentSource(raw, row, target) {
  const p = raw?.provenance;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    && Object.keys(raw).every(key => currentKeys.has(key))
    && raw.scope === 'douyin-official-challenge-detail' && raw.businessStatusCode === 0
    && typeof raw.challengeId === 'string' && /^\d{8,24}$/.test(raw.challengeId)
    && topicKey(raw.officialName) === topicKey(target.locator) && topicKey(raw.label) === topicKey(target.locator)
    && count(raw.participants) && count(raw.views)
    && raw.participants === row.hashtag_participants && raw.views === row.hashtag_views
    && p?.mode === 'douyin-official-anonymous-challenge-detail' && p.endpoint === endpoint
    && Object.keys(p).every(key => provenanceKeys.has(key))
    && p.authenticated === false && p.runtimeAI === false && p.paidAPI === false
    && (raw.capturedAt === undefined || time(raw.capturedAt) === time(row.captured_at))
    && checksum(raw) === row.source_checksum;
}

function reference(raw) {
  const ref = raw?.identityReuse;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== reuseKeys.length
    || !reuseKeys.every(key => Object.hasOwn(ref,key)) || ref.scope !== 'historical-identity-only'
    || ![ref.snapshotId,ref.auditId,ref.runId].every(positive) || !Number.isFinite(time(ref.capturedAt))
    || !/^[a-f0-9]{64}$/.test(ref.sourceChecksum ?? '')) return null;
  return ref;
}

// Old roots may omit modern fields, but explicit refusal, a conflicting alias,
// or a foreign endpoint never becomes identity authority for a new observation.
function parentSource(raw, row, target) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const p = raw.provenance;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  for (const source of [raw,p]) {
    if (['need_login','login_required','captcha_required','verify_required','requestRejected','rejected','blocked']
      .some(key => Object.hasOwn(source,key) && source[key] !== false && source[key] !== 0 && source[key] !== null)) return false;
    if (['businessStatusCode','status_code'].some(key=>Object.hasOwn(source,key)&&source[key]!==0)) return false;
    if (['httpStatus','http_status'].some(key=>Object.hasOwn(source,key)
      && (!Number.isInteger(source[key]) || source[key]<200 || source[key]>=300))) return false;
  }
  if (p.endpoint !== undefined && p.endpoint !== endpoint) return false;
  if (p.mode !== 'douyin-authenticated-browser-search-and-detail' && p.authenticated !== undefined && p.authenticated !== false) return false;
  if (['challenge_id','ch_id','participant_count','user_count','view_count','user','user_info','source','snapshot']
    .some(key=>Object.hasOwn(raw,key))) return false;
  if (['hashtag','label','officialName'].some(key=>Object.hasOwn(raw,key)&&topicKey(raw[key])!==topicKey(target.locator))) return false;
  if (Object.hasOwn(raw,'participants') && raw.participants !== row.hashtag_participants) return false;
  if (Object.hasOwn(raw,'views') && raw.views !== row.hashtag_views) return false;
  return true;
}

/** Called only within the receipt's existing read transaction. Historical rows
 * authorize identity, never current counters. No run is fabricated as finished. */
export function readCommittedTopicProofs(db, { asOf } = {}) {
  if (!db?.isTransaction || !Number.isFinite(time(asOf))) throw new TypeError('topic-proof-requires-read-transaction');
  const targets = db.prepare("SELECT id,type,provider,locator,metadata_json FROM targets WHERE type='hashtag' AND provider='public-web'").all()
    .filter(target => (safeJson(target.metadata_json,{})?.platform ?? 'douyin') === 'douyin' && topicKey(target.locator));
  if (!targets.length) return [];
  const rows = db.prepare(`SELECT s.id,s.target_id,s.captured_at,s.hashtag_participants,s.hashtag_views,
      s.quality_status,s.source_checksum,s.raw_json,a.id audit_id,a.target_id audit_target_id,
      a.provider audit_provider,a.status audit_status,a.source_checksum audit_checksum,
      a.created_at audit_created_at,a.run_id,r.target_id run_target_id,r.trigger_type,r.status run_status,r.started_at,r.finished_at
    FROM snapshots s JOIN targets t ON t.id=s.target_id
    JOIN audits a ON a.target_id=s.target_id AND a.source_checksum=s.source_checksum
    JOIN runs r ON r.id=a.run_id WHERE t.type='hashtag' AND t.provider='public-web'
      AND julianday(s.captured_at)<=julianday(?) AND julianday(a.created_at)<=julianday(?)
    ORDER BY s.id,a.id`).all(asOf,asOf);
  const proofs = [];
  for (const target of targets) {
    const own = rows.filter(row => row.target_id === target.id);
    const indexed = new Map(own.map(row => [row.id + ':' + row.audit_id, row]));
    const parsed = new Map();
    const rawOf = row => {
      if (!parsed.has(row)) { try { parsed.set(row,JSON.parse(row.raw_json)); } catch { parsed.set(row,null); } }
      return parsed.get(row);
    };
    const terminal = (row, at) => paired(row,target,at) && ['success','partial'].includes(row.run_status)
      && Number.isFinite(time(row.finished_at)) && time(row.audit_created_at) <= time(row.finished_at) && time(row.finished_at) <= at;
    for (const row of own) {
      const at = time(row.captured_at), raw = rawOf(row);
      if (!paired(row,target,time(asOf)) || row.run_status !== 'running' || row.finished_at !== null
        || row.trigger_type !== 'scheduled' || !currentSource(raw,row,target)) continue;
      const known = selectVerifiedTopicIdentity(target,own.filter(candidate => terminal(candidate,at)),{now:at});
      if (known.status !== 'verified' || known.challengeId !== raw.challengeId) continue;
      const chain = [], seen = new Set([row.id]);
      let child = row, childRaw = raw, valid = true;
      while (true) {
        const ref = reference(childRaw);
        if (!ref || chain.length >= 128) { valid = false; break; }
        const parent = indexed.get(ref.snapshotId + ':' + ref.auditId);
        if (!parent || seen.has(parent.id) || parent.id >= child.id || parent.run_id !== ref.runId
          || parent.captured_at !== ref.capturedAt || parent.source_checksum !== ref.sourceChecksum
          || time(parent.captured_at) >= time(child.captured_at) || !terminal(parent,time(child.captured_at))) { valid = false; break; }
        const parentRaw = rawOf(parent);
        if (!parentSource(parentRaw,parent,target)) { valid = false; break; }
        const identity = selectVerifiedTopicIdentity(target,[parent],{now:time(child.captured_at)});
        if (identity.status !== 'verified' || identity.challengeId !== raw.challengeId) { valid = false; break; }
        chain.push({id:parent.id,auditId:parent.audit_id,runId:parent.run_id,sourceChecksum:parent.source_checksum,
          capturedAt:parent.captured_at,auditAt:parent.audit_created_at,finishedAt:parent.finished_at});
        seen.add(parent.id);
        if (!Object.hasOwn(parentRaw,'identityReuse')) break;
        if (!currentSource(parentRaw,parent,target)) { valid = false; break; }
        child = parent; childRaw = parentRaw;
      }
      if (valid) proofs.push({id:row.id,targetId:row.target_id,sourceChecksum:row.source_checksum,capturedAt:row.captured_at,
        auditId:row.audit_id,auditAt:row.audit_created_at,runId:row.run_id,participants:row.hashtag_participants,
        views:row.hashtag_views,challengeId:raw.challengeId,parentChainChecksum:checksum(chain)});
    }
  }
  return proofs;
}

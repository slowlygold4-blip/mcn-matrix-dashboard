import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { checksum } from './utils.mjs';
import { OFFICIAL_DOUYIN_PROFILE_ENDPOINT, isOfficialDeferredProfileEnvelope } from './official-profile-evidence.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalize = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/^@/, '').toLowerCase() : '';
const numeric = value => typeof value === 'string' && /^[1-9]\d{1,24}$/.test(value);
const challenge = value => object(value) && ['need_login', 'login_required', 'captcha_required', 'verify_required', 'not_login_module'].some(key => Boolean(value[key]));
const sec = value => typeof value === 'string' && /^MS4wLj[\w-]{12,220}$/.test(value);
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString() === (value.includes('.') ? value : value.replace(/Z$/, '.000Z')) ? n : NaN;
};
const fail = message => { throw new Error(message); };
const conflict = text => /不一致|冲突|不同作者|不符|定位锚点已变/.test(String(text || ''));
const transport = text => /403|Argus|blocked|网络|连接|HTTP\s*5\d\d|未严格回显.*内容\s*ID|请求未完成|返回空内容|未返回可核验的作品\s*ID/i.test(String(text || ''));
function parseInput(input) {
  const { evidenceText, sourceReceipt, sourcePath } = input || {};
  if (typeof evidenceText !== 'string' || evidenceText.length > 2_000_000 || !object(sourceReceipt)
    || digest(evidenceText) !== sourceReceipt.evidenceFileSha256 || typeof sourcePath !== 'string' || !sourcePath) fail('原始证据文件校验不一致');
  const probe = JSON.parse(evidenceText), response = probe?.rawResponse, raw = response?.data;
  if (!object(probe) || !object(response) || !object(raw) || response.ok !== true
    || sourceReceipt.targetId !== probe.targetId || typeof sourceReceipt.evidenceFile !== 'string'
    || resolve(sourceReceipt.evidenceFile) !== resolve(sourcePath)
    || checksum(response) !== sourceReceipt.parsedResponseJsonSha256 || checksum(raw) !== sourceReceipt.parsedDataJsonSha256) fail('已保存响应语义数据校验不一致');
  return { probe, raw, sourcePath, sourceReceipt, eventKey: checksum(['profile-monitoring-recovery-v1', probe.targetId, sourceReceipt.evidenceFileSha256, sourceReceipt.parsedDataJsonSha256]) };
}
function readPlan(db, input, reference) {
  const parsed = parseInput(input), { probe, raw, eventKey } = parsed;
  const now = reference instanceof Date ? reference.getTime() : timestamp(reference);
  if (!Number.isFinite(now)) fail('恢复校验时间无效');
  const target = db.prepare('SELECT * FROM targets WHERE id=?').get(probe.targetId);
  if (!target) fail('账号不存在');
  const existing = db.prepare("SELECT id,event_json FROM account_events WHERE target_id=? AND event_type='monitoring-recovery' AND event_key=?").get(target.id, eventKey);
  if (existing) return { status: 'already-applied', targetId: target.id, eventId: existing.id, currentlyEnabled: target.enabled === 1 };
  const metadata = JSON.parse(target.metadata_json), user = raw.profile?.user;
  if (target.type !== 'account' || target.provider !== 'public-web' || target.enabled !== 0 || !object(metadata)
    || (metadata.platform !== undefined && metadata.platform !== 'douyin') || !sec(target.locator)
    || !Number.isSafeInteger(probe.targetId) || probe.targetId !== target.id || probe.enabledAtProbe !== 0
    || probe.requestedSecUid !== target.locator || normalize(metadata.douyinId) !== normalize(probe.submittedId)
    || !/^[a-z0-9_.-]{1,100}$/.test(normalize(probe.submittedId))) fail('恢复对象或原始提交身份不一致');
  const start = timestamp(probe.startedAt), finish = timestamp(probe.finishedAt), captured = timestamp(raw.capturedAt);
  if (![start, finish, captured].every(Number.isFinite) || start > captured || captured > finish || finish > now || now - finish > 30 * 60_000
    || finish - start > 5 * 60_000 || probe.operation !== 'account' || probe.worksMode !== 'deferred'
    || probe.signedFallbackDisabled !== true || probe.newDatabaseSnapshot !== false || probe.exitStatus !== 0) fail('真实采样时间或零作品探测条件不成立');
  if (!isOfficialDeferredProfileEnvelope(raw) || raw.provenance?.mode !== 'guest-ttwid-unsigned-profile'
    || raw.provenance.profileMode !== 'guest-ttwid-unsigned-profile' || raw.provenance.profileEndpoint !== OFFICIAL_DOUYIN_PROFILE_ENDPOINT
    || raw.provenance.accountLocator !== 'sec_uid' || raw.provenance.cookiePersisted !== false || raw.provenance.runtimeAI !== false || raw.provenance.paidAPI !== false
    || raw.source !== undefined || raw.roster !== undefined || raw.snapshot !== undefined || challenge(raw) || challenge(raw.profile)
    || raw.accountStatus !== 'validated' || raw.accountError !== null || !object(user) || user.user_deleted === true
    || user.sec_uid !== target.locator || !numeric(user.uid) || raw.profile.user_info !== undefined) fail('匿名官方主页或账号定位证明无效');
  if (![normalize(user.unique_id), numeric(user.short_id) ? user.short_id : ''].includes(normalize(probe.submittedId))) fail('主页未精确回显本次提交的抖音号');
  if (raw.profileResponse !== undefined) {
    const r = raw.profileResponse, users = [r?.user, r?.user_info].filter(object);
    if (!object(r) || r.status_code !== 0 || challenge(r) || users.length !== 1
      || ['sec_uid', 'uid', 'unique_id', 'short_id'].some(key => users[0][key] !== user[key])) fail('原始主页响应身份不一致');
  }
  const values = [user.follower_count, user.total_favorited, user.aweme_count];
  if (values.some(value => value != null && (!Number.isSafeInteger(value) || value < 0))) fail('主页指标不是非负精确整数或缺失值');
  const holds = db.prepare('SELECT * FROM author_resolution_queue WHERE resolved_target_id=? AND suspended_target_enabled IS NOT NULL ORDER BY id').all(target.id);
  if (!holds.length || holds.some(hold => hold.suspended_target_enabled !== 1 || hold.status !== 'rejected'
    || hold.lease_owner || hold.lease_until || conflict(hold.last_error) || !transport(hold.last_error))) fail('暂停并非单纯已耗尽的自动传输复核暂停');
  const blockers = db.prepare("SELECT * FROM author_resolution_queue WHERE resolved_target_id=? OR lower(douyin_id)=? OR account_locator=?").all(target.id, normalize(probe.submittedId), target.locator);
  if (blockers.some(row => conflict(row.last_error) || row.lease_owner || row.lease_until && timestamp(row.lease_until) > now)) fail('存在在途核验或明确身份冲突');
  if (db.prepare("SELECT 1 FROM runs WHERE status IN ('running','queued') AND (target_id IS NULL OR target_id=?) LIMIT 1").get(target.id)
    || db.prepare("SELECT 1 FROM author_resolution_jobs WHERE status IN ('queued','running') LIMIT 1").get()) fail('采集或导入任务正在运行');
  const accountEvents = db.prepare('SELECT * FROM account_events WHERE target_id=? ORDER BY observed_at DESC,id DESC').all(target.id);
  const lifecycle = accountEvents.find(event => event.event_type === 'lifecycle');
  if (lifecycle) {
    let state; try { state = JSON.parse(lifecycle.event_json); } catch { fail('生命周期凭证不可读取'); }
    if (state.state !== 'active' || !Number.isFinite(timestamp(lifecycle.observed_at)) || timestamp(lifecycle.observed_at) >= captured) fail('存在未解除的生命周期暂停或更新的生命周期事件');
  }
  for (const event of accountEvents.filter(event => ['alias', 'identity'].includes(event.event_type))) {
    let proof; try { proof = JSON.parse(event.event_json); } catch { fail('历史身份事件不可读取'); }
    if (!object(proof) || proof.canonicalAccountId !== target.locator || proof.uid !== user.uid) fail('存在历史身份事件冲突');
  }
  const autoAudit = db.prepare("SELECT * FROM audits WHERE target_id=? AND message LIKE '严格身份复核：历史记录含%原监控已暂停%' ORDER BY created_at,id LIMIT 1").get(target.id);
  if (!autoAudit || !Number.isFinite(timestamp(autoAudit.created_at))) fail('缺少原自动暂停审查凭证');
  const actions = db.prepare("SELECT * FROM activity_log WHERE resource_type='target' AND resource_id=? AND action IN ('target.create','target.update','target.state') AND created_at>=? ORDER BY id").all(String(target.id), autoAudit.created_at);
  for (const action of actions) {
    let detail; try { detail = JSON.parse(action.details_json); } catch { fail('启停操作日志不可验证'); }
    if (detail.enabled === false || detail.enabled === 0) {
      if (action.user_id != null || detail.source !== 'strict-identity-review' || action.actor_name !== '系统') fail('检测到人工暂停，不能自动恢复');
    }
  }
  const history = db.prepare('SELECT id,captured_at,raw_json,source_checksum FROM snapshots WHERE target_id=? ORDER BY id LIMIT 10001').all(target.id);
  if (!history.length || history.length > 10000) fail('历史身份样本缺失或超出审查上限');
  let knownUid = false;
  for (const row of history) {
    if (typeof row.raw_json !== 'string' || digest(row.raw_json) !== row.source_checksum) fail('历史样本原文校验失败');
    const previous = JSON.parse(row.raw_json), oldUser = previous?.profile?.user;
    if (!oldUser) continue;
    if (oldUser.sec_uid !== target.locator || oldUser.uid !== user.uid) fail('旧快照canonical或uid与本次主页冲突');
    knownUid = true;
    if (!Number.isFinite(timestamp(row.captured_at)) || timestamp(row.captured_at) >= captured) fail('已有更新或异常时间的快照，未覆盖或回填');
  }
  if (!knownUid) fail('没有可对照的历史双ID样本');
  const plan = { targetId: target.id, target, holds, autoAuditId: autoAudit.id, actions, accountEvents,
    history: history.map(row => ({ id: row.id, sourceChecksum: row.source_checksum })), eventKey, evidenceFileSha256: parsed.sourceReceipt.evidenceFileSha256,
    dataChecksum: checksum(raw), responseChecksum: checksum(probe.rawResponse), sourcePath: parsed.sourcePath,
    capturedAt: raw.capturedAt, requestStartedAt: probe.startedAt, requestFinishedAt: probe.finishedAt,
    metrics: values.map(value => value == null ? null : value), uid: user.uid, probe, raw };
  return { status: 'ready', targetId: target.id, planSha256: checksum(plan), plan };
}

export function validateProfileMonitoringRecovery(database, input, { reference = new Date() } = {}) {
  try { return readPlan(database?.db ?? database, input, reference); }
  catch (error) { return { status: 'blocked', reason: String(error?.message || error) }; }
}

/** Explicit application only. Caller must back up and approve the validated
 * plan. No network, scheduling, source rewriting or work verification occurs.
 */
export function applyProfileMonitoringRecovery(database, input, { expectedPlanSha256, reference = new Date() } = {}) {
  const db = database?.db ?? database;
  db.exec('BEGIN IMMEDIATE');
  try {
    const checked = readPlan(db, input, reference);
    if (checked.status === 'already-applied') { db.exec('COMMIT'); return checked; }
    if (!/^[a-f0-9]{64}$/.test(expectedPlanSha256 || '') || checked.planSha256 !== expectedPlanSha256) fail('恢复计划或数据库状态已变化，需重新审查');
    const p = checked.plan, persistedAt = reference instanceof Date ? reference.toISOString() : reference;
    const warnings = ['仅恢复账号主页统计监控；原作品身份核验失败仍保留，作品未验证'];
    const run = db.prepare(`INSERT INTO runs(trigger_type,target_id,started_at,finished_at,status,target_count,success_count,error_count,details_json,processed_count,skipped_count,warning_count,heartbeat_at)
      VALUES('profile-monitoring-recovery',?,?,?,'partial',1,1,0,?,1,0,1,?)`).run(p.targetId, p.requestStartedAt, persistedAt,
      JSON.stringify({ requestStartedAt: p.requestStartedAt, requestFinishedAt: p.requestFinishedAt, persistedAt, profileSuccessCount: 1, worksSuccessCount: 0, worksRequestCount: 0, evidenceFileSha256: p.evidenceFileSha256 }), persistedAt);
    const runId = Number(run.lastInsertRowid);
    const snap = db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,account_error,works_error,warnings_json,source_checksum,raw_json)
      VALUES(?,?,?,?,?,'warning',?,'unavailable',NULL,?,?,?,?)`).run(p.targetId, p.capturedAt, ...p.metrics, p.metrics.every(value => value !== null) ? 'available' : 'partial',
      p.raw.worksError || warnings[0], JSON.stringify(warnings), p.dataChecksum, JSON.stringify(p.raw));
    const snapshotId = Number(snap.lastInsertRowid);
    const audit = db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message)
      VALUES(?,?,?,'public-web','warning',0,?,?,?)`).run(p.targetId, runId, persistedAt, JSON.stringify(warnings), p.dataChecksum, warnings[0]);
    const auditId = Number(audit.lastInsertRowid);
    const receipt = { type: 'profile-monitoring-recovery', version: 1, targetId: p.targetId, canonicalAccountId: p.target.locator, uid: p.uid,
      submittedAccountId: p.probe.submittedId, sourcePath: p.sourcePath, evidenceFileSha256: p.evidenceFileSha256,
      sourceChecksum: p.dataChecksum, observedAt: p.capturedAt, requestStartedAt: p.requestStartedAt, requestFinishedAt: p.requestFinishedAt, persistedAt,
      stdoutByteHashVerified: false, canonicalDataHashVerified: true, profileIdentityVerified: true, worksVerified: false, worksRequestCount: 0,
      originalAutoPauseAuditId: p.autoAuditId, originalHolds: p.holds, originalTarget: p.target,
      snapshotId, auditId, runId, planSha256: checked.planSha256 };
    const event = db.prepare(`INSERT INTO account_events(target_id,run_id,event_type,event_key,observed_at,source_checksum,event_json,raw_json,created_at)
      VALUES(?,?,'monitoring-recovery',?,?,?,?,?,?)`).run(p.targetId, runId, p.eventKey, p.capturedAt, p.dataChecksum, JSON.stringify(receipt), JSON.stringify(p.raw), persistedAt);
    for (const hold of p.holds) {
      const changed = db.prepare(`UPDATE author_resolution_queue SET suspended_target_enabled=NULL
        WHERE id=? AND resolved_target_id=? AND suspended_target_enabled=1 AND status='rejected' AND evidence_version=? AND last_error IS ?`).run(hold.id, p.targetId, hold.evidence_version, hold.last_error);
      if (changed.changes !== 1) fail('原自动暂停凭证发生并发变化');
    }
    const updated = db.prepare(`UPDATE targets SET enabled=1,updated_at=?,last_checked_at=?,last_status='warning'
      WHERE id=? AND enabled=0 AND locator=? AND metadata_json=? AND updated_at=?`).run(persistedAt, p.capturedAt, p.targetId, p.target.locator, p.target.metadata_json, p.target.updated_at);
    if (updated.changes !== 1) fail('账号状态发生并发变化，未恢复');
    db.prepare(`INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
      VALUES('系统','target.state','target',?,?,?)`).run(String(p.targetId), persistedAt, JSON.stringify({ enabled: true, source: 'profile-monitoring-recovery', eventId: Number(event.lastInsertRowid), worksVerified: false }));
    db.exec('COMMIT');
    return { status: 'applied', targetId: p.targetId, eventId: Number(event.lastInsertRowid), runId, snapshotId, auditId, capturedAt: p.capturedAt, worksVerified: false };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

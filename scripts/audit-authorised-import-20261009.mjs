#!/usr/bin/env node
// A one-shot, read-only closeout. Never starts a collector or changes queue,
// targets, snapshots, source rows, immutable receipts, or the frozen roster.
// --self-test exercises only pure helpers / an in-memory SQLite fixture.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseAuthorSpreadsheet } from '../lib/author-spreadsheet.mjs';
import { summarizeAuthorAccountIdentities } from '../lib/author-resolution.mjs';
import { readImportMonitoringStatus } from '../lib/import-monitoring-status.mjs';
import { validatedSuccessProof } from '../lib/master-roster-supplement.mjs';
import { prepareImportAuthorisedDetail } from '../lib/import-authorised-detail.mjs';
import { validateAuthorisedDetailResult } from '../lib/douyin-authorised-detail.mjs';
import { validateAccountSnapshot } from '../lib/account-snapshot-integrity.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'http://127.0.0.1:4188';
const JOB = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f';
const OLD_JOB = '24ed9508-815c-4c08-81f6-b73266d0f304';
const XLSX = '/Users/tyke/Downloads/一条小团团切片作品登记表.xlsx';
const EVIDENCE_DIR = join(ROOT, 'data/maintenance-journal/20261009-author-detail-investigation');
const BASELINE_DB = join(ROOT, 'data/backups/20261009-import-pipeline/douyin-monitor-auto-20261009T155227764Z-before-import-pipeline-374bbb2b.sqlite');
const FROZEN_SQL = 'SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key';
const BASELINE = Object.freeze({
  originalFileSha256: '88bf7c4c50ac9031c8749254e791bb512306c44c564e65db576c6f84e755a3bb',
  frozenRosterSha256: '5e7b062105a441ea48febf674949229bbb908b6ce4bb5f25eb26e48032db0ab2',
  oldImportResultSha256: '0eb5608b368befd7f344e6cc5e1898947094da9f36a52a50a21efd0b3bf59e27',
  currentImportRequestSha256: '17732e521fba518599b2d4f85046ff045b5d4846e8bc8c5553e9f14b102e8fa2',
  currentImportResultSha256: '0f8eb53b4db589762ccab9ffafb112a2e112c76de82b1e0ab6a2eb544d97cd22',
  rows: 3988, submittedIdentities: 394, enabled: 153, pending: 241, targets: 765, snapshots: 60774,
});
const sha = value => createHash('sha256').update(value).digest('hex');
const jsonSha = value => sha(JSON.stringify(value));
const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
const instant = value => typeof value === 'string' ? Date.parse(value) : NaN;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const counters = ['submittedIdentities', 'enabled', 'paused', 'pending', 'conflict', 'unknown',
  'freshProfiles', 'staleProfiles', 'missingProfiles', 'invalidProfiles'];

export function csvCell(value, { identifier = false } = {}) {
  let text = String(value ?? '').replace(/\u0000/g, '');
  if (identifier || /^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function frozenHash(db) { return jsonSha(db.prepare(FROZEN_SQL).all()); }
function checkCounts(value) {
  return value && counters.every(key => integer(value[key]))
    && ['enabled', 'paused', 'pending', 'conflict', 'unknown'].reduce((sum, key) => sum + value[key], 0) === value.submittedIdentities
    && ['freshProfiles', 'staleProfiles', 'missingProfiles', 'invalidProfiles'].reduce((sum, key) => sum + value[key], 0) === value.enabled;
}

const attemptReasons = Object.freeze({
  committed: '该原表行身份已核验并提交；当前是否启用另按数据库确认',
  identity_confirmed_not_committed: '该原表行身份核验通过，但未完成监控提交',
  identity_mismatch: '未取得与提交 ID 一致的作品作者身份证据，未绑定；无结构诊断时不推断为明确的不同作者',
  invalid_evidence: '该原表作品未提供符合严格核验要求的身份证据，未绑定',
  no_bound_response: '未观察到可绑定该原表作品的公开身份响应',
  business_error: '该原表作品返回平台业务失败；不能据此断言删除或私密',
  timeout: '本次单项核验超时', navigation_error: '本次作品页面载入失败',
  login_required: '平台要求登录', challenge_required: '平台要求人工验证，未自动处理',
  blocked: '平台拒绝本次访问', rate_limited: '平台限制访问频率',
  session_required: '缺少授权会话', session_permissions: '授权会话权限不足', session_invalid: '授权会话无效',
  browser_unavailable: '授权浏览器不可用', ownership_required: '当前没有可用的产品专属浏览器通道',
  disabled: '授权核验通道未开启', invalid_input: '单项核验输入未通过校验',
  collector_error: '单项核验未完成', cleanup_uncertain: '通道安全清理尚未确认，本次未接入', cancelled: '本次核验已取消',
  local_service_error: '本机请求失败，不代表账号不存在', local_request_incomplete: '未取得完整本机响应',
  local_busy: '本机通道正在使用或冷却，本次没有完成平台核验', local_authorization: '本机操作授权失败',
  local_rate_limited: '本机请求被限流，不能推断平台账号状态',
  not_attempted: '本轮没有与此原始身份和源行核对通过的尝试记录',
});

/** Local append-only attempt files are source-bound observations, not identity
 * admission proofs. Their hashes bind the retained files, not upstream signatures. */
export function inspectAttempt(saved, job, { plan = null, file = '', fileSha256 = '', fileSourceRow = null } = {}) {
  try {
    const sourceRow = saved.sourceRow ?? saved.data?.sourceRow;
    assert.ok(Number.isSafeInteger(sourceRow) && sourceRow > 0);
    if (fileSourceRow !== null) assert.equal(sourceRow, fileSourceRow);
    const originals = job.request.rows.filter(row => row.sourceRow === sourceRow);
    assert.equal(originals.length, 1);
    const input = prepareImportAuthorisedDetail(job, { sourceRow });
    const start = saved.at ?? saved.startedAt, end = saved.finishedAt;
    assert.ok(Number.isFinite(instant(start)) && Number.isFinite(instant(end)) && instant(start) <= instant(end));
    if (plan) {
      assert.equal(plan.jobId, job.id);
      const selected = plan.items.filter(item => item.sourceRow === sourceRow);
      assert.equal(selected.length, 1);
      for (const item of [selected[0], saved]) {
        assert.equal(item.key, input.key); assert.equal(item.submittedId, input.submittedId);
      }
    }
    let code, diagnostic = null;
    if (saved.data?.result) {
      assert.equal(saved.data.jobId, job.id); assert.equal(saved.data.sourceRow, sourceRow);
      const result = validateAuthorisedDetailResult(input, saved.data.result, { startedAt: start, finishedAt: end });
      diagnostic = result.diagnostic ?? null;
      if (result.status === 'unavailable') {
        assert.equal(saved.data.monitoringChanged, false); assert.equal(saved.data.admission, undefined);
        code = result.errorCode;
      } else if (saved.data.monitoringChanged === true) {
        assert.equal(saved.status, 200); assert.equal(saved.data.admission?.status, 'committed');
        assert.ok(Number.isSafeInteger(saved.data.admission?.target?.id) && saved.data.admission.target.id > 0);
        code = 'committed';
      } else {
        assert.equal(saved.data.monitoringChanged, false); code = 'identity_confirmed_not_committed';
      }
    } else {
      // A bare 503 cannot be assigned by filename alone. Require the saved batch
      // plan and exact source row / request key / submitted ID triple.
      assert.ok(plan);
      if (saved.status === 0 && saved.error === 'local-request-incomplete') code = 'local_request_incomplete';
      else if (saved.status >= 500 && saved.status <= 599) code = 'local_service_error';
      else if ([401, 403].includes(saved.status)) code = 'local_authorization';
      else if ((saved.status === 409 && saved.data?.error === '采集通道正在使用或等待安全清理，请稍后再试')
        || (saved.status === 429 && saved.data?.error === '单项核验正在运行或冷却中，请稍后再试')) code = 'local_busy';
      else if (saved.status === 429) code = 'local_rate_limited';
      else return null;
    }
    assert.ok(Object.hasOwn(attemptReasons, code));
    return { jobId: job.id, submittedId: input.submittedId, sourceRow, key: input.key,
      sourceRowSha256: jsonSha(originals[0]), attemptedAt: start, finishedAt: end, code, reason: attemptReasons[code],
      file, fileSha256, diagnostic, hashScope: 'retained-local-attempt-file-bytes', identityAdmissionProof: false };
  } catch { return null; }
}

export function selectLatestAttempts(attempts) {
  const latest = new Map();
  for (const item of attempts) {
    const key = normalize(item.submittedId), prior = latest.get(key);
    if (!prior || instant(item.finishedAt) > instant(prior.finishedAt)
      || (item.finishedAt === prior.finishedAt && item.file > prior.file)) latest.set(key, item);
  }
  return latest;
}

async function readAttemptEvidence(job, now) {
  const result = { filesRead: 0, accepted: [], rejectedFiles: [], source: 'this-turn-source-bound-attempt-files-only' };
  const directories = (await readdir(EVIDENCE_DIR, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && (/^batch-\d+$/.test(entry.name) || ['repair', 'onboarding', 'final2'].includes(entry.name)))
    .map(entry => entry.name).sort();
  assert.ok(directories.length <= 100, 'attempt directory bound exceeded');
  const readJson = async path => {
    const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024);
    const bytes = await readFile(path); assert.ok(bytes.length <= 2 * 1024 * 1024);
    return { data: JSON.parse(bytes.toString('utf8')), hash: sha(bytes) };
  };
  for (const directory of directories) {
    const batch = directory.startsWith('batch-');
    let plan = null;
    try { if (batch) plan = (await readJson(join(EVIDENCE_DIR, directory, 'plan.json'))).data; }
    catch { result.rejectedFiles.push(directory + '/plan.json'); continue; }
    const names = (await readdir(join(EVIDENCE_DIR, directory), { withFileTypes: true }))
      .filter(entry => entry.isFile() && (batch ? /^row-\d+-attempt-\d+\.json$/ : /^real-monitor-row\d+(?:-\d+)?\.json$/).test(entry.name))
      .map(entry => entry.name).sort();
    for (const name of names) {
      assert.ok(++result.filesRead <= 5000, 'attempt file bound exceeded');
      const path = join(EVIDENCE_DIR, directory, name), file = relative(ROOT, path);
      try {
        const saved = await readJson(path), fileSourceRow = Number(name.match(/row-?(\d+)/)[1]);
        const item = inspectAttempt(saved.data, job, { plan, file, fileSha256: saved.hash, fileSourceRow });
        if (!item || instant(item.finishedAt) > now.getTime()) result.rejectedFiles.push(file);
        else result.accepted.push(item);
      } catch { result.rejectedFiles.push(file); }
    }
  }
  return result;
}

export function summarizeAdmittedProfiles(profiles) {
  const newProfiles = profiles.filter(row => row.isNewTargetSinceBaseline === true);
  const newTargetsWithProfile = newProfiles.filter(row => row.realProfileObserved
    && Number.isFinite(instant(row.admissionCommittedAt)) && instant(row.capturedAt) > instant(row.admissionCommittedAt)).length;
  return { total: profiles.length, newTargets: newProfiles.length, newTargetsWithProfile,
    newTargetsAwaitingProfile: newProfiles.length - newTargetsWithProfile,
    realProfileObserved: profiles.filter(row => row.realProfileObserved).length,
    fresh8h: profiles.filter(row => row.realProfileObserved && row.fresh8h && row.enabled).length, items: profiles };
}

export function serializeAuditArtifacts(report) {
  const csv = '\uFEFF' + ['平台,提交账号ID,作者名称,接入状态,主页采样状态,监控账号编号,原始行数,原始行号,当前未启用说明,本轮最近核验结果,核验原表行号,核验开始时间,核验完成时间,证据文件',
    ...report.notEnabled.map(row => [csvCell(row.platform), csvCell(row.submittedId, { identifier: true }), csvCell(row.name),
      csvCell(row.status), csvCell(row.profileStatus), csvCell(row.targetId), csvCell(row.sourceRows),
      csvCell(row.sourceRowNumbers.join(' / ')), csvCell(row.reason),
      csvCell(row.latestAttempt?.reason ?? (row.preparableSourceRows?.length === 0
        ? '原始填写缺有效抖音号或可核验的抖音作品/分享链接；未猜测绑定' : attemptReasons.not_attempted)), csvCell(row.latestAttempt?.sourceRow),
      csvCell(row.latestAttempt?.attemptedAt), csvCell(row.latestAttempt?.finishedAt), csvCell(row.latestAttempt?.file)].join(','))].join('\r\n') + '\r\n';
  const c = report.monitoring.counts, p = report.admittedTargetProfiles, issues = report.issues;
  const markdown = `# 本轮监控接入对账\n\n北京时间：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'long' }).format(new Date(report.finishedAt))}\n\n`
    + `- 原始表：${report.source.rows} 行、${c.submittedIdentities} 个明确提交身份。\n`
    + `- 已启用 ${c.enabled}，暂停 ${c.paused}，待接入 ${c.pending}，冲突 ${c.conflict}，无法确认 ${c.unknown}。\n`
    + `- 本表当前主页：近 8 小时有效 ${c.freshProfiles}，过期 ${c.staleProfiles}，无记录 ${c.missingProfiles}，无效 ${c.invalidProfiles}。\n`
    + `- 本轮自然核验接入凭据 ${report.receipts.currentJob} 条，关联 ${p.total} 个目标（含复用账号）；其中 ${p.realProfileObserved} 个存在真实主页采样，可包含接入前的旧采样。\n`
    + `- 新增监控目标 ${p.newTargets} 个：接入提交后已有真实主页采样 ${p.newTargetsWithProfile}，仍待取得接入后有效主页采样 ${p.newTargetsAwaitingProfile}。\n`
    + `- 原始资料/入库凭据/只读回读审查：${report.auditPassed ? '通过' : '存在待检查项'}。${issues.length ? `\n- 待检查：${issues.join('；')}。` : ''}\n\n`
    + '身份接入不等于新指标采样，更不等于作品全量采集。作品及话题覆盖见 JSON 的独立全局接口统计；不按主页成功推算。\n\n'
    + '未启用账号清单见同目录 `not-enabled-authors.csv`（原始行号、最近已核对尝试及原因）。没有核验记录不代表账号不存在；单条作品失败也不能推断账号删除或私密。完整校验及逐账号采样/提交时间见 `audit.json`。\n';
  return { 'audit.json': JSON.stringify(report, null, 2) + '\n', 'report.md': markdown, 'not-enabled-authors.csv': csv };
}

/** Reconstruct only the public identity projection retained by the immutable
 * receipt. This checks its internal integrity, not an upstream signature. */
export function inspectReceipt(saved, job, target) {
  const proof = validatedSuccessProof(saved);
  if (!proof) return { id: saved.id, valid: false, code: 'invalid-success-proof' };
  const natural = proof.resolution?.authorisedDetailReceipt;
  const base = { id: saved.id, queueId: proof.queueId, targetId: proof.targetId,
    submittedId: normalize(proof.evidence.douyinId), verifiedAt: proof.verifiedAt,
    committedAt: proof.committedAt, receiptSha256: saved.receipt_sha256,
    currentJob: natural?.source?.jobId === job.id, naturalDetail: Boolean(natural) };
  try {
    assert.ok(target && target.id === proof.targetId && target.type === 'account');
    assert.equal(target.locator, proof.canonicalAccountId);
    assert.equal(JSON.parse(target.metadata_json).platform ?? 'douyin', proof.platform);
  } catch { return { ...base, valid: false, code: 'current-target-mismatch' }; }
  if (!natural || !base.currentJob) return { ...base, valid: true, code: 'validated-other-receipt' };
  try {
    const source = natural.source, originals = job.request.rows.filter(row => row.sourceRow === source.sourceRow);
    assert.equal(originals.length, 1);
    assert.equal(source.sourceRowSha256, jsonSha(originals[0]));
    assert.equal(source.fileName, job.fileName); assert.equal(source.sheetName, job.sheetName);
    assert.equal(natural.format, 'mcn-authorised-detail-admission-v1');
    assert.equal(natural.identityOnly, true); assert.equal(natural.metricsSampled, false);
    assert.equal(natural.allAccountWorksCollected, false);
    assert.equal(natural.scope, 'one-queue-all-submitted-work-evidence');
    const input = prepareImportAuthorisedDetail(job, { sourceRow: source.sourceRow });
    assert.equal(source.evidenceRequestKey, input.key); assert.equal(proof.identityKey, input.key);
    assert.equal(base.submittedId, input.submittedId);
    assert.equal(normalize(proof.resolution.publicDouyinId), input.submittedId);
    assert.equal(natural.queue?.id, proof.queueId); assert.equal(natural.queue?.identityKey, input.key);
    assert.equal(natural.queue?.evidenceVersion, proof.evidenceVersion);
    assert.equal(natural.queue?.verificationPolicyVersion, 2);
    assert.deepEqual(natural.queue.videoIds, proof.evidence.videoIds);
    assert.deepEqual(natural.queue.shareUrls, proof.evidence.shareUrls);
    assert.ok(natural.queue.sourceRows.includes(source.sourceRow));
    assert.ok(target && target.id === proof.targetId && target.type === 'account');
    assert.equal(target.locator, proof.canonicalAccountId);
    assert.equal(JSON.parse(target.metadata_json).platform ?? 'douyin', proof.platform);
    const evidence = natural.evidence, author = evidence.response.aweme_detail.author;
    const videoId = evidence.response.aweme_detail.aweme_id;
    const reconstructed = { status: 'ok', key: input.key, submittedId: input.submittedId,
      ...(input.shareUrl ? { shareUrl: input.shareUrl, videoId } : { videoId: input.videoId }),
      requestStartedAt: natural.requestStartedAt, requestFinishedAt: natural.requestFinishedAt,
      candidate: { videoId, secUid: author.sec_uid, uid: author.uid, uniqueId: author.unique_id ?? '', shortId: author.short_id ?? '',
        provenance: natural.provenance.mode, observedAt: natural.observedAt,
        responseSha256: natural.responseSha256, responseSha256Scope: natural.responseSha256Scope },
      evidence, provenance: natural.provenance };
    validateAuthorisedDetailResult(input, reconstructed, {
      startedAt: natural.requestStartedAt, finishedAt: natural.requestFinishedAt,
    });
    assert.equal(natural.observedAt, proof.verifiedAt);
    assert.ok(instant(natural.requestFinishedAt) <= instant(proof.committedAt));
    return { ...base, sourceRow: source.sourceRow, valid: true, code: 'same-original-row-natural-identity-proof',
      targetEnabled: target.enabled === 1, publicUid: author.uid, identityOnly: true, metricsSampled: false,
      allAccountWorksCollected: false, responseSha256: natural.responseSha256, responseSha256Scope: natural.responseSha256Scope };
  } catch { return { ...base, valid: false, code: 'source-or-natural-receipt-mismatch' }; }
}

function inspectProfile(db, target, now, expectedUids = []) {
  const snapshot = db.prepare(`SELECT * FROM snapshots WHERE target_id=? ORDER BY
    CASE WHEN julianday(captured_at) IS NULL THEN 0 ELSE 1 END,julianday(captured_at) DESC,id DESC LIMIT 1`).get(target.id);
  const base = { targetId: target.id, enabled: target.enabled === 1, snapshotId: snapshot?.id ?? null,
    realProfileObserved: false, fresh8h: false, worksCompleteVerified: null };
  if (!snapshot) return { ...base, status: 'missing', capturedAt: null };
  const result = { ...base, capturedAt: snapshot.captured_at, sourceChecksum: snapshot.source_checksum,
    storedWorksCoverage: snapshot.works_coverage };
  const integrity = validateAccountSnapshot(snapshot, target, null, { metricsOnly: true });
  if (target.provider !== 'public-web' || !integrity.valid || !['available', 'partial'].includes(snapshot.account_status)
    || ![snapshot.followers, snapshot.total_likes, snapshot.total_posts].every(integer)) {
    return { ...result, status: 'invalid', reason: integrity.reason || 'not-public-complete-profile' };
  }
  const raw = JSON.parse(snapshot.raw_json), user = raw.profile?.user ?? raw.user ?? raw.user_info;
  if (expectedUids.length !== 1 || user?.uid !== expectedUids[0]) {
    return { ...result, status: 'invalid', reason: 'profile-vs-authorised-identity-uid-mismatch' };
  }
  const blocked = value => value && ['need_login', 'login_required', 'captcha_required', 'verify_required', 'not_login_module']
    .some(key => Boolean(value[key]));
  if (user?.user_deleted === true || ['failed', 'identity_mismatch', 'unavailable'].includes(raw.accountStatus)
    || [raw, raw.profile, raw.profileResponse, user].some(blocked)) return { ...result, status: 'invalid', reason: 'barrier-or-identity-failure' };
  const audit = db.prepare(`SELECT a.id,a.status,a.created_at,a.run_id,r.started_at,r.finished_at,r.status run_status
    FROM audits a JOIN runs r ON r.id=a.run_id WHERE a.target_id=? AND a.source_checksum=? AND a.provider='public-web'
    AND a.status IN ('validated','warning') ORDER BY julianday(a.created_at) DESC,a.id DESC LIMIT 1`).get(target.id, snapshot.source_checksum);
  const captured = instant(snapshot.captured_at), audited = instant(audit?.created_at), start = instant(audit?.started_at), end = instant(audit?.finished_at);
  if (![captured, audited, start, end].every(Number.isFinite) || start > captured || captured > audited || audited > end || end > now.getTime()) {
    return { ...result, status: 'unverified-audit-run', reason: 'missing-or-inconsistent-real-sampling-window', auditId: audit?.id ?? null };
  }
  return { ...result, status: now.getTime() - captured <= 8 * 3600_000 ? 'fresh' : 'stale',
    realProfileObserved: true, fresh8h: now.getTime() - captured <= 8 * 3600_000,
    auditId: audit.id, runId: audit.run_id, runStartedAt: audit.started_at, runFinishedAt: audit.finished_at,
    metrics: { followers: snapshot.followers, likes: snapshot.total_likes, worksStock: snapshot.total_posts } };
}

function coverage(value) {
  if (!value || !integer(value.total) || !integer(value.complete) || value.complete > value.total) return null;
  return { total: value.total, complete: value.complete, missing: value.total - value.complete,
    ...(value.counts ? { counts: Object.fromEntries(['complete', 'limited', 'unavailable', 'unknown', 'missing'].map(key => [key, value.counts[key] ?? null])) } : {}) };
}
async function inspectHttp(expectedCounts) {
  const output = { credentialPersistence: false, collectionTriggered: false, origin: ORIGIN };
  const get = async (path, headers = {}) => {
    const response = await fetch(ORIGIN + path, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw new Error('oversized-local-response');
    return { response, body: JSON.parse(text) };
  };
  try {
    const { response, body } = await get('/healthz');
    output.health = { status: response.status, ok: response.status === 200 && body.ok === true && body.service === 'douyin-monitor-workbench' };
  } catch { output.health = { ok: false, code: 'local-health-unavailable' }; }
  try {
    const { response: auth, body: session } = await get('/api/auth/session');
    const cookie = (auth.headers.get('set-cookie') || '').split(';')[0];
    if (auth.status !== 200 || session.authenticated !== true || session.user?.role !== 'admin' || !cookie) throw new Error('local-owner-session-required');
    // Credentials only remain in this lexical scope, never in output or errors.
    const headers = { Cookie: cookie };
    const { response, body } = await get('/api/monitoring-status', headers), sla = body.updateSla;
    output.monitoring = { status: response.status, checkedAt: body.checkedAt ?? null,
      ok: response.status === 200 && sla?.version === 1 && Number.isFinite(instant(body.checkedAt)),
      scope: 'all-enabled-product-targets-not-this-import-only',
      profiles: { daily: coverage(sla?.coreAccounts?.daily), fresh8h: coverage(sla?.coreAccounts?.fresh8h) },
      works: { daily: coverage(sla?.works?.daily), fresh8h: coverage(sla?.works?.fresh8h) },
      topics: { daily: coverage(sla?.topics?.daily), fresh8h: coverage(sla?.topics?.fresh8h) },
      browserLane: { busy: body.browserLane?.busy === true, locked: body.browserLane?.locked === true },
      scheduler: { running: body.scheduler?.running === true, nextRunAt: body.scheduler?.nextRunAt ?? null } };
    const current = await get(`/api/author-spreadsheet/jobs/${JOB}/monitoring?limit=20`, headers);
    output.import = { status: current.response.status, checkedAt: current.body.checkedAt ?? null,
      ok: current.response.status === 200 && current.body.jobId === JOB && checkCounts(current.body.counts),
      counts: checkCounts(current.body.counts) ? current.body.counts : null };
    output.import.matchesDatabaseRead = output.import.ok && counters.every(key => current.body.counts[key] === expectedCounts[key]);
  } catch { output.authorizationOrApi = { ok: false, code: 'local-readback-incomplete', detailsRetained: false }; }
  return output;
}

async function audit() {
  const startedAt = new Date().toISOString(), issues = [], checks = [];
  const check = (name, actual, expected) => {
    const ok = actual === expected; checks.push({ name, actual, expected, ok }); if (!ok) issues.push(name); return ok;
  };
  const now = new Date(), buffer = await readFile(XLSX), originalFileSha256 = sha(buffer);
  check('original-xlsx-sha256', originalFileSha256, BASELINE.originalFileSha256);
  const parsed = await parseAuthorSpreadsheet({ buffer, fileName: basename(XLSX) });
  check('xlsx-source-row-count', parsed.rows.length, BASELINE.rows);
  check('xlsx-submitted-identity-count', summarizeAuthorAccountIdentities(parsed.rows).knownDistinctSubmittedIdentityCount, BASELINE.submittedIdentities);
  let beforeTargets = null;
  try {
    const old = new DatabaseSync(BASELINE_DB, { readOnly: true });
    try {
      old.exec('PRAGMA query_only=ON; BEGIN');
      const targets = old.prepare('SELECT id FROM targets ORDER BY id').all();
      const valid = check('baseline-backup-frozen-sha256', frozenHash(old), BASELINE.frozenRosterSha256)
        && check('baseline-backup-target-count', targets.length, BASELINE.targets);
      if (valid) beforeTargets = new Set(targets.map(row => row.id));
      check('baseline-backup-snapshot-count', old.prepare('SELECT count(*) n FROM snapshots').get().n, BASELINE.snapshots);
    } finally { old.exec('ROLLBACK'); old.close(); }
  } catch { issues.push('baseline-backup-unreadable'); }

  const db = new DatabaseSync(join(ROOT, 'data/douyin-monitor.sqlite'), { readOnly: true });
  let report, job, status, allItems;
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
    const stored = db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(JOB);
    assert.ok(stored, 'original import job missing');
    job = { id: stored.id, status: stored.status, fileName: stored.file_name, sheetName: stored.sheet_name, request: JSON.parse(stored.request_json) };
    check('original-job-completed', job.status, 'completed');
    check('original-job-request-sha256', sha(stored.request_json), BASELINE.currentImportRequestSha256);
    check('original-job-result-sha256', sha(stored.result_json), BASELINE.currentImportResultSha256);
    check('original-job-upload-sha256', job.request.uploadSha256, BASELINE.originalFileSha256);
    check('original-job-rows', job.request.rows.length, BASELINE.rows);
    const priorJob = db.prepare('SELECT result_json FROM author_resolution_jobs WHERE id=?').get(OLD_JOB);
    check('old-job-result-sha256', priorJob ? sha(priorJob.result_json) : null, BASELINE.oldImportResultSha256);
    check('frozen-roster-sha256', frozenHash(db), BASELINE.frozenRosterSha256);
    const sourceIds = rows => [...new Set(rows.map(row => `${row.platform}:${normalize(row.douyinId)}`))].sort();
    check('xlsx-and-job-identity-set', jsonSha(sourceIds(parsed.rows)), jsonSha(sourceIds(job.request.rows)));
    status = readImportMonitoringStatus(db, job, { now, limit: 100 }); allItems = [...status.items];
    for (let offset = 100; offset < status.pagination.total; offset += 100) {
      const page = readImportMonitoringStatus(db, job, { now, limit: 100, offset });
      assert.equal(page.pagination.offset, offset); allItems.push(...page.items);
    }
    check('current-import-identity-count', status.counts.submittedIdentities, BASELINE.submittedIdentities);
    check('current-import-counts-consistent', checkCounts(status.counts), true);
    check('current-import-all-pages', allItems.length, status.counts.submittedIdentities);
    check('current-import-no-duplicate-identities', new Set(allItems.map(item => item.key)).size, allItems.length);
    const receipts = db.prepare('SELECT * FROM author_resolution_success_receipts ORDER BY id LIMIT 10001').all();
    assert.ok(receipts.length <= 10000, 'receipt audit limit exceeded; no partial success declaration');
    const targetQuery = db.prepare('SELECT * FROM targets WHERE id=?'), targetCache = new Map();
    const target = id => { if (!targetCache.has(id)) targetCache.set(id, targetQuery.get(id)); return targetCache.get(id); };
    const receiptAudit = receipts.map(row => inspectReceipt(row, job, target(row.target_id)));
    check('all-success-receipts-valid', receiptAudit.filter(row => !row.valid).length, 0);
    const currentReceipts = receiptAudit.filter(row => row.currentJob);
    const profileTargets = [...new Set(currentReceipts.filter(row => row.valid).map(row => row.targetId))];
    const profiles = profileTargets.map(id => {
      const admissions = currentReceipts.filter(row => row.valid && row.targetId === id);
      const admissionCommittedAt = admissions.map(row => row.committedAt).sort((a, b) => instant(a) - instant(b))[0] ?? null;
      const profile = inspectProfile(db, target(id), now, [...new Set(admissions.map(row => row.publicUid))]);
      return { ...profile, admissionCommittedAt,
        profileAfterAdmission: profile.realProfileObserved && instant(profile.capturedAt) > instant(admissionCommittedAt),
        isNewTargetSinceBaseline: beforeTargets ? !beforeTargets.has(id) : null };
    });
    const counts = Object.fromEntries(['targets', 'snapshots', 'author_resolution_success_receipts'].map(table =>
      [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
    check('snapshot-count-not-shrunk', counts.snapshots >= BASELINE.snapshots, true);
    check('target-count-not-shrunk', counts.targets >= BASELINE.targets, true);
    check('audit-connection-database-writes', db.prepare('SELECT total_changes() n').get().n, 0);
    const sourceRows = new Map();
    for (const row of job.request.rows) {
      const key = `${row.platform}:${normalize(row.douyinId)}`;
      if (!sourceRows.has(key)) sourceRows.set(key, []); sourceRows.get(key).push(row.sourceRow);
    }
    const notEnabled = allItems.filter(item => item.status !== 'enabled').map(item => {
      const sourceRowNumbers = sourceRows.get(`${item.platform}:${normalize(item.submittedId)}`) || [];
      const preparableSourceRows = sourceRowNumbers.filter(sourceRow => {
        try { return prepareImportAuthorisedDetail(job, { sourceRow }).submittedId === normalize(item.submittedId); }
        catch { return false; }
      });
      return { ...item, sourceRowNumbers, preparableSourceRows };
    });
    report = { format: 'mcn-authorised-import-closeout-v1', startedAt, checkedAt: now.toISOString(), jobId: JOB,
      baseline: BASELINE, baselineTargetIdsAvailable: beforeTargets !== null, checks, issues,
      source: { path: XLSX, sha256: originalFileSha256, rows: parsed.rows.length, selectedSheet: parsed.selectedSheet,
        parserMode: parsed.parserMode, storedRequestRowsUnchanged: sha(stored.request_json) === BASELINE.currentImportRequestSha256,
        note: '原文件及原任务字节hash校验；新解析器可能识别额外官方链接，不改写历史任务。' },
      counts, countDeltaSinceBaseline: { targets: counts.targets - BASELINE.targets, snapshots: counts.snapshots - BASELINE.snapshots },
      monitoring: { checkedAt: status.checkedAt, sourceAvailable: status.sourceAvailable, counts: status.counts, inputRows: status.inputRows,
        enabledDelta: status.counts.enabled - BASELINE.enabled, pendingDelta: status.counts.pending - BASELINE.pending, items: allItems },
      receipts: { checked: receipts.length, valid: receiptAudit.filter(row => row.valid).length, currentJob: currentReceipts.length, items: receiptAudit },
      admittedTargetProfiles: summarizeAdmittedProfiles(profiles),
      notEnabled, auditConnectionWrites: 0, platformRequests: 0, collectionTriggered: false,
      notes: ['加入监控、真实主页三项、完整作品覆盖是三种不同状态。',
        '成功作品身份回执只证明原行作者归属，不提供粉丝/获赞/作品总数采样。',
        '当前脚本核验新增接入账号的主页原文checksum及run/audit时间；不把单条作品身份核验算作全量作品成功。',
        '快照数量增加可能来自系统调度，不全归因于本次接入。数量未减少不证明全部历史内容逐字未变。',
        '基线备份仅只读提取目标ID及核对关键来源指纹；本轮未重扫1.6GB备份全文件哈希。',
        '业务数据库连接只读；本机登录接口可能维护会话状态，cookie/token不写文件、不打印。',
        '平台未提供的历史数据不补零，不伪造采样时间。'] };
  } finally { db.exec('ROLLBACK'); db.close(); }
  report.attemptEvidence = await readAttemptEvidence(job, now);
  const latestAttempts = selectLatestAttempts(report.attemptEvidence.accepted);
  report.notEnabled = report.notEnabled.map(row => ({ ...row, latestAttempt: latestAttempts.get(normalize(row.submittedId)) ?? null }));
  report.http = await inspectHttp(status.counts);
  if (!report.http.health?.ok || !report.http.monitoring?.ok || !report.http.import?.ok) issues.push('local-http-readback-failed');
  if (report.http.import?.ok && !report.http.import.matchesDatabaseRead) issues.push('http-and-db-state-changed-recheck-after-idle');
  if (report.http.monitoring?.browserLane.busy || report.http.monitoring?.scheduler.running) issues.push('collection-active-not-final-idle-audit');
  report.finishedAt = new Date().toISOString(); report.durationMs = Date.parse(report.finishedAt) - Date.parse(startedAt);
  report.auditPassed = issues.length === 0;
  report.allAccountsEnabled = status.counts.enabled === BASELINE.submittedIdentities;
  report.allWorksVerified = false;
  const directory = join(ROOT, 'data/maintenance-journal/20261009-author-detail-investigation',
    `closeout-${report.finishedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { mode: 0o700 });
  const save = (name, value) => writeFile(join(directory, name), value, { flag: 'wx', mode: 0o600 });
  const c = status.counts, p = report.admittedTargetProfiles;
  for (const [name, content] of Object.entries(serializeAuditArtifacts(report))) await save(name, content);
  console.log(JSON.stringify({ output: directory, auditPassed: report.auditPassed, issues, counts: c,
    currentJobReceipts: report.receipts.currentJob, admittedTargetsWithRealProfiles: p.realProfileObserved,
    auditConnectionWrites: 0, allAccountsEnabled: report.allAccountsEnabled, allWorksVerified: false }));
  if (!report.auditPassed) process.exitCode = 1;
}

async function selfTest() {
  assert.equal(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"');
  assert.equal(csvCell(' \t+12'), '"\' \t+12"');
  assert.equal(csvCell('@danger'), '"\'@danger"');
  assert.equal(csvCell('abc,"def"'), '"abc,""def"""');
  assert.equal(csvCell('80336194274', { identifier: true }), '"\'80336194274"');
  assert.equal(checkCounts({ submittedIdentities: 2, enabled: 1, paused: 0, pending: 1, conflict: 0, unknown: 0,
    freshProfiles: 0, staleProfiles: 0, missingProfiles: 1, invalidProfiles: 0 }), true);
  assert.equal(checkCounts({ submittedIdentities: 394, enabled: 394 }), false);
  assert.deepEqual(inspectReceipt({ id: 1, payload_json: '{}', receipt_sha256: 'x' }, { id: JOB }, null),
    { id: 1, valid: false, code: 'invalid-success-proof' });
  const source = { sourceRow: 682, platform: 'douyin', name: '测试作者', douyinId: '80336194274',
    videoId: '7686424948055891786', videoLink: 'https://www.douyin.com/video/7686424948055891786', status: 'resolvable' };
  const job = { id: JOB, status: 'completed', fileName: 'fixture.xlsx', sheetName: '作者', request: { rows: [source] } };
  const input = prepareImportAuthorisedDetail(job, { sourceRow: 682 });
  const attemptPlan = { jobId: JOB, items: [{ ...input, sourceRow: 682 }] };
  const failedAttempt = { ...input, sourceRow: 682, at: '2026-10-09T01:00:00.000Z', finishedAt: '2026-10-09T01:00:03.000Z',
    status: 200, data: { jobId: JOB, sourceRow: 682, monitoringChanged: false,
      result: { ...input, status: 'unavailable', errorCode: 'invalid_evidence',
        requestStartedAt: '2026-10-09T01:00:00.100Z', requestFinishedAt: '2026-10-09T01:00:02.000Z' } } };
  const freshAttempt = inspectAttempt(failedAttempt, job, { plan: attemptPlan, file: 'fixture-later.json', fileSourceRow: 682 });
  assert.equal(freshAttempt?.code, 'invalid_evidence');
  assert.equal(freshAttempt.sourceRowSha256, jsonSha(source));
  assert.equal(freshAttempt.identityAdmissionProof, false);
  assert.equal(inspectAttempt(failedAttempt, job, { plan: { ...attemptPlan, jobId: OLD_JOB } }), null);
  assert.equal(inspectAttempt({ ...failedAttempt, key: 'forged' }, job, { plan: attemptPlan }), null);
  assert.equal(inspectAttempt({ ...failedAttempt, submittedId: 'another-author' }, job, { plan: attemptPlan }), null);
  assert.equal(inspectAttempt(failedAttempt, job, { fileSourceRow: 683 }), null);
  assert.equal(inspectAttempt({ ...failedAttempt, data: { ...failedAttempt.data, jobId: OLD_JOB } }, job), null);
  assert.equal(inspectAttempt({ ...failedAttempt, data: { ...failedAttempt.data, monitoringChanged: true } }, job), null);
  assert.equal(inspectAttempt({ ...failedAttempt, data: { ...failedAttempt.data,
    result: { ...failedAttempt.data.result, candidate: {} } } }, job), null);
  const oldFailure = { ...input, sourceRow: 682, at: '2026-10-09T00:59:00.000Z', finishedAt: '2026-10-09T00:59:03.000Z',
    status: 503, data: { code: 'request_error', error: 'must never be copied into the output' } };
  assert.equal(inspectAttempt(oldFailure, job), null);
  const oldAttempt = inspectAttempt(oldFailure, job, { plan: attemptPlan, file: 'fixture-earlier.json' });
  assert.equal(oldAttempt.code, 'local_service_error');
  assert.equal(JSON.stringify(oldAttempt).includes(oldFailure.data.error), false);
  assert.equal(selectLatestAttempts([freshAttempt, oldAttempt]).get(input.submittedId).code, 'invalid_evidence');
  assert.equal(selectLatestAttempts([oldAttempt, freshAttempt]).get(input.submittedId).code, 'invalid_evidence');
  const admission = '2026-10-09T01:00:03.000Z';
  const sampled = { enabled: true, isNewTargetSinceBaseline: true, realProfileObserved: true, fresh8h: true,
    admissionCommittedAt: admission, capturedAt: '2026-10-09T01:00:04.000Z' };
  const profileSummary = summarizeAdmittedProfiles([sampled,
    { ...sampled, capturedAt: '2026-10-09T01:00:02.000Z' }, { ...sampled, capturedAt: admission },
    { ...sampled, realProfileObserved: false }, { ...sampled, isNewTargetSinceBaseline: false }]);
  assert.equal(profileSummary.newTargets, 4); assert.equal(profileSummary.newTargetsWithProfile, 1);
  assert.equal(profileSummary.newTargetsAwaitingProfile, 3); assert.equal(profileSummary.realProfileObserved, 4);
  const artifactFixture = { finishedAt: '2026-10-09T01:05:00.000Z', source: { rows: 2 }, issues: [], auditPassed: true,
    monitoring: { counts: { submittedIdentities: 2, enabled: 0, paused: 0, pending: 2, conflict: 0, unknown: 0,
      freshProfiles: 0, staleProfiles: 0, missingProfiles: 0, invalidProfiles: 0 } }, receipts: { currentJob: 1 },
    admittedTargetProfiles: profileSummary, notEnabled: [
      { platform: 'douyin', submittedId: input.submittedId, name: '=unsafe-name', status: 'pending', profileStatus: 'not_enabled',
        targetId: null, sourceRows: 1, sourceRowNumbers: [682], reason: '尚未关联', latestAttempt: freshAttempt },
      { platform: 'douyin', submittedId: 'other', name: '作者二', status: 'pending', profileStatus: 'not_enabled',
        sourceRows: 1, sourceRowNumbers: [683], reason: '尚未关联', latestAttempt: null }] };
  const artifacts = serializeAuditArtifacts(artifactFixture);
  assert.deepEqual(JSON.parse(artifacts['audit.json']), artifactFixture);
  assert.equal(artifacts['audit.json'].endsWith('\n'), true);
  const csvBytes = Buffer.from(artifacts['not-enabled-authors.csv']);
  assert.deepEqual([...csvBytes.subarray(0, 3)], [239, 187, 191]);
  const csvLines = artifacts['not-enabled-authors.csv'].split('\r\n');
  assert.equal(csvLines.length, 4); assert.equal(csvLines.at(-1), '');
  assert.equal(csvLines[1].includes('"\'=unsafe-name"'), true);
  assert.equal(csvLines[1].includes(freshAttempt.attemptedAt), true);
  assert.equal(csvLines[2].includes(attemptReasons.not_attempted), true);
  assert.equal(artifacts['report.md'].startsWith('# 本轮监控接入对账\n\n'), true);
  assert.equal(artifacts['report.md'].includes('接入提交后已有真实主页采样 1'), true);
  assert.equal(artifacts['report.md'].includes('\\n'), false);
  const canonical = 'MS4wLjABAAAAauditFixturePublicAuthor123456';
  const observedAt = '2026-10-09T01:00:01.000Z', response = { status_code: 0, aweme_detail: { aweme_id: source.videoId,
    author: { sec_uid: canonical, uid: '3206642319507007', unique_id: source.douyinId, short_id: source.douyinId } } };
  const evidence = { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com',
    path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200, requestedVideoId: source.videoId,
    observedAt, responseSha256: jsonSha(response), responseSha256Scope: 'public-identity-projection-v1', response };
  const natural = { format: 'mcn-authorised-detail-admission-v1', scope: 'one-queue-all-submitted-work-evidence',
    identityOnly: true, metricsSampled: false, allAccountWorksCollected: false,
    source: { jobId: JOB, sourceRow: 682, fileName: job.fileName, sheetName: job.sheetName,
      sourceRowSha256: jsonSha(source), evidenceRequestKey: input.key },
    queue: { id: 7, identityKey: input.key, evidenceVersion: 1, verificationPolicyVersion: 2,
      videoIds: [source.videoId], shareUrls: [], sourceRows: [682] },
    requestStartedAt: '2026-10-09T01:00:00.000Z', requestFinishedAt: '2026-10-09T01:00:02.000Z', observedAt,
    responseSha256: evidence.responseSha256, responseSha256Scope: evidence.responseSha256Scope, evidence,
    provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true,
      authenticated: null, authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false } };
  const verified = [{ videoId: source.videoId, canonicalAccountId: canonical }];
  const proof = { format: 'mcn-author-resolution-success-v1', queueId: 7, evidenceVersion: 1, identityKey: input.key,
    targetId: 10, platform: 'douyin', canonicalAccountId: canonical, verifiedAt: observedAt,
    committedAt: '2026-10-09T01:00:03.000Z', verificationPolicyVersion: 2,
    evidence: { douyinId: source.douyinId, videoIds: [source.videoId], shareUrls: [] },
    resolution: { mode: 'public-video-detail', platform: 'douyin', canonicalAccountId: canonical, publicDouyinId: source.douyinId,
      verificationPolicy: 'all-submitted-evidence-v2', resolvedAt: observedAt, verifiedEvidenceCount: 1,
      verifiedEvidence: verified, verifiedEvidenceSha256: jsonSha(verified), authorisedDetailReceipt: natural } };
  const saved = { id: 1, queue_id: 7, evidence_version: 1, identity_key: input.key, target_id: 10, platform: 'douyin',
    canonical_account_id: canonical, verified_at: observedAt, receipt_sha256: jsonSha(proof), payload_json: JSON.stringify(proof) };
  const target = { id: 10, type: 'account', locator: canonical, enabled: 1, metadata_json: '{"platform":"douyin"}' };
  assert.equal(inspectReceipt(saved, job, target).valid, true);
  assert.equal(inspectReceipt(saved, job, { ...target, locator: canonical + 'other' }).valid, false);
  const changed = structuredClone(proof); changed.resolution.authorisedDetailReceipt.source.sourceRowSha256 = 'f'.repeat(64);
  assert.equal(inspectReceipt({ ...saved, receipt_sha256: jsonSha(changed), payload_json: JSON.stringify(changed) }, job, target).valid, false);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE master_roster_entries(import_id INTEGER,entry_key TEXT,target_id INTEGER,payload_json TEXT)');
    db.prepare('INSERT INTO master_roster_entries VALUES(?,?,?,?)').run(1, 'a', null, '{}');
    const before = db.prepare('SELECT total_changes() n').get().n;
    assert.equal(frozenHash(db), jsonSha([{ import_id: 1, entry_key: 'a', target_id: null, payload_json: '{}' }]));
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  } finally { db.close(); }
  console.log(JSON.stringify({ selfTest: 'passed', coverage: ['source-bound-attempts', 'later-result-over-old-503',
    'new-target-post-admission-profile', 'real-utf8-bom-crlf-csv', 'json-parse', 'multiline-markdown', 'formula-safe-csv',
    'immutable-receipts', 'read-only-sqlite-fixture'], productionReads: 0, productionWrites: 0, networkRequests: 0 }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') await selfTest();
  else if (process.argv.length === 2) {
    try { await audit(); }
    catch { console.error(JSON.stringify({ auditPassed: false, code: 'closeout-audit-incomplete', productionWrites: 0,
      note: '未输出未完成的成功报告；未保留底层错误原文或凭据。' })); process.exitCode = 1; }
  } else { console.error('仅支持无参数只读对账，或 --self-test 离线自测'); process.exitCode = 2; }
}

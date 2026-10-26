#!/usr/bin/env node
// Explicit one-shot repair for four independently reviewed source rows only.
// plan/readback are read-only. stage/finish mutate only through the guarded
// loopback product APIs, never SQL; finish makes at most one natural probe per
// row. Candidate observations are not promoted into admission evidence.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareImportWorkAuthorCandidate, validateWorkAuthorCandidateResult } from '../lib/douyin-work-author-candidate.mjs';
import { prepareImportAuthorisedDetail } from '../lib/import-authorised-detail.mjs';
import { validateAuthorisedDetailResult } from '../lib/douyin-authorised-detail.mjs';
import { readMasterRoster, readMasterRosterEntry } from '../lib/master-roster.mjs';
import { assertMasterRosterSupplementJob, validatedSuccessProof } from '../lib/master-roster-supplement.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'data/maintenance-journal/20261009-id-correction');
const DISCOVERY = join(OUT, 'candidate-discovery-1791573010441');
const ORIGIN = 'http://127.0.0.1:4188';
const SOURCE_JOB = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f';
const SOURCE_FILE = '/Users/tyke/Downloads/一条小团团切片作品登记表.xlsx';
const SPEC = Object.freeze([{ sourceRow: 294, correctedAccountId: '96163534600', targetId: 1023 },
  { sourceRow: 1532, correctedAccountId: '64619246264', targetId: 1194 },
  { sourceRow: 1724, correctedAccountId: '96922252782', targetId: 14953 },
  { sourceRow: 2045, correctedAccountId: 'yiyayiya_youya', targetId: 15085 }]);
const EXPECTED = Object.freeze({ sourceFileSha256: '88bf7c4c50ac9031c8749254e791bb512306c44c564e65db576c6f84e755a3bb',
  sourceRequestSha256: '17732e521fba518599b2d4f85046ff045b5d4846e8bc8c5553e9f14b102e8fa2',
  sourceResultSha256: '0f8eb53b4db589762ccab9ffafb112a2e112c76de82b1e0ab6a2eb544d97cd22',
  frozenSha256: '5e7b062105a441ea48febf674949229bbb908b6ce4bb5f25eb26e48032db0ab2' });
const FROZEN_SQL = 'SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = text => createHash('sha256').update(text).digest('hex');
const jsonSha = value => sha(JSON.stringify(value));
const id = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
const parsedJob = stored => ({ ...stored, request: JSON.parse(stored.request_json), result: JSON.parse(stored.result_json || 'null') });
const withoutResolution = text => { const { resolution, ...fields } = JSON.parse(text); return fields; };
const exists = async file => lstat(file).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const load = async file => { const info = await lstat(file); assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.ok(info.size <= 10 * 1024 * 1024); return JSON.parse(await readFile(file, 'utf8')); };

function withRead(fn) {
  const db = new DatabaseSync(join(ROOT, 'data/douyin-monitor.sqlite'), { readOnly: true });
  try { db.exec('PRAGMA query_only=ON; BEGIN'); const result = fn(db);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, 0); db.exec('ROLLBACK'); return result;
  } finally { db.close(); }
}
function immutable(db) {
  const stored = db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(SOURCE_JOB);
  assert.equal(stored?.status, 'completed');
  const value = { sourceRequestSha256: sha(stored.request_json), sourceResultSha256: sha(stored.result_json),
    frozenSha256: jsonSha(db.prepare(FROZEN_SQL).all()) };
  for (const [key, hash] of Object.entries(value)) assert.equal(hash, EXPECTED[key], `${key} changed`);
  return { stored, job: parsedJob(stored), hashes: value };
}
function assertTarget(db, item, { full = false } = {}) {
  const target = db.prepare('SELECT * FROM targets WHERE id=?').get(item.targetId);
  assert.ok(target); assert.equal(target.enabled, 1); assert.equal(target.provider, 'public-web'); assert.equal(target.type, 'account');
  assert.equal(target.locator, item.canonicalAccountId);
  assert.equal(JSON.parse(target.metadata_json).platform ?? 'douyin', 'douyin');
  const matches = db.prepare("SELECT id FROM targets WHERE type='account' AND locator=?").all(target.locator);
  assert.deepEqual(matches.map(value => value.id), [target.id], 'canonical target must be unique');
  if (item.targetBaseline) {
    for (const key of ['id', 'label', 'locator', 'provider', 'type', 'enabled']) assert.deepEqual(target[key], item.targetBaseline[key]);
    assert.deepEqual(withoutResolution(target.metadata_json), withoutResolution(item.targetBaseline.metadata_json));
    if (full) assert.deepEqual(target, item.targetBaseline, 'target changed since plan; re-review before staging');
  }
  return target;
}
async function sourceMaterials() {
  assert.equal(sha(await readFile(SOURCE_FILE)), EXPECTED.sourceFileSha256, 'original XLSX changed');
  const materials = [];
  for (const spec of SPEC) {
    const file = join(DISCOVERY, `row-${spec.sourceRow}.json`), bytes = await readFile(file);
    materials.push({ spec, file, fileSha256: sha(bytes), saved: JSON.parse(bytes.toString('utf8')) });
  }
  return materials;
}
function candidate(db, material, originalJob) {
  const { spec, saved } = material;
  assert.equal(saved.sourceRow, spec.sourceRow);
  const input = prepareImportWorkAuthorCandidate(originalJob, { sourceRow: spec.sourceRow });
  assert.deepEqual(saved.input, input);
  const observed = validateWorkAuthorCandidateResult(input, saved.result, { startedAt: saved.startedAt, finishedAt: saved.finishedAt });
  assert.equal(observed.status, 'candidate-only'); assert.equal(observed.monitoringEnabled, false);
  assert.ok([observed.candidate.uniqueId, observed.candidate.shortId].map(id).includes(spec.correctedAccountId));
  const original = originalJob.request.rows.find(row => row.sourceRow === spec.sourceRow);
  assert.equal(saved.originalSubmittedId, original.douyinId);
  const item = { ...spec, originalAccountId: original.douyinId, canonicalAccountId: observed.candidate.secUid,
    source: input.source, sourceInput: input, evidence: input.shareUrl || `https://www.douyin.com/video/${input.videoId}`,
    candidateFile: material.file, candidateFileSha256: material.fileSha256, candidateObservedAt: observed.candidate.observedAt,
    candidateUid: observed.candidate.uid };
  assertTarget(db, item); return item;
}
function unboundEntry(db, item, roster) {
  const matches = roster.items.filter(entry => entry.accountIds?.some(value => id(value) === id(item.originalAccountId)));
  assert.equal(matches.length, 1, 'original source must identify one frozen entry');
  const entry = matches[0]; assert.equal(entry.monitorStatus, 'pending'); assert.equal(entry.targetId, null);
  assert.equal(entry.identityCorrection, undefined, 'an existing correction must not be overwritten');
  assert.equal(entry.supplement, undefined, 'existing supplement must be reviewed before reuse');
  const stored = readMasterRosterEntry(db, { workbookSha256: roster.workbook.sha256, entryKey: entry.key });
  assert.equal(stored.supplementState, null); assert.deepEqual(stored.item.accountIds, [item.originalAccountId]);
  assert.equal(stored.item.platform, 'douyin'); assert.equal(stored.item.targetId, null);
  assert.equal(stored.item.locators.length, 0);
  return { entryKey: entry.key, workbookSha256: roster.workbook.sha256, entryPayloadSha256: stored.entryPayloadSha256 };
}
function validatePlan(plan) {
  assert.equal(plan.format, 'mcn-four-source-corrections-20261009-v1'); assert.equal(plan.sourceJobId, SOURCE_JOB);
  const { planSha256, ...body } = plan; assert.equal(planSha256, jsonSha(body));
  assert.deepEqual(plan.sourceHashes, EXPECTED); assert.equal(plan.items.length, SPEC.length);
  plan.items.forEach((item, index) => { assert.deepEqual(Object.fromEntries(Object.keys(SPEC[index]).map(key => [key, item[key]])), SPEC[index]);
    assert.match(item.idempotencyKey, UUID); assert.ok(item.targetBaseline); });
  return plan;
}
async function planMode() {
  const materials = await sourceMaterials();
  const plan = withRead(db => {
    const { job, hashes } = immutable(db), roster = readMasterRoster(db); assert.ok(roster);
    const items = materials.map(material => { const item = candidate(db, material, job); return { ...item,
      ...unboundEntry(db, item, roster), targetBaseline: assertTarget(db, item), idempotencyKey: randomUUID() }; });
    return { format: 'mcn-four-source-corrections-20261009-v1', createdAt: new Date().toISOString(), sourceJobId: SOURCE_JOB,
      sourceHashes: { sourceFileSha256: EXPECTED.sourceFileSha256, ...hashes }, sourceRequest: job.request_json,
      sourceResult: job.result_json, items, candidateOnly: true, snapshotsRequested: false };
  });
  plan.planSha256 = jsonSha(plan);
  const directory = join(OUT, `four-corrections-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: false, mode: 0o700 }); await save(join(directory, 'plan.json'), plan);
  console.log(JSON.stringify({ directory, mode: 'plan', rows: plan.items.map(value => value.sourceRow), productionWrites: 0, requests: 0 }));
}
async function readPlanDirectory(argument) {
  const directory = resolve(argument || '');
  assert.equal(dirname(directory), OUT); assert.match(basename(directory), /^four-corrections-\d+-[a-f0-9]{8}$/);
  const info = await lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
  return { directory, plan: validatePlan(await load(join(directory, 'plan.json'))) };
}
async function recheckSources(plan) {
  const materials = await sourceMaterials();
  withRead(db => { const { job } = immutable(db);
    assert.equal(job.request_json, plan.sourceRequest); assert.equal(job.result_json, plan.sourceResult);
    materials.forEach((material, index) => { const current = candidate(db, material, job), item = plan.items[index];
      for (const key of Object.keys(current)) assert.deepEqual(current[key], item[key], `source candidate ${key} changed`);
      assertTarget(db, item); });
  });
}
async function responseJson(reply) {
  assert.equal(new URL(reply.url).origin, ORIGIN); assert.match(reply.headers.get('content-type') || '', /application\/json/i);
  const text = await reply.text(); assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024); return JSON.parse(text);
}
async function apiSession() {
  const response = await fetch(ORIGIN + '/api/auth/session', { redirect: 'error', signal: AbortSignal.timeout(8000) });
  const data = await responseJson(response); assert.equal(response.status, 200); assert.equal(data.user?.role, 'admin');
  assert.ok(typeof data.csrfToken === 'string' && data.csrfToken);
  const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')];
  const Cookie = cookies.filter(Boolean).map(value => value.split(';')[0]).join('; '); assert.ok(Cookie);
  return { Cookie, Origin: ORIGIN, 'X-CSRF-Token': data.csrfToken, 'Content-Type': 'application/json' };
}
async function postOnce(directory, label, path, body, headers, { timeout = 10_000, idempotencyKey } = {}) {
  const startedAt = new Date().toISOString();
  await save(join(directory, `${label}-intent.json`), { startedAt, path, body, ...(idempotencyKey ? { idempotencyKey } : {}) });
  let value;
  try {
    const response = await fetch(ORIGIN + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { ...headers, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: JSON.stringify(body) });
    value = { startedAt, finishedAt: new Date().toISOString(), status: response.status, data: await responseJson(response) };
  } catch {
    await save(join(directory, `${label}-result.json`), { startedAt, finishedAt: new Date().toISOString(), status: null,
      code: 'local_request_incomplete', retryAllowed: false });
    throw new Error(`${label}: local request incomplete; inspect persisted job, do not automatically retry`);
  }
  await save(join(directory, `${label}-result.json`), value);
  assert.ok(value.status >= 200 && value.status < 300, `${label}: HTTP ${value.status}; no retry`); return value.data;
}
function stagedJob(db, item, jobId) {
  assert.match(jobId, UUID);
  const saved = db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(jobId); assert.ok(saved);
  const job = parsedJob(saved), context = job.request.masterRosterSupplement;
  assert.equal(context.version, 2); assert.equal(context.entryKey, item.entryKey); assert.equal(context.workbookSha256, item.workbookSha256);
  assert.equal(context.entryPayloadSha256, item.entryPayloadSha256); assert.equal(context.evidence, item.evidence);
  assert.deepEqual(context.correction, { originalAccountId: item.originalAccountId, correctedAccountId: item.correctedAccountId });
  assert.equal(job.request.rows.length, 1); assert.equal(job.request.rows[0].sourceRow, 2);
  return job;
}
async function stageMode(directory, plan) {
  await recheckSources(plan); const headers = await apiSession();
  for (const item of plan.items) {
    const label = `row-${item.sourceRow}`, resultFile = join(directory, `${label}-submit-result.json`);
    if (await exists(resultFile)) {
      const saved = await load(resultFile); assert.ok([200, 202].includes(saved.status));
      withRead(db => stagedJob(db, item, saved.data.job.id)); continue;
    }
    // Sampling may legitimately advance operational target timestamps between
    // plan and stage. Keep the identity and user-maintained-field assertions,
    // but do not freeze unrelated runtime columns for this source correction.
    withRead(db => { immutable(db); assertTarget(db, item);
      const current = unboundEntry(db, item, readMasterRoster(db));
      for (const key of Object.keys(current)) assert.equal(current[key], item[key]); });
    const body = { workbookSha256: item.workbookSha256, entryKey: item.entryKey, evidence: item.evidence, correctedAccountId: item.correctedAccountId };
    const preview = await postOnce(directory, `${label}-preview`, '/api/master-roster/supplement/preview', body, headers);
    assert.equal(preview.entry.key, item.entryKey); assert.equal(preview.evidence, item.evidence);
    assert.equal(preview.requiresCorrectionConfirmation, true); assert.equal(preview.review.canSubmit, true);
    assert.deepEqual(preview.correction, { originalAccountId: item.originalAccountId, correctedAccountId: item.correctedAccountId });
    assert.match(preview.previewSha256, /^[a-f0-9]{64}$/);
    const response = await postOnce(directory, `${label}-submit`, '/api/master-roster/supplement',
      { ...body, previewSha256: preview.previewSha256, correctionConfirmed: true }, headers, { idempotencyKey: item.idempotencyKey });
    withRead(db => { immutable(db); stagedJob(db, item, response.job.id); assertTarget(db, item); });
    console.log(JSON.stringify({ mode: 'stage', sourceRow: item.sourceRow, jobId: response.job.id, status: response.job.status }));
  }
}
function readbackOne(db, item, jobId) {
  immutable(db); const target = assertTarget(db, item), job = stagedJob(db, item, jobId);
  assert.equal(job.status, 'completed'); assertMasterRosterSupplementJob(db, job);
  const input = prepareImportAuthorisedDetail(job, { sourceRow: 2 }); assert.equal(input.submittedId, item.correctedAccountId);
  const queue = db.prepare('SELECT * FROM author_resolution_queue WHERE identity_key=?').get(input.key);
  assert.equal(queue?.status, 'resolved'); assert.equal(queue.resolved_target_id, item.targetId);
  const proofs = db.prepare('SELECT * FROM author_resolution_success_receipts WHERE target_id=? ORDER BY id').all(item.targetId)
    .map(saved => ({ saved, proof: validatedSuccessProof(saved) })).filter(({ proof }) => proof?.resolution?.authorisedDetailReceipt?.source?.jobId === jobId);
  assert.equal(proofs.length, 1, 'one exact fresh correction-job receipt is required');
  const { saved, proof } = proofs[0], natural = proof.resolution.authorisedDetailReceipt;
  assert.equal(natural.source.sourceRow, 2); assert.equal(natural.source.sourceRowSha256, jsonSha(job.request.rows[0]));
  assert.equal(natural.source.evidenceRequestKey, input.key); assert.equal(natural.queue.id, queue.id);
  assert.equal(natural.queue.identityKey, input.key); assert.equal(natural.metricsSampled, false); assert.equal(natural.allAccountWorksCollected, false);
  assert.equal(id(proof.evidence.douyinId), item.correctedAccountId); assert.equal(proof.canonicalAccountId, target.locator);
  assert.ok(Date.parse(natural.requestStartedAt) >= Date.parse(job.finished_at));
  assert.ok(Date.parse(natural.observedAt) >= Date.parse(job.finished_at));
  assert.equal(natural.observedAt, proof.verifiedAt);
  const response = natural.evidence.response, author = response.aweme_detail.author;
  const candidate = { videoId: response.aweme_detail.aweme_id, secUid: author.sec_uid, uid: author.uid,
    uniqueId: author.unique_id ?? '', shortId: author.short_id ?? '', provenance: 'authorised-browser-natural-detail',
    observedAt: natural.observedAt, responseSha256: natural.responseSha256, responseSha256Scope: natural.responseSha256Scope };
  const validated = validateAuthorisedDetailResult(input, { status: 'ok', ...input,
    ...(input.shareUrl ? { videoId: candidate.videoId } : {}), candidate, evidence: natural.evidence, provenance: natural.provenance,
    requestStartedAt: natural.requestStartedAt, requestFinishedAt: natural.requestFinishedAt },
  { startedAt: natural.requestStartedAt, finishedAt: natural.requestFinishedAt });
  assert.equal(validated.candidate.secUid, item.canonicalAccountId); assert.equal(validated.candidate.uid, item.candidateUid);
  const entry = readMasterRoster(db).items.find(value => value.key === item.entryKey);
  assert.equal(entry?.monitorStatus, 'enabled'); assert.equal(entry.targetId, item.targetId);
  assert.deepEqual(entry.accountIds, [item.originalAccountId]); assert.deepEqual(entry.originalAccountIds, [item.originalAccountId]);
  assert.deepEqual(entry.identityCorrection, { originalAccountId: item.originalAccountId, correctedAccountId: item.correctedAccountId, status: 'verified' });
  assert.equal(entry.supplement.jobId, jobId);
  return { sourceRow: item.sourceRow, jobId, targetId: target.id, status: 'verified-existing-enabled-target',
    receiptId: saved.id, receiptSha256: saved.receipt_sha256, observedAt: natural.observedAt, committedAt: proof.committedAt,
    originalSourcePreserved: true, userMetadataPreserved: true, metricsSampledByThisProof: false, allAccountWorksCollected: false };
}
async function finishMode(directory, plan) {
  await recheckSources(plan); let headers;
  for (const item of plan.items) {
    const label = `row-${item.sourceRow}`, stage = await load(join(directory, `${label}-submit-result.json`));
    assert.ok([200, 202].includes(stage.status)); const jobId = stage.data.job.id;
    const state = withRead(db => {
      immutable(db); assertTarget(db, item); const job = stagedJob(db, item, jobId);
      assert.equal(job.status, 'completed'); assertMasterRosterSupplementJob(db, job);
      const input = prepareImportAuthorisedDetail(job, { sourceRow: 2 });
      assert.equal(input.submittedId, item.correctedAccountId);
      const queue = db.prepare('SELECT * FROM author_resolution_queue WHERE identity_key=?').get(input.key); assert.ok(queue);
      if (queue.status === 'resolved') return { alreadyResolved: true, report: readbackOne(db, item, jobId) };
      assert.equal(queue.status, 'pending'); assert.equal(queue.attempts, 0); assert.equal(queue.lease_owner, null); assert.equal(queue.lease_until, null);
      assert.equal(queue.resolved_target_id, null); assert.ok(queue.suspended_target_enabled === null || queue.suspended_target_enabled === '');
      assert.equal(db.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','queued')").get().n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n, 0);
      return { alreadyResolved: false };
    });
    if (state.alreadyResolved) { console.log(JSON.stringify({ ...state.report, skipped: 'already-verified-no-repeat' })); continue; }
    // wx intent is a fail-closed once-only guard, including unknown HTTP outcomes.
    headers ||= await apiSession();
    const data = await postOnce(directory, `${label}-monitor`, `/api/author-spreadsheet/jobs/${jobId}/authorised-monitor`,
      { sourceRow: 2 }, headers, { timeout: 55_000 });
    assert.equal(data.result?.status, 'ok', 'fresh strict check failed; no retry'); assert.equal(data.admission?.target?.id, item.targetId);
    const report = withRead(db => readbackOne(db, item, jobId));
    await save(join(directory, `${label}-readback.json`), report); console.log(JSON.stringify(report));
    // The product imposes a five-second cooldown after each strict probe.
    // This is successful-action pacing, never a retry after failure; the next
    // loop still rechecks the live queue, target, runs and all leases.
    if (item !== plan.items.at(-1)) await delay(5200);
  }
  await recheckSources(plan);
}
async function readbackMode(directory, plan) {
  await recheckSources(plan); const jobs = [];
  for (const item of plan.items) { const saved = await load(join(directory, `row-${item.sourceRow}-submit-result.json`));
    assert.ok([200, 202].includes(saved.status)); jobs.push(saved.data.job.id); }
  const reports = withRead(db => plan.items.map((item, index) => readbackOne(db, item, jobs[index])));
  const file = join(directory, `readback-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await save(file, { at: new Date().toISOString(), sourceHashes: plan.sourceHashes, reports, auditWrites: 0 });
  console.log(JSON.stringify({ file, verified: reports.length, productionWrites: 0, requests: 0 }));
}
function selfTest() {
  const items = SPEC.map(item => ({ ...item, idempotencyKey: randomUUID(), targetBaseline: { id: item.targetId } }));
  const plan = { format: 'mcn-four-source-corrections-20261009-v1', sourceJobId: SOURCE_JOB, sourceHashes: EXPECTED, items };
  plan.planSha256 = jsonSha(plan); assert.equal(validatePlan(plan), plan);
  const changed = structuredClone(plan); changed.items[0].targetId = 1; delete changed.planSha256; changed.planSha256 = jsonSha(changed);
  assert.throws(() => validatePlan(changed));
  assert.deepEqual(withoutResolution('{"name":"保留用户资料","resolution":{"new":true}}'), { name: '保留用户资料' });
  assert.equal(id('Yiyayiya_youya'), 'yiyayiya_youya');
  console.log(JSON.stringify({ selfTest: 'passed', productionReads: 0, productionWrites: 0, networkRequests: 0 }));
}
const mode = process.argv[2] || 'plan';
try {
  assert.ok(['plan', 'stage', 'finish', 'readback', '--self-test'].includes(mode));
  if (mode === '--self-test') selfTest();
  else if (mode === 'plan') await planMode();
  else { const { directory, plan } = await readPlanDirectory(process.argv[3]);
    if (mode === 'stage') await stageMode(directory, plan);
    else if (mode === 'finish') await finishMode(directory, plan);
    else await readbackMode(directory, plan); }
} catch (error) {
  // No session, upstream body, or arbitrary response is printed to the console.
  console.error(JSON.stringify({ mode, stopped: true, reason: error instanceof assert.AssertionError ? 'verification_failed' : 'operation_incomplete',
    check: error instanceof assert.AssertionError ? String(error.message).slice(0, 240) : String(error.code || 'operation-incomplete'),
    where: error instanceof assert.AssertionError ? String(error.stack || '').split('\n').find(line => line.includes('complete-four-source-corrections'))?.trim() : undefined,
    message: '已停止；请审查本地追加证据。失败或不确定结果不会自动重试。' })); process.exitCode = 1;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MonitorDatabase, normalizeBoardKey, normalizeBoardName } from '../lib/database.mjs';
import { normalizePlatform, normalizeAccountLocator, validateSubmittedAccountId } from '../lib/author-spreadsheet.mjs';
import { prepareAuthorBoardImport } from '../lib/author-board-import.mjs';
import { buildAuthorEvidenceRequests, verifyQueuedAuthorEvidence } from '../lib/author-resolution.mjs';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster, readMasterRosterEntry } from '../lib/master-roster.mjs';
import { prepareMasterRosterSupplement, assertMasterRosterSupplementJob, buildMasterRosterSupplementReceipt, masterRosterSupplementRequestSha256 } from '../lib/master-roster-supplement.mjs';

const SEC = 'MS4wLjABAAAAabcdefghijklmnopqrstuvwx';
const OTHER = 'MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba';
const HASH = 'a'.repeat(64);
const VIDEO = '7684617087687331118';
const URL = `https://www.douyin.com/video/${VIDEO}`;
function fixture(t, overrides = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,metadata_json TEXT,locator TEXT,label TEXT,enabled INTEGER);
    CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,status TEXT,request_json TEXT,result_json TEXT,created_at TEXT,finished_at TEXT,error TEXT);`);
  const entity = { key: 'submitted:douyin:source-row-2', targetId: null, platform: 'douyin', names: ['原始名称'], ids: [], locators: [],
    sources: [{ url: 'https://fixture.feishu.cn/sheets/Book', title: '原始来源', file: '原表.xlsx', rows: ['12'], revision: 7 }],
    boards: [{ name: '一条小团团切片矩阵', category: '切片' }], classification: { theme: { key: 'tuantuan', label: '团团' }, labels: [{ key: 'slice', label: '切片' }] }, ...overrides };
  const snapshot = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:01:23.853Z', entities: [entity] }, { sha256: HASH, fileName: '总表.xlsx' });
  installMasterRoster(db, snapshot);
  return { db, snapshot, entryKey: snapshot.items[0].key, original: () => db.prepare('SELECT * FROM master_roster_entries').get(),
    input: evidence => ({ workbookSha256: HASH, entryKey: snapshot.items[0].key, evidence }) };
}
function addTarget(f, id = 1, locator = SEC, metadata = {}, enabled = 1) {
  f.db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?,?)').run(id, 'account', 'public-web', JSON.stringify({ platform: 'douyin', ...metadata }), locator, '当前名称', enabled);
}
function jobFor(prepared, id = 'fixture-job') {
  return { id, status: 'running', request: { rows: prepared.rows, fileName: prepared.fileName, sheetName: prepared.sheetName,
    boardCatalog: prepared.boardCatalog, masterRosterSupplement: prepared.masterRosterSupplement }, createdAt: new Date().toISOString() };
}
function persist(f, job, result, status = 'completed') {
  f.db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?,?,?)').run(job.id, status, JSON.stringify(job.request), JSON.stringify(result), job.createdAt, new Date().toISOString(), null);
}
function resultFor(id = 1, locator = SEC) { return { ok: true, identityConflictCount: 0, created: [{ id, locator }], skipped: [] }; }

test('a completed dedicated supplement closes the roster without rewriting original evidence or inventing snapshots', async t => {
  const f = fixture(t), before = f.original();
  const prepared = await prepareMasterRosterSupplement(f.db, f.input(`https://www.douyin.com/user/${SEC}`));
  assert.equal(prepared.preview.review.canSubmit, true);
  assert.equal(prepared.sheetName, 'CSV');
  assert.deepEqual(prepared.preview.entry.theme, { key: 'tuantuan', label: '团团' });
  assert.equal(prepared.rows[0].boards[0].category, '切片');
  assert.ok(!Object.hasOwn(prepared, 'sourceRevision'), 'manual supplements cannot impersonate a new cloud read');
  assert.notEqual(prepared.fileName, '原表.xlsx');
  addTarget(f, 1, SEC, {}, 0);
  const job = jobFor(prepared), result = resultFor();
  const receipt = buildMasterRosterSupplementReceipt(f.db, job, prepared.rows, result);
  assert.equal(receipt.proofType, 'user-supplied-canonical-profile');
  persist(f, job, { ...result, masterRosterSupplementReceipt: receipt });
  const read = readMasterRoster(f.db);
  assert.equal(read.items[0].targetId, 1);
  assert.equal(read.items[0].monitorStatus, 'paused');
  assert.equal(read.items[0].supplement.status, 'linked');
  assert.equal(read.items[0].sources[0].rows[0], '12');
  assert.ok(!Object.hasOwn(read.items[0], 'metrics'));
  assert.deepEqual(f.original(), before);
  assert.equal(installMasterRoster(f.db, f.snapshot).imported, false);
});

test('merely creating a same-locator target cannot promote the preserved pending snapshot', t => {
  const f = fixture(t, { locators: [SEC] }); addTarget(f);
  assert.equal(readMasterRoster(f.db).items[0].targetId, null);
});

test('historical identity conflict, different platform and changed original anchor are rejected', async t => {
  const f = fixture(t, { errors: ['公开视频作者与提交的抖音号/昵称不一致'] });
  await assert.rejects(prepareMasterRosterSupplement(f.db, f.input(SEC)), error => error.status === 409);
  const clean = fixture(t, { locators: [SEC] });
  await assert.rejects(prepareMasterRosterSupplement(clean.db, clean.input(OTHER)), error => error.status === 409);
  await assert.rejects(prepareMasterRosterSupplement(clean.db, clean.input('https://space.bilibili.com/12345')), error => error.status === 400);
  assert.throws(() => readMasterRosterEntry(clean.db, { workbookSha256: 'b'.repeat(64), entryKey: clean.entryKey }), error => error.status === 409);
});

test('submitted Douyin handle cannot be joined to an unverified profile just because a user pasted it', async t => {
  const f = fixture(t, { ids: ['original_handle'] });
  const prepared = await prepareMasterRosterSupplement(f.db, f.input(SEC));
  assert.equal(prepared.preview.review.canSubmit, false);
  assert.match(prepared.preview.review.reason, /作品|分享/);
  addTarget(f);
  assert.equal(buildMasterRosterSupplementReceipt(f.db, jobFor(prepared), prepared.rows, resultFor()), null);
  const work = await prepareMasterRosterSupplement(f.db, f.input(URL));
  assert.equal(work.preview.review.canSubmit, true);
  assert.equal(work.rows[0].douyinId, 'original_handle');
});

test('strict successful work proof binds only the submitted public ID and canonical author', async t => {
  const f = fixture(t, { ids: ['original_handle'] });
  const prepared = await prepareMasterRosterSupplement(f.db, f.input(URL));
  addTarget(f);
  const job = jobFor(prepared), result = resultFor();
  const ready = { ...prepared.rows[0], status: 'ready', locator: SEC, resolution: { mode: 'public-video-detail', platform: 'douyin', canonicalAccountId: SEC,
    publicDouyinId: 'original_handle', evidenceVideoId: VIDEO, resolvedAt: new Date().toISOString() } };
  const receipt = buildMasterRosterSupplementReceipt(f.db, job, [ready], result);
  assert.equal(receipt.proofType, 'strict-public-work-evidence');
  assert.equal(buildMasterRosterSupplementReceipt(f.db, job, [{ ...ready, resolution: { ...ready.resolution, publicDouyinId: 'another' } }], result), null);
  assert.equal(buildMasterRosterSupplementReceipt(f.db, job, [{ ...ready, resolution: undefined }], result), null);
  persist(f, job, { ...result, masterRosterSupplementReceipt: receipt });
  assert.equal(readMasterRoster(f.db).summary.registered, 1);
});

test('failed, queued and unresolved completed jobs remain pending and expose safe action status', async t => {
  const f = fixture(t), prepared = await prepareMasterRosterSupplement(f.db, f.input(URL));
  const job = jobFor(prepared); addTarget(f);
  assert.equal(buildMasterRosterSupplementReceipt(f.db, job, prepared.rows, { ok: true, created: [], skipped: [{ status: 'unresolved' }] }), null);
  persist(f, job, { ok: true, queuedEvidenceRequestCount: 1 }, 'completed');
  const read = readMasterRoster(f.db);
  assert.equal(read.items[0].targetId, null);
  assert.equal(read.items[0].supplement.status, 'awaiting-verification');
});

test('generic success, forged context, changed request or changed target cannot bind a roster', async t => {
  const f = fixture(t), prepared = await prepareMasterRosterSupplement(f.db, f.input(SEC));
  addTarget(f);
  const job = jobFor(prepared), result = resultFor();
  const receipt = buildMasterRosterSupplementReceipt(f.db, job, prepared.rows, result);
  const changed = structuredClone(job); changed.request.rows[0].locator = OTHER;
  assert.equal(buildMasterRosterSupplementReceipt(f.db, changed, [{ ...prepared.rows[0], locator: OTHER }], result), null);
  const noContext = structuredClone(job); delete noContext.request.masterRosterSupplement;
  assert.equal(buildMasterRosterSupplementReceipt(f.db, noContext, prepared.rows, result), null);
  persist(f, job, { ...result, masterRosterSupplementReceipt: { ...receipt, entryPayloadSha256: 'b'.repeat(64) } });
  assert.equal(readMasterRoster(f.db).items[0].targetId, null);
  f.db.prepare('UPDATE author_resolution_jobs SET result_json=?').run(JSON.stringify({ ...result, masterRosterSupplementReceipt: receipt }));
  assert.equal(readMasterRoster(f.db).items[0].targetId, 1);
  f.db.prepare('UPDATE targets SET locator=?').run(OTHER);
  assert.equal(readMasterRoster(f.db).items[0].targetId, null);
});

test('request hash is stable across sanitized empty fields and ready/existing reasons but not identity/boards', async t => {
  const f = fixture(t), prepared = await prepareMasterRosterSupplement(f.db, f.input(SEC));
  const copied = structuredClone(prepared.rows); copied[0].status = 'existing'; copied[0].reason = 'already known'; copied[0].owner = '';
  assert.equal(masterRosterSupplementRequestSha256(copied), prepared.masterRosterSupplement.requestSha256);
  copied[0].boards[0].name = '其他主题';
  assert.notEqual(masterRosterSupplementRequestSha256(copied), prepared.masterRosterSupplement.requestSha256);
});

test('a linked entry rejects different evidence, permits exact replay and concurrent divergent receipts fail closed', async t => {
  const f = fixture(t), prepared = await prepareMasterRosterSupplement(f.db, f.input(SEC));
  const other = await prepareMasterRosterSupplement(f.db, f.input(OTHER));
  addTarget(f); addTarget(f, 2, OTHER);
  const first = jobFor(prepared, 'first'), second = jobFor(other, 'second');
  const receipt1 = buildMasterRosterSupplementReceipt(f.db, first, prepared.rows, resultFor());
  const receipt2 = buildMasterRosterSupplementReceipt(f.db, second, other.rows, resultFor(2, OTHER));
  persist(f, first, { ...resultFor(), masterRosterSupplementReceipt: receipt1 });
  await assert.rejects(prepareMasterRosterSupplement(f.db, f.input(OTHER)), error => error.status === 409);
  assert.equal((await prepareMasterRosterSupplement(f.db, f.input(SEC))).preview.review.canSubmit, true);
  assert.equal(buildMasterRosterSupplementReceipt(f.db, second, other.rows, resultFor(2, OTHER)), null);
  persist(f, second, { ...resultFor(2, OTHER), masterRosterSupplementReceipt: receipt2 });
  const read = readMasterRoster(f.db);
  assert.equal(read.items[0].targetId, null);
  assert.equal(read.items[0].supplement.status, 'conflict');
});

test('unsafe links never reach the worker and registered originals cannot be supplemented', async t => {
  const f = fixture(t);
  for (const evidence of ['http://127.0.0.1/a', 'https://evil.test/video/123', `https://user:pass@www.douyin.com/user/${SEC}`, `${URL}?access_token=[REDACTED] {
    await assert.rejects(prepareMasterRosterSupplement(f.db, f.input(evidence)), error => error.status === 400);
  }
  await assert.rejects(prepareMasterRosterSupplement(f.db, { ...f.input(SEC), entryKey: 'missing' }), error => error.status === 404);
});

test('Bilibili canonical UID and Xiaohongshu canonical ID use their platform without nickname inference', async t => {
  for (const [platform, evidence, expected] of [['bilibili', '123456', '123456'], ['xiaohongshu', '5abcdef01234567890abcd12', 'https://www.xiaohongshu.com/user/profile/5abcdef01234567890abcd12']]) {
    const f = fixture(t, { platform, ids: [] });
    const prepared = await prepareMasterRosterSupplement(f.db, f.input(evidence));
    assert.equal(prepared.preview.review.canSubmit, true);
    assert.equal(prepared.rows[0].locator, expected);
    assert.equal(prepared.rows[0].platform, platform);
    f.db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?,?)').run(1, 'account', 'public-web', JSON.stringify({ platform }), expected, '当前平台账号', 1);
    const job = jobFor(prepared), result = resultFor(1, expected);
    const receipt = buildMasterRosterSupplementReceipt(f.db, job, prepared.rows, result);
    assert.equal(receipt.platform, platform);
    persist(f, job, { ...result, masterRosterSupplementReceipt: receipt });
    assert.equal(readMasterRoster(f.db).items[0].targetId, 1);
  }
});

test('a worker assertion rejects old snapshots, forged context and changed source-membership before importing', async t => {
  const f = fixture(t), prepared = await prepareMasterRosterSupplement(f.db, f.input(SEC));
  const job = jobFor(prepared);
  assert.equal(assertMasterRosterSupplementJob(f.db, job).item.key, f.entryKey);
  for (const change of [job => { job.request.masterRosterSupplement.entryPayloadSha256 = 'b'.repeat(64); },
    job => { job.request.masterRosterSupplement.workbookSha256 = 'b'.repeat(64); },
    job => { job.request.masterRosterSupplement.extra = true; },
    job => { job.request.rows[0].boards[0].name = '用户未指定的矩阵'; }]) {
    const changed = structuredClone(job); change(changed);
    assert.throws(() => assertMasterRosterSupplementJob(f.db, changed), error => error.status === 409);
  }
});

test('prepared multi-board fields survive the actual server sanitizer and board-import preparation', async t => {
  const source = readFileSync(new globalThis.URL('../server.mjs', import.meta.url), 'utf8');
  const span = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const helpers = span('function sourceBoards(', 'function rowHasOwnershipEvidence(')
    + span('const AUTHOR_PUBLIC_EVIDENCE_HOSTS', 'function safeBlockedAuthorEvidence(');
  const context = vm.createContext({ URL: globalThis.URL, normalizeBoardKey, normalizeBoardName, normalizePlatform, normalizeAccountLocator, validateSubmittedAccountId });
  vm.runInContext(helpers + ';globalThis.sanitize = sanitizeAuthorJobRow;', context);
  const f = fixture(t, { boards: [{ name: '一条小团团切片矩阵', category: '切片' }, { name: '第二主题', category: '', organization: '机构乙' }] });
  const prepared = await prepareMasterRosterSupplement(f.db, f.input(SEC));
  const sanitized = prepareAuthorBoardImport(prepared.rows, prepared).rows.map(context.sanitize);
  assert.equal(masterRosterSupplementRequestSha256(sanitized), prepared.masterRosterSupplement.requestSha256);
});

test('share evidence must be echoed exactly with case preserved; added trailing slash is equivalent', async t => {
  const f = fixture(t, { ids: ['original_handle'] });
  const prepared = await prepareMasterRosterSupplement(f.db, f.input('https://v.douyin.com/ExactCase/'));
  addTarget(f);
  const job = jobFor(prepared), result = resultFor();
  const ready = { ...prepared.rows[0], status: 'ready', locator: SEC, resolution: { mode: 'public-video-detail', platform: 'douyin', canonicalAccountId: SEC,
    publicDouyinId: 'original_handle', evidenceVideoId: VIDEO, sourceEvidenceUrl: 'https://v.douyin.com/ExactCase', resolvedAt: new Date().toISOString() } };
  assert.ok(buildMasterRosterSupplementReceipt(f.db, job, [ready], result));
  for (const bad of ['', 'https://v.douyin.com/Other/', 'https://v.douyin.com/exactcase/']) {
    assert.equal(buildMasterRosterSupplementReceipt(f.db, job, [{ ...ready, resolution: { ...ready.resolution, sourceEvidenceUrl: bad } }], result), null);
  }
});

test('historical or forged target resolution metadata cannot authorize a handle-to-profile binding', async t => {
  const f = fixture(t, { ids: ['original_handle'] });
  addTarget(f, 1, SEC, { resolution: { platform: 'douyin', mode: 'public-video-detail', canonicalAccountId: SEC, publicDouyinId: 'original_handle' } }, 0);
  const prepared = await prepareMasterRosterSupplement(f.db, f.input(SEC));
  assert.equal(prepared.preview.review.canSubmit, false);
  const job = jobFor(prepared), result = { ok: true, created: [], skipped: [{ status: 'existing', locator: SEC, platform: 'douyin' }] };
  const receipt = buildMasterRosterSupplementReceipt(f.db, job, [{ ...prepared.rows[0], status: 'existing' }], result);
  assert.equal(receipt, null);
  assert.equal(readMasterRoster(f.db).items[0].targetId, null);
});

test('malformed unrelated job JSON does not prevent a roster read', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?,?,?)').run('bad-json', 'failed', '{bad', '', '', '', null);
  assert.equal(readMasterRoster(f.db).summary.pending, 1);
});

test('registered original entries are not eligible even if their current target was deleted', async t => {
  const f = fixture(t); addTarget(f);
  const registered = buildMasterRosterSnapshot({ exportedAt: '2026-10-03T19:01:23.853Z', entities: [{ key: 'target:1', targetId: 1, enabled: true,
    platform: 'douyin', locators: [SEC], names: ['原账号'] }] }, { sha256: 'b'.repeat(64), fileName: '新总表.xlsx' });
  installMasterRoster(f.db, registered);
  f.db.prepare('DELETE FROM targets WHERE id=1').run();
  await assert.rejects(prepareMasterRosterSupplement(f.db, { workbookSha256: 'b'.repeat(64), entryKey: 'target:1', evidence: OTHER }), error => error.status === 409);
});

async function queuedFixture(t, { ids = ['original_handle'], platform = 'douyin', evidence = URL } = {}) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const snapshot = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:01:23.853Z', entities: [{ key: `submitted:${platform}:queue-row`, targetId: null,
    platform, names: ['原始名称'], ids, locators: [], boards: [{ name: '团团切片矩阵', category: '切片' }],
    sources: [{ file: 'original.xlsx', rows: ['12'] }] }] }, { fileName: '总表.xlsx', sha256: HASH });
  installMasterRoster(db, snapshot);
  const input = { workbookSha256: HASH, entryKey: snapshot.items[0].key, evidence };
  const prepared = await prepareMasterRosterSupplement(db, input);
  const job = jobFor(prepared, 'queued-job');
  database.createAuthorResolutionJob({ ...job, fileName: prepared.fileName, sheetName: prepared.sheetName, actorName: 'fixture' });
  const requests = buildAuthorEvidenceRequests(prepared.rows);
  assert.equal(requests.length, 1);
  const queue = database.enqueueAuthorResolutions(requests, { fileName: prepared.fileName, sheetName: prepared.sheetName, sourceMetadata: { sourceType: 'author-spreadsheet' } });
  const result = { ok: true, queuedEvidenceRequestCount: 1, queue, created: [], skipped: [{ ...prepared.rows[0], status: 'unresolved', evidenceRequestKeys: [requests[0].key] }] };
  db.prepare("UPDATE author_resolution_jobs SET status='completed', result_json=?, finished_at=? WHERE id=?").run(JSON.stringify(result), new Date().toISOString(), job.id);
  const commit = (evidenceRequest = requests[0]) => {
    const claimed = database.claimDueAuthorResolutions(1, { owner: 'queue-fixture', reference: new Date(Date.now() + 100) })[0];
    assert.ok(claimed);
    const candidates = (evidenceRequest.videoIds.length ? evidenceRequest.videoIds : [VIDEO]).map(videoId => platform === 'bilibili'
      ? { platform, canonicalId: '123456', nickname: '原始名称', videoId, provenance: 'bilibili-official-anonymous-view', endpoint: `https://api.bilibili.com/x/web-interface/view?bvid=${videoId}`, sourceEvidenceUrl: evidence }
      : { platform, secUid: SEC, nickname: '原始名称', uniqueId: 'original_handle', videoId, sourceEvidenceUrl: evidence });
    const verified = verifyQueuedAuthorEvidence(evidenceRequest, { candidates, errors: [] });
    assert.equal(verified.status, 'ready');
    const row = verified.row;
    const committed = database.commitAuthorResolutionTarget(claimed.id, { label: row.name, locator: row.locator, boards: row.boards,
      metadata: { platform, douyinId: row.douyinId, resolution: row.resolution, importSource: { type: 'author-spreadsheet', fileName: prepared.fileName, sheetName: prepared.sheetName, sourceRow: 2 } } },
    { fileName: prepared.fileName, sheetName: prepared.sheetName }, { owner: 'queue-fixture', evidenceVersion: claimed.evidence_version });
    assert.ok(committed);
    return committed.target;
  };
  return { database, db, prepared, input, job, result, requests, commit, read: () => readMasterRoster(db).items[0] };
}

test('a deferred job closes from the real strict queue commit and immutable source receipt without mutating its historical result', async t => {
  const f = await queuedFixture(t);
  const originalJob = f.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs').get();
  const originalRoster = f.db.prepare('SELECT payload_json FROM master_roster_entries').get();
  assert.equal(f.read().supplement.status, 'awaiting-verification');
  const target = f.commit();
  const read = f.read();
  assert.equal(read.targetId, target.id);
  assert.equal(read.supplement.status, 'linked');
  assert.equal(read.supplement.proofType, 'strict-queue-work-evidence');
  assert.ok(read.supplement.sourceQueueId > 0);
  assert.deepEqual(f.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs').get(), originalJob);
  assert.deepEqual(f.db.prepare('SELECT payload_json FROM master_roster_entries').get(), originalRoster);
  assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
});

test('queue bindings also require complete works when the old entry had only a name, and support official Bilibili proof', async t => {
  for (const options of [{ ids: [] }, { platform: 'bilibili', ids: ['123456'], evidence: 'https://www.bilibili.com/video/BV1xx411c7mD' }]) {
    const f = await queuedFixture(t, options); const target = f.commit();
    assert.equal(f.read().targetId, target.id);
    f.db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({ platform: options.platform || 'douyin' }), target.id);
    assert.equal(f.read().targetId, target.id, 'historical strict proof survives replacement of the latest metadata');
    f.db.prepare('DELETE FROM author_resolution_success_receipts').run();
    assert.equal(f.read().targetId, null, 'resolvedTargetId alone is never sufficient proof');
  }
});

test('queue source receipt must match checksum, sheet, row and board; altered proof cannot promote a pending roster', async t => {
  const f = await queuedFixture(t); f.commit();
  const receipt = f.db.prepare('SELECT * FROM author_resolution_import_sources').get();
  for (const altered of [value => { value.sheetName = '另一个工作表'; }, value => { value.sourceRows = [999]; }, value => { value.boards[0].name = '另一个主题'; }]) {
    const source = JSON.parse(receipt.payload_json); altered(source);
    // Keeping the original checksum must reject any content change.
    f.db.prepare('UPDATE author_resolution_import_sources SET payload_json=?').run(JSON.stringify(source));
    assert.equal(f.read().targetId, null);
    f.db.prepare('UPDATE author_resolution_import_sources SET receipt_sha256=?').run(createHash('sha256').update(JSON.stringify(source)).digest('hex'));
    assert.equal(f.read().targetId, null, 'a valid checksum cannot substitute for the correct source');
    f.db.prepare('UPDATE author_resolution_import_sources SET receipt_sha256=?').run(receipt.receipt_sha256);
  }
  f.db.prepare('UPDATE author_resolution_import_sources SET payload_json=?').run(receipt.payload_json);
  assert.equal(f.read().supplement.status, 'linked');
  f.db.prepare("UPDATE author_resolution_import_sources SET receipt_sha256='bad'").run();
  assert.equal(f.read().targetId, null);
});

test('rejected queues unlock a clear terminal review state and identity conflicts are explicit', async t => {
  const f = await queuedFixture(t);
  f.db.prepare("UPDATE author_resolution_queue SET status='rejected',last_error='超过重试上限 HTTP403'").run();
  assert.equal(f.read().supplement.status, 'review-required');
  f.db.prepare("UPDATE author_resolution_queue SET last_error='作品作者与提交抖音号不一致'").run();
  assert.equal(f.read().supplement.status, 'review-required');
  assert.match(f.read().supplement.reason, /不一致/);
  const revised = await prepareMasterRosterSupplement(f.db, { ...f.input, evidence: 'https://www.douyin.com/video/7684617087687331119' });
  assert.equal(revised.preview.review.canSubmit, true, 'a failed new work does not permanently lock the original entry');
});

test('immutable success proof outlives queue edits but missing/tampered historical proof never binds', async t => {
  const f = await queuedFixture(t); const target = f.commit();
  const originalQueue = f.db.prepare('SELECT * FROM author_resolution_queue').get();
  const originalMetadata = f.db.prepare('SELECT metadata_json FROM targets WHERE id=?').get(target.id).metadata_json;
  for (const [field, value] of [['douyin_id', 'wrong_id'], ['account_locator', OTHER], ['video_ids_json', '["7684617087687331119"]'], ['verification_policy_version', 1]]) {
    f.db.prepare(`UPDATE author_resolution_queue SET ${field}=?`).run(value);
    assert.equal(f.read().targetId, target.id, 'current queue edits cannot rewrite the historical verified identity');
    f.db.prepare(`UPDATE author_resolution_queue SET ${field}=?`).run(originalQueue[field]);
  }
  const receipt = f.db.prepare('SELECT * FROM author_resolution_success_receipts').get();
  const proof = JSON.parse(receipt.payload_json); proof.resolution.verifiedEvidence[0].canonicalAccountId = OTHER;
  f.db.prepare('UPDATE author_resolution_success_receipts SET payload_json=?').run(JSON.stringify(proof));
  assert.equal(f.read().targetId, null);
  f.db.prepare('UPDATE author_resolution_success_receipts SET receipt_sha256=?').run(createHash('sha256').update(JSON.stringify(proof)).digest('hex'));
  assert.equal(f.read().targetId, null, 'even a recomputed outer checksum cannot repair incomplete inner work evidence');
  f.db.prepare('UPDATE author_resolution_success_receipts SET payload_json=?,receipt_sha256=?').run(receipt.payload_json, receipt.receipt_sha256);
  assert.equal(f.read().targetId, target.id);
  f.db.prepare('DELETE FROM author_resolution_import_sources').run();
  assert.equal(f.read().targetId, null);
});

test('same target gets another work proof without losing the original roster binding or pause state', async t => {
  const f = await queuedFixture(t); const target = f.commit();
  const originalSuccess = f.db.prepare('SELECT * FROM author_resolution_success_receipts').get();
  f.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(target.id);
  const extra = buildAuthorEvidenceRequests([{ ...f.prepared.rows[0], videoId: '7684617087687331119', videoLink: 'https://www.douyin.com/video/7684617087687331119' }])[0];
  f.database.enqueueAuthorResolutions([extra], { fileName: '后续作品.csv', sheetName: 'CSV', sourceMetadata: { sourceType: 'author-spreadsheet' } });
  assert.equal(f.commit(extra).id, target.id);
  assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_success_receipts WHERE id=?').get(originalSuccess.id), originalSuccess);
  assert.equal(f.read().targetId, target.id);
  assert.equal(f.read().monitorStatus, 'paused');
  f.db.prepare('UPDATE targets SET locator=? WHERE id=?').run(OTHER, target.id);
  assert.equal(f.read().targetId, null, 'a real canonical identity change must still disconnect the old binding');
});

test('same queue can gain a later evidence version while its earlier successful atomic work remains valid', async t => {
  const f = await queuedFixture(t); const target = f.commit();
  const originalSuccess = f.db.prepare('SELECT * FROM author_resolution_success_receipts').get();
  const newer = { ...f.requests[0], videoIds: [VIDEO, '7684617087687331119'] };
  f.db.prepare("UPDATE author_resolution_queue SET status='pending',evidence_version=evidence_version+1,video_ids_json=?,next_attempt_at=?")
    .run(JSON.stringify(newer.videoIds), new Date().toISOString());
  assert.equal(f.commit(newer).id, target.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n, 2);
  assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_success_receipts WHERE id=?').get(originalSuccess.id), originalSuccess);
  assert.equal(f.read().targetId, target.id);
});

test('queue success receipt is atomic with target creation and rolls back if the final audit write fails', async t => {
  const f = await queuedFixture(t);
  const originalSources = f.db.prepare('SELECT * FROM author_resolution_import_sources').all();
  f.db.exec("CREATE TRIGGER fixture_abort_audit BEFORE INSERT ON audits BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;");
  assert.throws(() => f.commit(), /fixture audit failure/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n, 0);
  assert.equal(f.db.prepare('SELECT status FROM author_resolution_queue').get().status, 'pending');
  assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_import_sources').all(), originalSources);
  assert.equal(f.read().targetId, null);
});

test('direct bindings reject malformed or non-object target metadata while legacy empty objects remain valid', async t => {
  const f = fixture(t), prepared = await prepareMasterRosterSupplement(f.db, f.input(SEC));
  addTarget(f);
  const job = jobFor(prepared), result = resultFor();
  const receipt = buildMasterRosterSupplementReceipt(f.db, job, prepared.rows, result);
  persist(f, job, { ...result, masterRosterSupplementReceipt: receipt });
  for (const invalid of ['{broken', '[]', 'null', '"text"', '42', 'false']) {
    f.db.prepare('UPDATE targets SET metadata_json=?').run(invalid);
    assert.equal(readMasterRoster(f.db).items[0].targetId, null, invalid);
    assert.equal(buildMasterRosterSupplementReceipt(f.db, job, prepared.rows, result), null, invalid);
  }
  f.db.prepare("UPDATE targets SET metadata_json='{}'").run();
  assert.equal(readMasterRoster(f.db).items[0].targetId, 1);
});

test('durable queue bindings disconnect when target metadata is malformed or non-object', async t => {
  const f = await queuedFixture(t); const target = f.commit();
  for (const invalid of ['{broken', '[]', 'null', '"text"', '42', 'false']) {
    f.db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(invalid, target.id);
    assert.equal(f.read().targetId, null, invalid);
  }
  f.db.prepare("UPDATE targets SET metadata_json='{}' WHERE id=?").run(target.id);
  assert.equal(f.read().targetId, target.id, 'a valid legacy object keeps the canonical Douyin binding');
});

test('only a durable strict public-ID proof authorizes profile reuse, preserving pause and refusing receipt tampering', async t => {
  const f = await queuedFixture(t); const target = f.commit();
  f.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(target.id);
  const snapshot = buildMasterRosterSnapshot({ exportedAt: '2026-10-03T19:01:23.853Z', entities: [{ key: 'submitted:douyin:new-independent-source',
    targetId: null, platform: 'douyin', names: ['新来源名称'], ids: ['original_handle'], locators: [], sources: [{ file: 'new-source.xlsx', rows: ['3'] }] }] },
  { sha256: 'b'.repeat(64), fileName: '新版本总表.xlsx' });
  installMasterRoster(f.db, snapshot);
  const input = { workbookSha256: snapshot.workbook.sha256, entryKey: snapshot.items[0].key, evidence: SEC };
  const prepared = await prepareMasterRosterSupplement(f.db, input);
  assert.equal(prepared.preview.review.canSubmit, true);
  const job = jobFor(prepared, 'direct-after-strict'), result = { ok: true, created: [], skipped: [{ status: 'existing', locator: SEC, platform: 'douyin' }] };
  const receipt = buildMasterRosterSupplementReceipt(f.db, job, [{ ...prepared.rows[0], status: 'existing' }], result);
  assert.equal(receipt.verifiedAt, null, 'no fabricated new observation date');
  f.database.createAuthorResolutionJob({ ...job, fileName: prepared.fileName, sheetName: prepared.sheetName, actorName: 'fixture' });
  f.db.prepare("UPDATE author_resolution_jobs SET status='completed',result_json=? WHERE id=?").run(JSON.stringify({ ...result, masterRosterSupplementReceipt: receipt }), job.id);
  assert.equal(readMasterRoster(f.db).items[0].monitorStatus, 'paused');
  const saved = f.db.prepare('SELECT * FROM author_resolution_success_receipts').get();
  for (const alter of [value => { value.resolution.publicDouyinId = 'different_handle'; },
    value => { value.resolution.verifiedEvidenceSha256 = 'bad'; },
    value => { value.verifiedAt = value.resolution.resolvedAt = '2999-01-01T00:00:00.000Z'; }]) {
    const proof = JSON.parse(saved.payload_json); alter(proof);
    f.db.prepare('UPDATE author_resolution_success_receipts SET payload_json=?,receipt_sha256=?').run(JSON.stringify(proof), createHash('sha256').update(JSON.stringify(proof)).digest('hex'));
    assert.equal((await prepareMasterRosterSupplement(f.db, input)).preview.review.canSubmit, false);
    assert.equal(readMasterRoster(f.db).items[0].targetId, null);
  }
  f.db.prepare('UPDATE author_resolution_success_receipts SET payload_json=?,receipt_sha256=?').run(saved.payload_json, saved.receipt_sha256);
  assert.equal(readMasterRoster(f.db).items[0].targetId, target.id);
  f.db.prepare('DELETE FROM author_resolution_success_receipts').run();
  assert.equal((await prepareMasterRosterSupplement(f.db, input)).preview.review.canSubmit, false, 'target metadata remains but is no longer an authority');
});

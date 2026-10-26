import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { validatedSuccessProof } from '../lib/master-roster-supplement.mjs';
import { readCurrentCreatorSourceLinks } from '../lib/creator-source-current-links.mjs';
import { prepareCreatorSourceAuthorisedQueue, runCreatorSourceAuthorisedQueue } from '../lib/creator-source-authorised-queue.mjs';
import { runAuthorisedQueueCycle } from '../lib/authorised-queue-cycle.mjs';

const VIDEO = '7300000000000000001';
const URL = `https://www.douyin.com/video/${VIDEO}`;
const ID = 'creator_1';
const SEC = 'MS4wLjABAAAACreatorSourceNaturalFixture0001';
const UID = '1234567890123456';
const SOURCE_SHA = 'a'.repeat(64);
const SOURCE_URL = 'https://my.feishu.cn/sheets/CreatorSourceFixture';
const SOURCE_MODIFIED = '2026-10-20T00:00:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const objectSha = value => sha(JSON.stringify(value));
const before = new Date(Date.now() - 90_000).toISOString();

function fixture(t, { accountId = ID, numericSourceId = false, short = false } = {}) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const db = database.db;
  db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,
    source_revision TEXT,source_modified_at TEXT,imported_at TEXT);
    CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT,
      PRIMARY KEY(import_id,sheet_id,row_number));
    CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);`);
  db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?,?)')
    .run(SOURCE_SHA, SOURCE_URL, '12', SOURCE_MODIFIED, before);
  const sourceId = numericSourceId ? Number(accountId) : accountId;
  if (numericSourceId) assert.ok(Number.isSafeInteger(sourceId));
  const authorJson = JSON.stringify(['来源作者', sourceId]);
  const workUrl = short ? 'https://v.douyin.com/SourceExact/' : URL;
  const work = Array(12).fill('');
  work[0] = VIDEO; work[2] = sourceId; work[11] = workUrl;
  const workJson = JSON.stringify(work);
  db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08', 2, authorJson);
  db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('09', 2, workJson);
  const request = buildAuthorEvidenceRequests([{ name: '来源作者', douyinId: accountId, videoId: VIDEO,
    shareUrl: workUrl, sourceRow: 2, boards: [{ name: '一条小团团切片矩阵' }] }])[0];
  const sourceMetadata = { sourceType: 'creator-source-sheet', sourceUrl: SOURCE_URL, sourceRevision: '12',
    sourceSha256: SOURCE_SHA, sourceModifiedAt: SOURCE_MODIFIED, authorSheet: '08_作者总表', authorRow: 2,
    workSheet: '09_去重作品', workRow: 2, authorRowSha256: sha(authorJson), workRowSha256: sha(workJson),
    frozenSourceDigest: 'b'.repeat(64), evidenceType: short ? 'short-work-url-pending-redirect-verification' : 'direct-work-url',
    identityStatus: 'unverified-candidate', batchKey: 'fixture-batch', batchSize: 1, lastAuthorRow: 2 };
  const fileName = '一条小团团切片作品登记表-来源数据集', sheetName = '08_作者总表';
  const source = { fileName, sheetName, sourceRows: [2], sourceMetadata, boards: request.boards };
  const payload = JSON.stringify(source), now = new Date().toISOString();
  const id = Number(db.prepare(`INSERT INTO author_resolution_queue
    (identity_key,name,douyin_id,account_locator,video_ids_json,share_urls_json,boards_json,
      source_rows_json,file_name,sheet_name,source_metadata_json,status,attempts,next_attempt_at,
      created_at,updated_at,verification_policy_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?,2)`).run(request.key, request.name, request.douyinId,
    request.accountLocator || '', JSON.stringify(request.videoIds), JSON.stringify(request.shareUrls),
    JSON.stringify(request.boards), JSON.stringify([2]), fileName, sheetName, JSON.stringify(sourceMetadata),
    now, now, now).lastInsertRowid);
  db.prepare(`INSERT INTO author_resolution_import_sources
    (queue_id,queue_identity_key,receipt_sha256,observed_at,payload_json) VALUES(?,?,?,?,?)`)
    .run(id, request.key, sha(payload), now, payload);
  const owner = 'creator-source-natural-test', claimed = database.claimDueAuthorResolutions(1, { owner, leaseMs: 60_000 })[0];
  assert.equal(claimed.id, id);
  const input = (context, row) => {
    assert.equal(context.fileName, fileName);
    assert.equal(context.sheetName, sheetName);
    assert.equal(context.id, undefined, 'a completed job must not be fabricated');
    return { label: row.name, locator: row.locator, boards: row.boards,
      metadata: { platform: 'douyin', douyinId: row.douyinId, resolution: row.resolution } };
  };
  const proof = requestInput => {
    const at = new Date().toISOString();
    const response = { status_code: 0, aweme_detail: { aweme_id: VIDEO,
      author: { sec_uid: SEC, uid: UID, unique_id: accountId } } };
    const responseSha256 = objectSha(response);
    return { status: 'ok', key: requestInput.key, videoId: VIDEO, submittedId: accountId, ...(short ? {shareUrl:workUrl} : {}),
      requestStartedAt: at, requestFinishedAt: at,
      candidate: { videoId: VIDEO, secUid: SEC, uid: UID, uniqueId: accountId,
        shortId: '', provenance: 'authorised-browser-natural-detail', observedAt: at,
        responseSha256, responseSha256Scope: 'public-identity-projection-v1' },
      evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com',
        path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200,
        requestedVideoId: VIDEO, observedAt: at, responseSha256,
        ...(short ? {requestedShareUrl:workUrl,finalUrl:URL,finalUrlSha256:'a'.repeat(64),finalUrlScope:'observed-origin-path',finalVideoId:VIDEO} : {}),
        responseSha256Scope: 'public-identity-projection-v1', response },
      provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true,
        authenticated: null, authenticationStatus: 'not-verified', noChallengeBypass: true,
        runtimeAI: false, paidAPI: false } };
  };
  const capture = () => JSON.stringify(Object.fromEntries(['targets', 'snapshots', 'creator_source_imports',
    'creator_source_rows', 'author_resolution_queue', 'author_resolution_import_sources',
    'author_resolution_success_receipts'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  return { database, db, owner, claimed, request, input, proof, capture };
}

test('read-only source adapter accepts one work represented by matching ID and official direct URL', t => {
  const f = fixture(t), original = f.capture(), prepared = prepareCreatorSourceAuthorisedQueue(f.database, f.claimed, { owner: f.owner });
  assert.equal(prepared.status, 'ready');
  assert.deepEqual(prepared.input, { key: f.request.key, videoId: VIDEO, submittedId: ID });
  assert.equal(prepared.source.authorRow, 2);
  assert.equal(prepared.source.workRow, 2);
  assert.equal(f.capture(), original);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM author_resolution_jobs WHERE status='completed'").get().n, 0);
});

test('source spreadsheet numeric public IDs are accepted only when exactly representable', async t => {
  const f = fixture(t, { accountId: '71555289844', numericSourceId: true });
  assert.equal(prepareCreatorSourceAuthorisedQueue(f.database, f.claimed, { owner: f.owner }).status, 'ready');
  const result = await runCreatorSourceAuthorisedQueue(f.database, f.claimed, {
    owner: f.owner, createInput: f.input,
    provider: { resolveAuthorisedDetail: async ({ items: [input] }) => f.proof(input) },
  });
  assert.equal(result.status, 'resolved');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 1);
});

test('natural-page response commits strict two-locator identity without inventing job or sampled metrics', async t => {
  const f = fixture(t), sources = f.db.prepare('SELECT * FROM creator_source_rows ORDER BY sheet_id').all();
  const receipts = f.db.prepare('SELECT * FROM author_resolution_import_sources').all();
  let calls = 0;
  const result = await runCreatorSourceAuthorisedQueue(f.database, f.claimed, {
    owner: f.owner, createInput: f.input,
    provider: { resolveAuthorisedDetail: async ({ items }) => {
      calls++;
      assert.equal(items.length, 1);
      assert.equal(items[0].videoId, VIDEO);
      assert.equal(items[0].shareUrl, undefined);
      return f.proof(items[0]);
    } },
  });
  assert.equal(result.status, 'resolved');
  assert.equal(calls, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM author_resolution_jobs WHERE status='completed'").get().n, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM creator_source_rows ORDER BY sheet_id').all(), sources);
  assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_import_sources').all(), receipts);
  const proof = validatedSuccessProof(f.db.prepare('SELECT * FROM author_resolution_success_receipts').get());
  assert.equal(proof?.resolution?.verifiedEvidenceCount, 2);
  assert.equal(proof?.resolution?.authorisedDetailReceipt?.equivalentLocatorsForOneWork, true);
  const overlay = readCurrentCreatorSourceLinks(f.db);
  assert.equal(overlay.accountLinks.length, 1);
  assert.equal(overlay.workLinks.length, 1);
  assert.equal(overlay.stats.receiptAccepted, 1);
  assert.equal(f.db.isTransaction, false);
});

test('tampered source hashes, receipts, lease, URL, work and account ID block browser launch', async t => {
  const changes = [
    "UPDATE creator_source_imports SET source_sha256='bad'",
    "UPDATE creator_source_rows SET values_json='[\"changed\",\"creator_1\"]' WHERE sheet_id='08'",
    "UPDATE creator_source_rows SET values_json='[\"7300000000000000002\"]' WHERE sheet_id='09'",
    "UPDATE author_resolution_import_sources SET receipt_sha256='bad'",
    "UPDATE author_resolution_queue SET lease_owner='someone-else'",
    "UPDATE author_resolution_queue SET lease_until='2000-01-01T00:00:00.000Z'",
    "UPDATE author_resolution_queue SET share_urls_json='[\"https://www.douyin.com/video/7300000000000000002\"]'",
    "UPDATE author_resolution_queue SET video_ids_json='[\"7300000000000000002\"]'",
    "UPDATE author_resolution_queue SET douyin_id='other_account'",
    "UPDATE author_resolution_queue SET source_metadata_json='{}'",
  ];
  for (const change of changes) {
    const f = fixture(t); f.db.exec(change);
    const snapshot = f.capture();
    const result = await runCreatorSourceAuthorisedQueue(f.database, f.claimed, {
      owner: f.owner, createInput: f.input,
      provider: { resolveAuthorisedDetail: () => assert.fail('tampered source must not launch browser') },
    });
    assert.equal(result.status, 'skipped', change);
    assert.equal(f.capture(), snapshot, change);
  }
});

test('only the unique receipt matching the current frozen queue context may authorize', t => {
  const f = fixture(t), existing = f.db.prepare('SELECT * FROM author_resolution_import_sources').get();
  const payload = JSON.parse(existing.payload_json);
  const unrelated = JSON.stringify({ ...payload, boards: [{ name: '另一个未核验板块' }] });
  f.db.prepare(`INSERT INTO author_resolution_import_sources
    (queue_id,queue_identity_key,receipt_sha256,observed_at,payload_json) VALUES(?,?,?,?,?)`)
    .run(f.claimed.id, f.request.key, sha(unrelated), new Date().toISOString(), unrelated);
  assert.equal(prepareCreatorSourceAuthorisedQueue(f.database, f.claimed, { owner: f.owner }).status, 'ready',
    'an unrelated historical receipt must not poison a uniquely matching current receipt');
  const reordered = JSON.stringify({ boards: payload.boards, sourceMetadata: payload.sourceMetadata,
    sheetName: payload.sheetName, fileName: payload.fileName, sourceRows: payload.sourceRows });
  f.db.prepare(`INSERT INTO author_resolution_import_sources
    (queue_id,queue_identity_key,receipt_sha256,observed_at,payload_json) VALUES(?,?,?,?,?)`)
    .run(f.claimed.id, f.request.key, sha(reordered), new Date().toISOString(), reordered);
  assert.equal(prepareCreatorSourceAuthorisedQueue(f.database, f.claimed, { owner: f.owner }).code,
    'source_receipt_ambiguous', 'two distinct valid receipts cannot be silently chosen');
});

test('a forged non-official work URL is rejected even when editable row hashes are made consistent', async t => {
  const f = fixture(t);
  const work = JSON.parse(f.db.prepare("SELECT values_json FROM creator_source_rows WHERE sheet_id='09'").get().values_json);
  work[11] = `https://example.invalid/video/${VIDEO}`;
  const workJson = JSON.stringify(work);
  f.db.prepare("UPDATE creator_source_rows SET values_json=? WHERE sheet_id='09'").run(workJson);
  const queue = f.db.prepare('SELECT source_metadata_json FROM author_resolution_queue').get();
  const metadata = JSON.parse(queue.source_metadata_json);
  metadata.workRowSha256 = sha(workJson);
  f.db.prepare('UPDATE author_resolution_queue SET source_metadata_json=?').run(JSON.stringify(metadata));
  const receipt = f.db.prepare('SELECT payload_json FROM author_resolution_import_sources').get();
  const payload = JSON.parse(receipt.payload_json);
  payload.sourceMetadata = metadata;
  const receiptJson = JSON.stringify(payload);
  f.db.prepare('UPDATE author_resolution_import_sources SET payload_json=?,receipt_sha256=?')
    .run(receiptJson, sha(receiptJson));
  const result = await runCreatorSourceAuthorisedQueue(f.database, f.claimed, {
    owner: f.owner, createInput: f.input,
    provider: { resolveAuthorisedDetail: () => assert.fail('forged URL must not launch browser') },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.code, 'source_evidence_conflict');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 0);
});

test('receipt appended during natural-page request fails admission without creating target', async t => {
  const f = fixture(t), original = JSON.parse(f.db.prepare('SELECT payload_json FROM author_resolution_import_sources').get().payload_json);
  const result = await runCreatorSourceAuthorisedQueue(f.database, f.claimed, {
    owner: f.owner, createInput: f.input,
    provider: { resolveAuthorisedDetail: async ({ items: [input] }) => {
      const reordered = JSON.stringify({ boards: original.boards, sourceMetadata: original.sourceMetadata,
        sheetName: original.sheetName, fileName: original.fileName, sourceRows: original.sourceRows });
      f.db.prepare(`INSERT INTO author_resolution_import_sources
        (queue_id,queue_identity_key,receipt_sha256,observed_at,payload_json) VALUES(?,?,?,?,?)`)
        .run(f.claimed.id, f.request.key, sha(reordered), new Date().toISOString(), reordered);
      return f.proof(input);
    } },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'AUTHORISED_ADMISSION_STALE');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 0);
});

test('a later source/receipt/lease change fails the write-locked recheck and cannot add a target', async t => {
  for (const change of [
    "UPDATE creator_source_rows SET values_json='[\"changed\",\"creator_1\"]' WHERE sheet_id='08'",
    "UPDATE author_resolution_import_sources SET receipt_sha256='bad'",
    "UPDATE author_resolution_queue SET lease_owner='someone-else'",
    "UPDATE creator_source_imports SET source_sha256='bad'",
  ]) {
    const f = fixture(t);
    const result = await runCreatorSourceAuthorisedQueue(f.database, f.claimed, {
      owner: f.owner, createInput: f.input,
      provider: { resolveAuthorisedDetail: async ({ items: [input] }) => {
        f.db.exec(change);
        return f.proof(input);
      } },
    });
    assert.equal(result.status, 'unavailable', change);
    assert.equal(result.code, 'AUTHORISED_ADMISSION_STALE', change);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 0, change);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_success_receipts').get().n, 0, change);
  }
});

test('user-maintained target conflict is persisted as rejected, never overwritten', async t => {
  const f = fixture(t), at = new Date().toISOString();
  f.db.prepare(`INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
    VALUES('account','保留名称',?,'public-web',1,?,?,?)`).run(SEC, JSON.stringify({ platform: 'douyin', douyinId: 'other_account' }), at, at);
  const existing = f.db.prepare('SELECT * FROM targets WHERE locator=?').get(SEC);
  const result = await runCreatorSourceAuthorisedQueue(f.database, f.claimed, {
    owner: f.owner, createInput: f.input,
    provider: { resolveAuthorisedDetail: async ({ items: [input] }) => f.proof(input) },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'AUTHOR_TARGET_PUBLIC_ID_CONFLICT');
  assert.deepEqual(f.db.prepare('SELECT * FROM targets WHERE locator=?').get(SEC), existing);
  assert.equal(f.db.prepare('SELECT status FROM author_resolution_queue').get().status, 'rejected');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_success_receipts').get().n, 0);
});

test('wrong public account ID or different work in the observed response cannot bind a target', async t => {
  for (const [change, expectedCode] of [
    [proof => { proof.evidence.response.aweme_detail.author.unique_id = 'someone_else'; }, 'identity_mismatch'],
    [proof => { proof.videoId = '7300000000000000002'; }, 'invalid_evidence'],
  ]) {
    const f = fixture(t);
    const result = await runCreatorSourceAuthorisedQueue(f.database, f.claimed, {
      owner: f.owner, createInput: f.input,
      provider: { resolveAuthorisedDetail: async ({ items: [input] }) => {
        const proof = f.proof(input); change(proof); return proof;
      } },
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, expectedCode);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 0);
  }
});

test('session/challenge refusal stops the cycle, preserves error class and never enters anonymous legacy', async t => {
  for (const errorCode of ['session_required', 'login_required', 'blocked', 'challenge_required', 'rate_limited']) {
    const f = fixture(t);
    const cycle = await runAuthorisedQueueCycle(f.database, [f.claimed], {
      owner: f.owner, retryAt: () => new Date(Date.now() + 60_000).toISOString(),
      createInput: f.input,
      provider: { resolveAuthorisedDetail: async ({ items: [input] }) => {
        const at = new Date().toISOString();
        return { status: 'unavailable', key: input.key, videoId: input.videoId,
          submittedId: input.submittedId, requestStartedAt: at, requestFinishedAt: at,
          errorCode };
      }, resolveAuthors: () => assert.fail('must not use anonymous legacy resolver') },
    });
    assert.equal(cycle.stopped, true, errorCode);
    assert.equal(cycle.outcomes[0].code, errorCode);
    assert.deepEqual(cycle.legacy, []);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 0);
  }
});

test('damaged source metadata never routes a known source batch into the anonymous resolver', async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE author_resolution_queue SET source_metadata_json=? WHERE id=?').run('{}', f.claimed.id);
  const cycle = await runAuthorisedQueueCycle(f.database, [{ ...f.claimed, sourceMetadata: {}, source_metadata_json: '{}' }], {
    owner: f.owner, retryAt: () => new Date(Date.now() + 60_000).toISOString(),
    createInput: f.input,
    provider: { resolveAuthorisedDetail: () => assert.fail('bad source must not launch browser'),
      resolveAuthors: () => assert.fail('bad source must not route anonymously') },
  });
  assert.equal(cycle.outcomes[0].code, 'source_context_stale');
  assert.deepEqual(cycle.legacy, []);
  assert.match(f.db.prepare('SELECT last_error FROM author_resolution_queue').get().last_error,
    /\[source_context_stale\]/);
});


test('short source link is followed once and must prove its saved work ID before monitoring', async t => {
  const f=fixture(t,{short:true});
  const prepared=prepareCreatorSourceAuthorisedQueue(f.database,f.claimed,{owner:f.owner});
  assert.equal(prepared.status,'ready');assert.equal(prepared.input.shareUrl,'https://v.douyin.com/SourceExact/');
  assert.equal(prepared.input.videoId,undefined);
  const result=await runCreatorSourceAuthorisedQueue(f.database,f.claimed,{owner:f.owner,createInput:f.input,
    provider:{resolveAuthorisedDetail:async({items:[input]})=>f.proof(input)}});
  assert.equal(result.status,'resolved');
  assert.equal(readCurrentCreatorSourceLinks(f.db).accountLinks.length,1);
});

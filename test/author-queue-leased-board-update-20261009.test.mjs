import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';

const SEC = 'MS4wLjABAAAAleasedMembershipAccount1234567890';
const ORIGINAL = { fileName: '原名单.xlsx', sheetName: '团团', sourceMetadata: { sourceType: 'author-spreadsheet' } };
const SUPPLEMENT = { fileName: '增补名单.xlsx', sheetName: '新矩阵', sourceMetadata: { sourceType: 'author-spreadsheet' } };
const ITEM = { key: `douyin:account:${SEC}|proof`, name: '作者甲', douyinId: 'author_a', accountLocator: SEC,
  videoIds: ['7684617087687331118'], shareUrls: [], sourceRows: [2], boards: ['团团'] };

function fixture(t, { existingTarget = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mcn-leased-membership-'));
  const database = new MonitorDatabase(join(directory, 'fixture.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  let target;
  if (existingTarget) {
    target = database.createTarget({ type: 'account', provider: 'public-web', label: '作者甲', locator: SEC,
      metadata: { platform: 'douyin', userField: '保留' } });
    database.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(target.id);
    database.assignTargetsToBoard([target.id], '团团', { sourceType: 'user-confirmed' });
    database.db.prepare("UPDATE target_boards SET owner='用户手改负责人' WHERE target_id=?").run(target.id);
  }
  database.enqueueAuthorResolutions([ITEM], ORIGINAL);
  const claim = database.claimDueAuthorResolutions(1, { owner: 'worker-a' })[0];
  const read = () => database.db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(claim.id);
  const receipts = () => database.db.prepare('SELECT * FROM author_resolution_import_sources WHERE queue_id=? ORDER BY id').all(claim.id);
  const commit = () => database.commitAuthorResolutionTarget(claim.id, {
    label: '作者甲', locator: SEC, boards: claim.boards,
    metadata: { platform: 'douyin', importSource: { type: 'author-spreadsheet', fileName: ORIGINAL.fileName, sheetName: ORIGINAL.sheetName, sourceRow: 2 } },
  }, ORIGINAL, { owner: 'worker-a', evidenceVersion: claim.evidence_version });
  return { database, claim, read, receipts, commit, target, path: join(directory, 'fixture.sqlite') };
}

function protectedClaimFields(row) {
  const keys = ['identity_key', 'name', 'douyin_id', 'account_locator', 'video_ids_json', 'share_urls_json',
    'source_rows_json', 'file_name', 'sheet_name', 'source_metadata_json', 'status', 'attempts', 'next_attempt_at',
    'last_error', 'resolved_target_id', 'lease_owner', 'lease_until', 'evidence_version', 'created_at', 'updated_at'];
  return Object.fromEntries(keys.map(key => [key, row[key]]));
}

test('leased same-evidence supplement survives a worker committing its old membership snapshot', t => {
  const f = fixture(t), before = f.read();
  const result = f.database.enqueueAuthorResolutions([{ ...ITEM, sourceRows: [20], boards: [{ name: '新矩阵', owner: '负责人乙' }] }], SUPPLEMENT);
  assert.equal(result.leaseDeferredEvidenceRequestCount, 1);
  assert.deepEqual(protectedClaimFields(f.read()), protectedClaimFields(before));
  assert.deepEqual(JSON.parse(f.read().boards_json).map(board => board.name), ['团团', '新矩阵']);
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM targets').get().count, 0, 'metadata alone cannot authorize a target');
  const imported = f.commit();
  assert.equal(imported.boardMembershipsAdded, 2);
  assert.deepEqual(imported.target.boards.map(board => board.name).sort(), ['团团', '新矩阵'].sort());
  const added = imported.target.boards.find(board => board.name === '新矩阵');
  assert.equal(added.owner, '负责人乙');
  assert.equal(added.source.fileName, SUPPLEMENT.fileName);
  assert.equal(added.source.sourceRow, 20);
  assert.equal(f.read().status, 'resolved');
  assert.ok(f.receipts().some(receipt => {
    const payload = JSON.parse(receipt.payload_json);
    return payload.fileName === SUPPLEMENT.fileName && payload.sheetName === SUPPLEMENT.sheetName && payload.sourceRows[0] === 20;
  }), 'new source rows remain tied to their own original file, not relabelled as old-file rows');
});

test('leased same-board supplements fill empty relationship fields and deduplicate repeat receipts', t => {
  const f = fixture(t);
  const supplement = { ...ITEM, sourceRows: [12, 13], boards: [{ name: '团团', owner: '新负责人', category: '原创', note: '补资料' }] };
  f.database.enqueueAuthorResolutions([supplement], SUPPLEMENT);
  const beforeRepeat = f.read(), receiptsBefore = f.receipts();
  f.database.enqueueAuthorResolutions([supplement], SUPPLEMENT);
  assert.deepEqual(f.read(), beforeRepeat);
  assert.deepEqual(f.receipts(), receiptsBefore);
  const board = f.commit().target.boards.find(board => board.name === '团团');
  assert.equal(board.owner, '新负责人');
  assert.equal(board.category, '原创');
  assert.equal(board.note, '补资料');
  assert.equal(board.source.fileName, SUPPLEMENT.fileName);
  assert.equal(board.source.sourceRow, 12);
});

test('leased supplements preserve a paused target and existing user-filled relationship values', t => {
  const f = fixture(t, { existingTarget: true });
  f.database.enqueueAuthorResolutions([{ ...ITEM, boards: [{ name: '团团', owner: '导入负责人', category: 'AI' }, '新矩阵'] }], SUPPLEMENT);
  const imported = f.commit(), board = imported.target.boards.find(board => board.name === '团团');
  assert.equal(imported.created, false);
  assert.equal(imported.target.enabled, false);
  assert.equal(imported.target.metadata.userField, '保留');
  assert.equal(board.owner, '用户手改负责人');
  assert.equal(board.category, 'AI');
  assert.ok(board.conflicts.some(conflict => conflict.field === 'owner' && conflict.incomingValue === '导入负责人'));
  assert.ok(imported.target.boards.some(board => board.name === '新矩阵'));
});

test('strictly verified source enriches an existing target without replacing its user-maintained label or metadata', t => {
  const f = fixture(t, { existingTarget: true });
  const originalSource = { type: 'user-confirmed', fileName: '人工维护名单.xlsx' };
  f.database.db.prepare('UPDATE targets SET label=?,metadata_json=? WHERE id=?').run('用户自定义名称', JSON.stringify({
    platform: 'douyin', douyinId: 'author_a', submittedName: '用户填写名称',
    owner: '用户负责人', note: '人工备注', importSource: originalSource,
    resolution: { verifiedEvidenceCount: 1, resolvedAt: '2026-09-01T00:00:00.000Z' },
  }), f.target.id);
  const newResolution = { verificationPolicy: 'all-submitted-evidence-v2', verifiedEvidenceCount: 2,
    canonicalAccountId: SEC, publicDouyinId: 'another_display_id', resolvedAt: '2026-10-23T00:00:00.000Z' };
  const committed = f.database.commitAuthorResolutionTarget(f.claim.id, {
    label: '来源表作者名', locator: SEC, boards: f.claim.boards,
    metadata: { platform: 'douyin', douyinId: 'author_a', submittedName: '来源表作者名',
      owner: '来源负责人', note: '来源备注',
      importSource: { type: 'author-spreadsheet', fileName: ORIGINAL.fileName },
      evidenceVideoId: ITEM.videoIds[0], resolution: newResolution },
  }, ORIGINAL, { owner: 'worker-a', evidenceVersion: f.claim.evidence_version });
  assert.equal(committed.created, false);
  assert.equal(committed.target.enabled, false, '已暂停目标不得因来源核验而自动启用');
  assert.equal(committed.target.label, '用户自定义名称');
  assert.equal(committed.target.metadata.douyinId, 'author_a');
  assert.equal(committed.target.metadata.submittedName, '用户填写名称');
  assert.equal(committed.target.metadata.owner, '用户负责人');
  assert.equal(committed.target.metadata.note, '人工备注');
  assert.deepEqual(committed.target.metadata.importSource, originalSource);
  assert.equal(committed.target.metadata.evidenceVideoId, ITEM.videoIds[0], '来源仍可补齐原本没有的字段');
  assert.deepEqual(committed.target.metadata.resolution, newResolution, '最新严格核验证据仍须更新');
  const proof = JSON.parse(f.database.db.prepare('SELECT payload_json FROM author_resolution_success_receipts WHERE queue_id=?')
    .get(f.claim.id).payload_json);
  assert.deepEqual(proof.resolution, newResolution, '不可变收据保留这次提交的原始核验证据');
});

test('different verified public ID quarantines the queue without changing an existing target or history', t => {
  const f = fixture(t, { existingTarget: true });
  f.database.db.prepare('UPDATE targets SET label=?,metadata_json=? WHERE id=?').run('保留的用户名称', JSON.stringify({
    platform: 'douyin', douyinId: 'old_handle', owner: '用户负责人',
    importSource: { type: 'user-confirmed', fileName: '原始名单.xlsx' },
  }), f.target.id);
  const targetBefore = f.database.db.prepare('SELECT * FROM targets WHERE id=?').get(f.target.id);
  const queueBefore = f.read();
  const committed = f.database.commitAuthorResolutionTarget(f.claim.id, {
    label: '新来源作者', locator: SEC, boards: f.claim.boards,
    metadata: { platform: 'douyin', douyinId: 'author_a', resolution: {
      verificationPolicy: 'all-submitted-evidence-v2', canonicalAccountId: SEC,
      publicDouyinId: 'author_a', verifiedEvidenceCount: 2,
    } },
  }, ORIGINAL, { owner: 'worker-a', evidenceVersion: f.claim.evidence_version });
  assert.equal(committed, null);
  assert.deepEqual(f.database.db.prepare('SELECT * FROM targets WHERE id=?').get(f.target.id), targetBefore);
  const rejected = f.read();
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.attempts, queueBefore.attempts + 1);
  assert.match(rejected.last_error, /公开抖音号.*不一致.*人工核查/);
  assert.equal(rejected.resolved_target_id, null);
  assert.equal(rejected.lease_owner, null);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM author_resolution_success_receipts WHERE queue_id=?')
    .get(f.claim.id).n, 0);
  const audit = f.database.db.prepare('SELECT target_id,status,message FROM audits ORDER BY id DESC LIMIT 1').get();
  assert.equal(audit.target_id, f.target.id);
  assert.equal(audit.status, 'warning');
  assert.match(audit.message, /人工核查/);
});

test('nested strict-ID conflict is quarantined inside the caller transaction and still rolls back with it', t => {
  const f = fixture(t, { existingTarget: true });
  f.database.db.prepare('UPDATE targets SET metadata_json=? WHERE id=?')
    .run(JSON.stringify({ platform: 'douyin', douyinId: 'old_handle', owner: '用户负责人' }), f.target.id);
  const targetBefore = f.database.db.prepare('SELECT * FROM targets WHERE id=?').get(f.target.id);
  const queueBefore = f.read();
  f.database.db.exec('BEGIN IMMEDIATE');
  const result = f.database.commitAuthorResolutionTarget(f.claim.id, {
    label: '新来源作者', locator: SEC, boards: f.claim.boards,
    metadata: { platform: 'douyin', resolution: {
      verificationPolicy: 'all-submitted-evidence-v2', canonicalAccountId: SEC,
      publicDouyinId: 'author_a', verifiedEvidenceCount: 2,
    } },
  }, ORIGINAL, { owner: 'worker-a', evidenceVersion: f.claim.evidence_version, withinTransaction: true });
  assert.deepEqual(result, { status: 'identity_conflict', queueId: f.claim.id });
  assert.equal(f.database.db.isTransaction, true);
  assert.deepEqual(f.database.db.prepare('SELECT * FROM targets WHERE id=?').get(f.target.id), targetBefore);
  assert.equal(f.read().status, 'rejected');
  assert.equal(f.read().attempts, queueBefore.attempts + 1);
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM audits WHERE status='warning'").get().n, 1);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM author_resolution_success_receipts WHERE queue_id=?')
    .get(f.claim.id).n, 0);
  f.database.db.exec('ROLLBACK');
  assert.deepEqual(f.read(), queueBefore);
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM audits WHERE status='warning'").get().n, 0);
});

test('changed identity evidence still invalidates a stale worker after a leased membership supplement', t => {
  const f = fixture(t);
  f.database.enqueueAuthorResolutions([{ ...ITEM, boards: ['新矩阵'] }], SUPPLEMENT);
  f.database.enqueueAuthorResolutions([{ ...ITEM, videoIds: ['7684617087687331119'], boards: ['另一矩阵'] }], SUPPLEMENT);
  assert.ok(f.read().evidence_version > f.claim.evidence_version);
  assert.equal(f.commit(), null);
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM targets').get().count, 0);
  assert.deepEqual(JSON.parse(f.read().boards_json).map(board => board.name).sort(), ['团团', '新矩阵', '另一矩阵'].sort());
});

test('rejection does not publish memberships retained while the identity is still unverified', t => {
  const f = fixture(t);
  f.database.enqueueAuthorResolutions([{ ...ITEM, boards: ['新矩阵'] }], SUPPLEMENT);
  f.database.markAuthorResolutionRejected(f.claim.id, '公开证据身份不符', { owner: 'worker-a', evidenceVersion: f.claim.evidence_version });
  assert.equal(f.commit(), null);
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM target_boards').get().count, 0);
  assert.deepEqual(JSON.parse(f.read().boards_json).map(board => board.name), ['团团', '新矩阵']);
});

test('membership commit failure rolls back target creation and resolution while retaining the pending supplement', t => {
  const f = fixture(t);
  f.database.enqueueAuthorResolutions([{ ...ITEM, boards: ['新矩阵'] }], SUPPLEMENT);
  const before = f.read(), receiptsBefore = f.receipts();
  f.database.db.exec("CREATE TRIGGER fail_supplement BEFORE INSERT ON target_boards WHEN NEW.board_name='新矩阵' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => f.commit(), /fixture failure/);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.receipts(), receiptsBefore);
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM targets').get().count, 0);
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM target_boards').get().count, 0);
});

test('leased metadata write failure rolls back both merged boards and source receipts', t => {
  const f = fixture(t), before = f.read(), receiptsBefore = f.receipts();
  f.database.db.exec("CREATE TRIGGER fail_queue_supplement BEFORE UPDATE OF boards_json ON author_resolution_queue BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => f.database.enqueueAuthorResolutions([{ ...ITEM, boards: ['新矩阵'] }], SUPPLEMENT), /fixture failure/);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.receipts(), receiptsBefore);
});

test('separate import connection preserves in-flight supplements and resolved replay cannot rewrite original provenance', t => {
  const f = fixture(t), second = new MonitorDatabase(f.path);
  t.after(() => second.close());
  const supplement = { ...ITEM, boards: [{ name: '新矩阵', owner: '负责人乙' }], sourceRows: [27] };
  second.enqueueAuthorResolutions([supplement], SUPPLEMENT);
  assert.equal(f.read().lease_owner, 'worker-a');
  assert.equal(f.commit().target.boards.length, 2);
  const receiptsBefore = f.receipts();
  second.enqueueAuthorResolutions([supplement], SUPPLEMENT);
  assert.deepEqual(f.receipts(), receiptsBefore);
  for (const receipt of f.receipts()) {
    const payload = JSON.parse(receipt.payload_json);
    if (payload.fileName === ORIGINAL.fileName) assert.deepEqual(payload.boards, ITEM.boards);
  }
});

test('relationship summary points to the last source that filled fields while original per-import receipts remain distinct', t => {
  const f = fixture(t);
  const ownerSupplement = { ...ITEM, boards: [{ name: '团团', owner: '负责人乙' }], sourceRows: [20] };
  const categorySource = { ...SUPPLEMENT, fileName: '分类补充.xlsx', sheetName: '内容分类' };
  const categorySupplement = { ...ITEM, boards: [{ name: '团团', category: '原创' }], sourceRows: [35] };
  f.database.enqueueAuthorResolutions([ownerSupplement], SUPPLEMENT);
  f.database.enqueueAuthorResolutions([categorySupplement], categorySource);
  // A later conflicting field must neither replace the accepted value nor
  // claim to be the source that filled the accepted relationship fields.
  f.database.enqueueAuthorResolutions([{ ...ITEM, boards: [{ name: '团团', owner: '冲突负责人' }], sourceRows: [48] }],
    { ...SUPPLEMENT, fileName: '冲突来源.xlsx' });
  const board = f.commit().target.boards.find(board => board.name === '团团');
  assert.equal(board.owner, '负责人乙');
  assert.equal(board.category, '原创');
  assert.equal(board.source.fileName, categorySource.fileName);
  assert.equal(board.source.sourceRow, 35);
  assert.ok(board.conflicts.some(conflict => conflict.field === 'owner' && conflict.incomingValue === '冲突负责人'));
  const sources = f.receipts().map(receipt => JSON.parse(receipt.payload_json));
  const ownerReceipt = sources.find(source => source.fileName === SUPPLEMENT.fileName);
  const categoryReceipt = sources.find(source => source.fileName === categorySource.fileName);
  assert.deepEqual(ownerReceipt.boards, ownerSupplement.boards);
  assert.deepEqual(ownerReceipt.sourceRows, [20]);
  assert.deepEqual(categoryReceipt.boards, categorySupplement.boards);
  assert.deepEqual(categoryReceipt.sourceRows, [35]);
  assert.deepEqual(sources.find(source => source.fileName === ORIGINAL.fileName).boards, ITEM.boards);
});

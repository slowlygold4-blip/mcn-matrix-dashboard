import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MonitorDatabase, normalizeBoardKey } from '../lib/database.mjs';
import { readMasterRoster } from '../lib/master-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const databasePath = join(root, 'data', 'douyin-monitor.sqlite');
const receiptPath = join(root, 'data', 'reconciliation', '20261010-tuantuan-matrix-membership.json');
const boardName = '一条小团团切片矩阵';
const boardKey = normalizeBoardKey(boardName);
const expectedAccountCount = 821;
const expectedInitialMissing = 320;
const apply = process.argv.includes('--apply');

function inspect(db) {
  const roster = readMasterRoster(db);
  if (!roster) throw new Error('尚未安装总表，停止对账');
  const rosterTargetIds = new Set(roster.items
    .filter(item => item.theme?.key === 'tuantuan' && Number.isSafeInteger(item.targetId) && item.targetId > 0)
    .map(item => item.targetId));
  const existingRows = db.prepare(`SELECT tb.target_id,t.type,t.enabled
    FROM target_boards tb JOIN targets t ON t.id=tb.target_id WHERE tb.board_key=?`).all(boardKey);
  const existingAccountIds = new Set(existingRows.filter(row => row.type === 'account').map(row => row.target_id));
  const targetIds = [...new Set([...rosterTargetIds, ...existingAccountIds])].sort((a, b) => a - b);
  const targets = targetIds.length ? db.prepare(`SELECT id,type,enabled FROM targets WHERE id IN (${targetIds.map(() => '?').join(',')})`).all(...targetIds) : [];
  if (targets.length !== targetIds.length || targets.some(target => target.type !== 'account')) {
    throw new Error('团团并集包含缺失或非账号目标，停止写入');
  }
  const missingIds = targetIds.filter(id => !existingAccountIds.has(id));
  const enabled = targets.filter(target => target.enabled === 1).length;
  const paused = targets.filter(target => target.enabled !== 1).length;
  const missingEnabled = new Set(missingIds).size
    ? targets.filter(target => missingIds.includes(target.id) && target.enabled === 1).length : 0;
  return {
    rosterItemCount: roster.items.length,
    rosterTuantuanTargetCount: rosterTargetIds.size,
    existingAccountCount: existingAccountIds.size,
    existingNonAccountCount: existingRows.length - existingAccountIds.size,
    unionAccountCount: targetIds.length,
    enabled,
    paused,
    missingCount: missingIds.length,
    missingEnabled,
    missingPaused: missingIds.length - missingEnabled,
    targetIds,
    missingIds,
  };
}

function readonlyInspection() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const quick = db.prepare('PRAGMA quick_check').get()?.quick_check;
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    const runningRuns = db.prepare("SELECT count(*) AS count FROM runs WHERE status='running'").get().count;
    const targetBoardCount = db.prepare('SELECT count(*) AS count FROM target_boards').get().count;
    return { ...inspect(db), quick, foreignKeyViolations, runningRuns, targetBoardCount };
  } finally { db.close(); }
}

function assertSafe(state, { after = false } = {}) {
  if (state.quick !== 'ok' || state.foreignKeyViolations !== 0) throw new Error('数据库完整性检查未通过，停止写入');
  if (state.runningRuns !== 0) throw new Error('当前存在采集任务，停止写入');
  if (state.rosterTuantuanTargetCount !== expectedAccountCount || state.unionAccountCount !== expectedAccountCount) {
    throw new Error(`团团已定位账号并集应为 ${expectedAccountCount}，实际为 ${state.unionAccountCount}`);
  }
  const expectedMissing = after ? 0 : [0, expectedInitialMissing];
  if (after ? state.missingCount !== 0 : !expectedMissing.includes(state.missingCount)) {
    throw new Error(`团团板块缺口异常：${state.missingCount}`);
  }
}

const before = readonlyInspection();
assertSafe(before);
if (!apply) {
  console.log(JSON.stringify({ mode: 'dry-run', boardName, before: { ...before, targetIds: undefined, missingIds: undefined }, missingIds: before.missingIds }, null, 2));
  process.exit(0);
}
if (before.missingIds.length === 0) {
  console.log(JSON.stringify({ mode: 'already-applied', boardName,
    state: { ...before, targetIds: undefined, missingIds: undefined }, receiptPath }, null, 2));
  process.exit(0);
}

const database = new MonitorDatabase(databasePath);
let assignment;
try {
  assignment = database.assignTargetsToBoard(before.missingIds, boardName, {
    sourceType: 'user-confirmed-reconciliation',
    sourceFileName: 'MCN全部来源账号合并表-20261002.xlsx + 20261009来源',
    note: '2026-10-10 用户确认今日及此前团团来源均归一条小团团切片矩阵；仅补板块归属，不改启停与历史',
  });
} finally { database.close(); }

const after = readonlyInspection();
assertSafe(after, { after: true });
if (after.existingAccountCount !== expectedAccountCount || assignment.added !== before.missingCount
  || after.targetBoardCount !== before.targetBoardCount + before.missingCount) {
  throw new Error('写入后的成员数或关系增量不符合预期');
}
const receipt = {
  format: 'tuantuan-matrix-membership-reconciliation-v1',
  appliedAt: new Date().toISOString(),
  boardName,
  sourceDecision: '用户确认今天及此前提供的团团作者均属于团团切片矩阵；内容类型保留为二级标签',
  before: { ...before, targetIds: undefined, missingIds: undefined },
  assignment: { requestedCount: assignment.requestedCount ?? 0, uniqueTargetCount: assignment.uniqueTargetCount ?? 0,
    added: assignment.added, existing: assignment.existing },
  addedTargetIds: before.missingIds,
  after: { ...after, targetIds: undefined, missingIds: undefined },
  preserved: { targetEnabledStates: true, historicalMemberships: true, snapshots: true, posts: true },
};
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ mode: 'applied', receiptPath, ...receipt }, null, 2));

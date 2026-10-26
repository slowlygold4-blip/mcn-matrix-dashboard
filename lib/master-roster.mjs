import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readMasterRosterSupplementStates } from './master-roster-supplement.mjs';
import { extendMasterRosterWithLiveSources } from './master-roster-live-sources.mjs';
import { linkRosterProfiles } from './roster-profile-links.mjs';
import { extendMasterRosterWithCreatorSource } from './creator-source-bridge.mjs';

const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const unique = values => [...new Set(values.filter(Boolean))];
function targetPlatform(target) {
  try {
    const value = JSON.parse(target.metadata_json || '{}').platform ?? 'douyin';
    return ['douyin', 'bilibili', 'xiaohongshu', 'kuaishou'].includes(value) ? value : null;
  } catch { return null; }
}
export function rosterLink(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || [...url.searchParams.keys()].some(key => /token|cookie|api[_-]?key|password|secret|authorization|session|(?:^|_)auth(?:_|$)|signature|^(?:sig|credential|a_bogus|x-bogus)$/i.test(key))) return '';
    const host = url.hostname.toLowerCase();
    if (/^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[::1\])/.test(host) || /\.(?:local|internal)$/.test(host) || host.includes(':')) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}
const label = value => ({ key: text(value?.key, 120), label: text(value?.label, 200) });
const boardValue = value => ({
  name: text(value?.name ?? value?.board_name, 120),
  category: text(value?.category, 120),
  tier: text(value?.tier, 120),
  organization: text(value?.organization, 200),
});
const normalizedBoardName = value => text(value, 120).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
function mergeBoardValues(frozenBoards, currentBoards) {
  const result = (frozenBoards ?? []).map(boardValue);
  for (const current of currentBoards ?? []) {
    const incoming = boardValue(current);
    if (!incoming.name) continue;
    const exact = result.some(existing => ['name', 'category', 'tier', 'organization'].every(key => existing[key] === incoming[key]));
    if (exact) continue;
    const sameName = result.find(existing => normalizedBoardName(existing.name) === normalizedBoardName(incoming.name));
    if (sameName && ['category', 'tier', 'organization'].every(key => !sameName[key] || !incoming[key] || sameName[key] === incoming[key])) {
      for (const key of ['category', 'tier', 'organization']) if (!sameName[key]) sameName[key] = incoming[key];
      continue;
    }
    result.push(incoming);
  }
  return result;
}
function mergeCurrentTargetBoards(db, sourceItems) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='target_boards'").get();
  if (!table) return sourceItems;
  const columns = new Set(db.prepare('PRAGMA table_info(target_boards)').all().map(column => column.name));
  if (!['target_id', 'board_key', 'board_name', 'category', 'tier', 'organization'].every(column => columns.has(column))) return sourceItems;
  const byTarget = new Map();
  for (const row of db.prepare('SELECT target_id,board_name,category,tier,organization FROM target_boards ORDER BY target_id,board_key').all()) {
    if (!byTarget.has(row.target_id)) byTarget.set(row.target_id, []);
    byTarget.get(row.target_id).push(row);
  }
  return sourceItems.map(item => item.targetId && byTarget.has(item.targetId)
    ? { ...item, boards: mergeBoardValues(item.boards, byTarget.get(item.targetId)) }
    : item);
}
function reviewReason(value) {
  if (value && typeof value === 'object') {
    const fields = { category: '分类', tier: '等级', organization: '机构', note: '备注', owner: '负责人', filledDate: '填写时间' };
    return `表格${fields[value.field] || '资料'}与现有记录不同；保留原值，未自动覆盖。`;
  }
  return text(value, 1500)
    .replace(/(?:access[_-]?token|refresh[_-]?token|token|cookie|api[_-]?key|password|secret|authorization)\s*[:=]\s*[^\s;,，；]+/gi, '[敏感字段已隐藏]')
    .replace(/Bearer\s+[^\s;,]+/gi, 'Bearer [已隐藏]')
    .replace(/\/(?:Users|tmp|var|home)\/[^\s;,，；]+/g, '[本机路径已隐藏]');
}
function profile(platform, locator) {
  if (platform === 'douyin' && /^MS4wLj[\w-]{12,220}$/.test(locator)) return `https://www.douyin.com/user/${locator}`;
  if (platform === 'bilibili' && /^\d{2,20}$/.test(locator)) return `https://space.bilibili.com/${locator}`;
  return '';
}

// This is a roster, not a new monitoring or identity-verification result.
// Persist a whitelist projection: never import counters, enabled states or
// target metadata from a historical workbook over current production values.
export function buildMasterRosterSnapshot(source, workbook) {
  if (!Array.isArray(source?.entities) || !source.entities.length || source.entities.length > 20_000) throw new Error('总表记录为空或超出上限');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(source.exportedAt) || !Number.isFinite(Date.parse(source.exportedAt))) throw new Error('总表采样时间无效');
  if (!/^[a-f0-9]{64}$/.test(workbook?.sha256 ?? '')) throw new Error('总表文件校验值无效');
  const keys = new Set();
  const items = source.entities.map(entity => {
    if (entity.targetId !== '' && entity.targetId !== null && entity.targetId !== undefined && (!Number.isSafeInteger(Number(entity.targetId)) || Number(entity.targetId) <= 0)) throw new Error('总表 targetId 无效');
    const originalKey = text(entity.key, 300), targetId = Number(entity.targetId) || null;
    const key = targetId ? originalKey : `submitted:${entity.platform}:${createHash('sha256').update(originalKey).digest('hex')}`;
    if (!originalKey || keys.has(key)) throw new Error('总表条目键缺失或重复');
    keys.add(key);
    if (!['douyin', 'bilibili', 'xiaohongshu', 'kuaishou'].includes(entity.platform)) throw new Error('总表平台无效');
    if (targetId !== null && (!Number.isSafeInteger(targetId) || targetId <= 0 || key !== `target:${targetId}`)) throw new Error('总表既有账号键无效');
    if (targetId === null && originalKey.startsWith('target:')) throw new Error('总表既有账号身份缺失');
    const accountIds = unique((entity.ids ?? []).map(value => text(value, 120)));
    const locators = unique((entity.locators ?? []).map(value => text(value, 500)));
    if (targetId && !locators.length) throw new Error('既有账号缺少定位锚点');
    const sources = (entity.sources ?? []).map(source => ({
      url: rosterLink(source.url), title: text(source.title, 240), fileName: basename(text(source.file, 1000)), sheetName: text(source.sheet, 120),
      revision: text(source.revision, 120), readAt: text(source.readAt, 40), observedAt: text(source.observedAt, 40),
      rows: unique((source.rows ?? []).map(row => text(row, 40))),
    }));
    const reasons = unique([...(entity.errors ?? []), ...(entity.conflicts ?? [])].map(reviewReason));
    if (!targetId && !reasons.length) reasons.push('仅保留原始提交身份，尚未唯一定位；不计入经营指标。');
    return {
      key, targetId, platform: entity.platform,
      name: text(entity.currentName || entity.names?.[0] || accountIds[0] || '未填写名称', 240),
      originalNames: unique((entity.names ?? []).map(value => text(value, 240))), accountIds, locators,
      theme: label(entity.classification?.theme ?? { key: 'unassigned', label: '待归属' }),
      classifications: (entity.classification?.labels ?? []).map(label),
      monitorStatus: targetId ? (entity.enabled ? 'enabled' : 'paused') : 'pending',
      identityStatus: targetId ? '既有已定位账号' : '尚未唯一定位（非已监控账号）',
      profileLinks: unique(locators.map(locator => profile(entity.platform, locator)).filter(Boolean)),
      sourceLinks: unique(sources.map(source => source.url)), sourceTitles: unique(sources.map(source => source.title || source.fileName)), sources,
      boards: (entity.boards ?? []).map(board => ({ name: text(board.name, 120), category: text(board.category, 120), tier: text(board.tier, 120), organization: text(board.organization, 200) })),
      evidenceLinks: unique((entity.evidenceLinks ?? []).map(rosterLink)), reviewReasons: reasons,
      verificationAt: text(entity.verifiedAt, 40),
    };
  });
  return { format: 'mcn-master-roster-v1', snapshotAt: source.exportedAt,
    workbook: { fileName: basename(text(workbook.fileName, 240)), sha256: workbook.sha256 }, items };
}

export function installMasterRoster(db, snapshot, { now = new Date().toISOString() } = {}) {
  validateSnapshot(snapshot);
  const payload = JSON.stringify(snapshot), payloadSha256 = createHash('sha256').update(payload).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS master_roster_imports (
      id INTEGER PRIMARY KEY, workbook_sha256 TEXT NOT NULL UNIQUE, payload_sha256 TEXT NOT NULL,
      snapshot_at TEXT NOT NULL, imported_at TEXT NOT NULL, file_name TEXT NOT NULL, item_count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS master_roster_entries (
      import_id INTEGER NOT NULL REFERENCES master_roster_imports(id), entry_key TEXT NOT NULL,
      target_id INTEGER, payload_json TEXT NOT NULL, PRIMARY KEY(import_id,entry_key));`);
    const existing = db.prepare('SELECT * FROM master_roster_imports WHERE workbook_sha256=?').get(snapshot.workbook.sha256);
    if (existing) {
      if (existing.payload_sha256 !== payloadSha256 || existing.item_count !== snapshot.items.length) throw new Error('同一总表文件对应的资料发生变化，已拒绝覆盖原版本');
      const count = savedSnapshot(db, existing).items.length;
      db.exec('COMMIT'); return { imported: false, importId: existing.id, count, payloadSha256 };
    }
    // Check every registered anchor inside the same write transaction. A
    // target ID alone must never bind an unrelated or deleted account.
    const targetQuery = db.prepare("SELECT id,metadata_json,type,locator FROM targets WHERE id=?");
    for (const item of snapshot.items) {
      if (!item.targetId) continue;
      const target = targetQuery.get(item.targetId);
      if (!target || target.type !== 'account' || targetPlatform(target) !== item.platform || !item.locators.includes(target.locator)) throw new Error(`总表既有账号 ${item.targetId} 的定位锚点已改变；未写入任何资料`);
    }
    const result = db.prepare('INSERT INTO master_roster_imports(workbook_sha256,payload_sha256,snapshot_at,imported_at,file_name,item_count) VALUES(?,?,?,?,?,?)')
      .run(snapshot.workbook.sha256, payloadSha256, snapshot.snapshotAt, now, snapshot.workbook.fileName, snapshot.items.length);
    const importId = Number(result.lastInsertRowid);
    const insert = db.prepare('INSERT INTO master_roster_entries(import_id,entry_key,target_id,payload_json) VALUES(?,?,?,?)');
    for (const item of snapshot.items) insert.run(importId, item.key, item.targetId, JSON.stringify(item));
    db.exec('COMMIT'); return { imported: true, importId, count: snapshot.items.length, payloadSha256 };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function readMasterRoster(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='master_roster_imports'").get()) return null;
  db.exec('SAVEPOINT master_roster_read');
  try {
    const current = db.prepare('SELECT * FROM master_roster_imports ORDER BY id DESC LIMIT 1').get();
    if (!current) { db.exec('RELEASE master_roster_read'); return null; }
    const targets = new Map(db.prepare("SELECT id,label,metadata_json,locator,enabled FROM targets WHERE type='account'").all().map(target => [target.id, target]));
    const snapshot = savedSnapshot(db, current);
    const supplements = readMasterRosterSupplementStates(db, snapshot, targets);
    const frozenItems = snapshot.items.map(saved => {
      const supplemental = !saved.targetId ? supplements.get(saved.key) : null;
      if (supplemental?.binding) {
        const bound = targets.get(supplemental.binding.targetId);
        const { locators, ...item } = saved;
        return { ...item, targetId: bound.id, name: bound.label, monitorStatus: bound.enabled ? 'enabled' : 'paused',
          identityStatus: supplemental.binding.proofType.startsWith('strict-') ? '补充作品身份已核验；采样状态请查看账号详情' : '用户补充主页已建档；非平台身份核验，采样状态请查看账号详情',
          supplement: supplemental.supplement, ...(supplemental.identityCorrection ? {
            originalAccountIds: [...saved.accountIds], identityCorrection: supplemental.identityCorrection,
          } : {}) };
      }
      const target = targets.get(saved.targetId);
      const valid = target && targetPlatform(target) === saved.platform && saved.locators.includes(target.locator);
      const { locators, ...item } = saved;
      if (saved.targetId && !valid) return { ...item, targetId: null, monitorStatus: 'pending', identityStatus: '既有定位锚点已变，需重新核对', reviewReasons: [...item.reviewReasons, '未使用旧表条目键绑定当前账号。'] };
      return valid ? { ...item, name: target.label, monitorStatus: target.enabled ? 'enabled' : 'paused' }
        : { ...item, targetId: null, monitorStatus: 'pending', ...(supplemental ? { supplement: supplemental.supplement,
          ...(supplemental.identityCorrection ? { originalAccountIds: [...saved.accountIds], identityCorrection: supplemental.identityCorrection } : {}) } : {}) };
    });
    if (frozenItems.length !== current.item_count) throw new Error('总表持久化记录不完整');
    const live = extendMasterRosterWithLiveSources(db, frozenItems, { snapshotAt: current.snapshot_at, safeLink: rosterLink });
    const linked = linkRosterProfiles(db, live.items);
    const creatorSource = extendMasterRosterWithCreatorSource(db, linked.items);
    const items = mergeCurrentTargetBoards(db, creatorSource.items);
    const linkedEntryCount = linked.linkedEntryCount;
    const liveSources = { ...live.summary, profileLinkedEntryCount: linkedEntryCount,
      addedEntryCount: items.filter(item => item.liveSource === true).length };
    const enabled = items.filter(item => item.monitorStatus === 'enabled').length;
    const paused = items.filter(item => item.monitorStatus === 'paused').length;
    db.exec('RELEASE master_roster_read');
    return { snapshotAt: current.snapshot_at, importedAt: current.imported_at,
      workbook: { fileName: current.file_name, sha256: current.workbook_sha256 },
      summary: { total: items.length, registered: enabled + paused, enabled, paused, pending: items.length - enabled - paused },
      liveSources, creatorSource: creatorSource.summary, items };
  } catch (error) { db.exec('ROLLBACK TO master_roster_read'); db.exec('RELEASE master_roster_read'); throw error; }
}

/** Internal provenance read. Never expose raw locators or mutate the snapshot. */
export function readMasterRosterEntry(db, { workbookSha256, entryKey } = {}) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='master_roster_imports'").get()) fail(404, '尚未导入账号总表');
  const current = db.prepare('SELECT * FROM master_roster_imports ORDER BY id DESC LIMIT 1').get();
  if (!current) fail(404, '尚未导入账号总表');
  if (current.workbook_sha256 !== workbookSha256) fail(409, '总表版本已变化，请刷新后再补充');
  const snapshot = savedSnapshot(db, current);
  const item = snapshot.items.find(value => value.key === entryKey);
  if (!item) fail(404, '未找到这条总表资料');
  if (item.targetId) fail(409, '该总表条目原本已建档，请在账号详情管理，不能从待核对补充入口更换账号');
  const targets = new Map(db.prepare("SELECT id,label,metadata_json,locator,enabled FROM targets WHERE type='account'").all().map(target => [target.id, target]));
  return { item, workbookSha256, entryPayloadSha256: createHash('sha256').update(JSON.stringify(item)).digest('hex'),
    supplementState: readMasterRosterSupplementStates(db, snapshot, targets).get(item.key) ?? null };
}

function validateSnapshot(snapshot) {
  const only = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key));
  const strings = value => Array.isArray(value) && value.length <= 20_000 && value.every(item => typeof item === 'string');
  if (!only(snapshot, ['format', 'snapshotAt', 'workbook', 'items']) || snapshot.format !== 'mcn-master-roster-v1'
    || !Number.isFinite(Date.parse(snapshot.snapshotAt)) || !only(snapshot.workbook, ['fileName', 'sha256'])
    || typeof snapshot.workbook.fileName !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.workbook.sha256)
    || !Array.isArray(snapshot.items) || !snapshot.items.length || snapshot.items.length > 20_000) throw new Error('总表快照格式无效');
  const keys = new Set();
  for (const item of snapshot.items) {
    const allowed = ['key', 'targetId', 'platform', 'name', 'originalNames', 'accountIds', 'locators', 'theme', 'classifications', 'monitorStatus', 'identityStatus', 'profileLinks', 'sourceLinks', 'sourceTitles', 'sources', 'boards', 'evidenceLinks', 'reviewReasons', 'verificationAt'];
    if (!only(item, allowed) || typeof item.key !== 'string' || !item.key || keys.has(item.key)
      || !['douyin', 'bilibili', 'xiaohongshu', 'kuaishou'].includes(item.platform)
      || !(item.targetId === null || Number.isSafeInteger(item.targetId) && item.targetId > 0)
      || (item.targetId === null ? item.monitorStatus !== 'pending' : !['enabled', 'paused'].includes(item.monitorStatus) || item.key !== `target:${item.targetId}`)
      || !['name', 'identityStatus', 'verificationAt'].every(key => typeof item[key] === 'string')
      || !['originalNames', 'accountIds', 'locators', 'profileLinks', 'sourceLinks', 'sourceTitles', 'evidenceLinks', 'reviewReasons'].every(key => strings(item[key]))
      || !only(item.theme, ['key', 'label']) || ![item.theme.key, item.theme.label].every(value => typeof value === 'string')
      || !Array.isArray(item.classifications) || !item.classifications.every(value => only(value, ['key', 'label']) && typeof value.key === 'string' && typeof value.label === 'string')
      || !Array.isArray(item.sources) || !item.sources.every(source => only(source, ['url', 'title', 'fileName', 'sheetName', 'revision', 'readAt', 'observedAt', 'rows']) && strings(source.rows) && ['url', 'title', 'fileName', 'sheetName', 'revision', 'readAt', 'observedAt'].every(key => typeof source[key] === 'string'))
      || !Array.isArray(item.boards) || !item.boards.every(board => only(board, ['name', 'category', 'tier', 'organization']) && ['name', 'category', 'tier', 'organization'].every(key => typeof board[key] === 'string'))) throw new Error('总表条目格式无效或包含未批准字段');
    if (item.targetId && !item.locators.length) throw new Error('既有账号缺少定位锚点');
    for (const url of [...item.profileLinks, ...item.sourceLinks, ...item.evidenceLinks, ...item.sources.map(source => source.url).filter(Boolean)]) {
      if (rosterLink(url) !== url) throw new Error('总表包含不安全的链接');
    }
    keys.add(item.key);
  }
}

function savedSnapshot(db, current) {
  const snapshot = { format: 'mcn-master-roster-v1', snapshotAt: current.snapshot_at,
    workbook: { fileName: current.file_name, sha256: current.workbook_sha256 },
    items: db.prepare('SELECT payload_json FROM master_roster_entries WHERE import_id=? ORDER BY rowid').all(current.id).map(row => JSON.parse(row.payload_json)) };
  if (snapshot.items.length !== current.item_count || createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') !== current.payload_sha256) throw new Error('总表持久化内容与校验值不一致');
  validateSnapshot(snapshot); return snapshot;
}

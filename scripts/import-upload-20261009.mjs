import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseAuthorSpreadsheet } from '../lib/author-spreadsheet.mjs';

const source = '/Users/tyke/Downloads/一条小团团切片作品登记表.xlsx';
const fileName = '一条小团团切片作品登记表.xlsx';
const directory = 'data/maintenance-journal/20261009-upload';
const board = '一条小团团切片矩阵';
const base = 'http://127.0.0.1:4188';
const action = process.argv[2];
if (!['preview', 'submit', 'status', 'assign-existing'].includes(action)) throw new Error('Use preview, submit, status or assign-existing');
await mkdir(directory, { recursive: true });
const buffer = await readFile(source);
const sha256 = createHash('sha256').update(buffer).digest('hex');
const boot = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(15_000) });
const cookie = boot.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const auth = await boot.json();
if (!boot.ok || !auth?.permissions?.edit || !auth?.csrfToken) throw new Error('Local editor session unavailable');
const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': auth.csrfToken, origin: base };
async function api(path, body) {
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(120_000), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${value.error || value.message || 'request failed'}`);
  return value;
}
async function save(name, value) { await writeFile(`${directory}/${name}.json`, JSON.stringify(value, null, 2)); }
if (action === 'preview') {
  const local = await parseAuthorSpreadsheet({ buffer, fileName, includeAllSheets: true });
  const preview = await api('/api/author-spreadsheet/batch-preview', { fileName, contentBase64: buffer.toString('base64') });
  if (preview.uploadSha256 !== sha256) throw new Error('Upload hash mismatch');
  for (const sheet of local.sheetPreviews.filter(item => item.importable)) {
    const remote = preview.sheets.find(item => item.name === sheet.name);
    if (!remote?.importable || remote.rowCount !== sheet.rows.length) throw new Error('Local/API row count mismatch');
  }
  const db = new DatabaseSync('data/douyin-monitor.sqlite', { readOnly: true });
  const targets = db.prepare('SELECT id,enabled,metadata_json FROM targets WHERE type=?').all('account');
  const norm = v => String(v || '').normalize('NFKC').trim().toLowerCase();
  const groups = new Map();
  for (const sheet of local.sheetPreviews.filter(item => item.importable)) for (const row of sheet.rows) {
    const key = norm(row.douyinId);
    if (!groups.has(key)) groups.set(key, { id: key, names: [], sourceRows: [] });
    const group = groups.get(key); group.names = [...new Set([...group.names, row.name])]; group.sourceRows.push(row.sourceRow);
  }
  const accounts = [...groups.values()].map(group => ({ ...group, candidates: targets.filter(target => {
    const meta = JSON.parse(target.metadata_json);
    return [meta.douyinId, meta.resolution?.publicDouyinId].filter(Boolean).some(value => norm(value) === group.id);
  }).map(target => ({ targetId: target.id, enabled: !!target.enabled })) }));
  const before = { sha256, at: new Date().toISOString(), rows: preview.totalAuthorRows, accountIds: accounts.length,
    existingUnique: accounts.filter(a => a.candidates.length === 1).length,
    noExactTarget: accounts.filter(a => !a.candidates.length).length,
    conflicts: accounts.filter(a => a.candidates.length > 1).length,
    originalTargetCount: targets.length,
    snapshotCount: db.prepare('SELECT count(*) n FROM snapshots').get().n,
    assignments: preview.sheets.filter(s => s.importable).map(s => ({ sheetName: s.name, defaultBoard: board, idempotencyKey: randomUUID() })) };
  db.close();
  // Preserve the original bytes, including registration evidence and dates.
  await copyFile(source, `${directory}/source.xlsx`);
  await save('preview', preview); await save('parsed-rows', local.sheetPreviews); await save('before', before); await save('accounts-before', accounts);
  console.log(JSON.stringify({ ...before, sheets: preview.sheets.map(s => ({ name: s.name, rows: s.rowCount, importable: s.importable })) }));
} else if (action === 'submit') {
  const before = JSON.parse(await readFile(`${directory}/before.json`, 'utf8'));
  if (before.sha256 !== sha256) throw new Error('Original file changed after preview');
  // Repeated invocations reuse the persisted per-sheet idempotency key.
  const result = await api('/api/author-spreadsheet/auto-monitor-batch', {
    fileName, contentBase64: buffer.toString('base64'), uploadSha256: sha256, assignments: before.assignments,
  });
  await save('submitted', { at: new Date().toISOString(), ...result });
  console.log(JSON.stringify({ accepted: result.acceptedCount, replayed: result.replayedCount, rejected: result.rejectedCount,
    jobs: result.results.map(r => ({ sheet: r.sheetName, id: r.job?.id, status: r.status, error: r.error })) }));
} else if (action === 'assign-existing') {
  const before = JSON.parse(await readFile(`${directory}/before.json`, 'utf8'));
  if (before.sha256 !== sha256) throw new Error('Source changed after audit');
  const accounts = JSON.parse(await readFile(`${directory}/accounts-before.json`, 'utf8'));
  const db = new DatabaseSync('data/douyin-monitor.sqlite', { readOnly: true });
  const norm = value => String(value || '').normalize('NFKC').trim().toLowerCase();
  const assignments = [];
  for (const account of accounts.filter(a => a.candidates.length === 1)) {
    const original = account.candidates[0];
    const target = db.prepare('SELECT id,enabled,metadata_json FROM targets WHERE id=?').get(original.targetId);
    if (!target || !!target.enabled !== original.enabled) throw new Error('Target status changed during review');
    const meta = JSON.parse(target.metadata_json);
    if (![meta.douyinId, meta.resolution?.publicDouyinId].filter(Boolean).some(value => norm(value) === account.id)) throw new Error('Target identity changed');
    if (!db.prepare('SELECT 1 FROM target_boards WHERE target_id=? AND board_name=?').get(target.id, board)) assignments.push({ targetId: target.id, enabled: !!target.enabled, submittedId: account.id, rows: account.sourceRows });
  }
  db.close();
  const result = assignments.length ? await api('/api/boards/assign', { name: board, targetIds: assignments.map(a => a.targetId),
    note: `用户提供 ${fileName}；SHA256 ${sha256}；仅按已建档抖音号精确归类，保留启停与历史，未将作品填报数字记为采样。` }) : { added: 0 };
  await save('assigned-existing', { at: new Date().toISOString(), sha256, assignments, result });
  console.log(JSON.stringify({ assigned: assignments.length, added: result.added }));
} else {
  const submitted = JSON.parse(await readFile(`${directory}/submitted.json`, 'utf8'));
  const jobs = [];
  for (const item of submitted.results) if (item.job?.id) jobs.push(await api(`/api/author-spreadsheet/jobs/${item.job.id}`));
  await save('status', { at: new Date().toISOString(), jobs });
  console.log(JSON.stringify(jobs.map(j => ({ id: j.id, status: j.status, phase: j.phase, error: j.error,
    identity: j.inputAccountIdentitySummary, result: j.result && Object.fromEntries(Object.entries(j.result).filter(([k,v]) => v === null || typeof v !== 'object')) }))));
}

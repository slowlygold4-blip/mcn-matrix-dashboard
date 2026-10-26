import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const directory = 'data/tuantuan-hotspot-onikEQ';
const board = '一条小团团切片矩阵';
const source = JSON.parse(await readFile(`${directory}/source-audit.json`, 'utf8'));
const action = process.argv[2];
if (!['assign-existing', 'submit', 'status'].includes(action)) throw new Error('Unknown action');
const base = 'http://127.0.0.1:4188';
const response = await fetch(`${base}/api/bootstrap`);
const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const { auth } = await response.json();
if (!response.ok || !auth?.csrfToken) throw new Error('Local authentication failed');
const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': auth.csrfToken, origin: base };
const request = async (path, body) => {
  const result = await fetch(`${base}${path}`, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const value = await result.json();
  if (!result.ok) throw new Error(`${result.status}: ${value.error || 'Request failed'}`);
  return value;
};
const guardNewReceipt = async name => {
  try { await readFile(`${directory}/${name}`); throw new Error('This action has already been completed'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await readFile(`${directory}/before.sqlite`);
};
if (action === 'assign-existing') {
  await guardNewReceipt('existing-assignment.json');
  const matching = JSON.parse(await readFile(`${directory}/matching-audit.json`, 'utf8'));
  if (matching.summary.sourceIdentityCollisionCount || matching.databaseIdCollisions.length) throw new Error('Identity collision requires review');
  const matches = matching.existingTargets.filter(target => !target.alreadyInBoard);
  const db = new DatabaseSync('data/douyin-monitor.sqlite', { readOnly: true });
  const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
  for (const match of matches) {
    const target = db.prepare('SELECT * FROM targets WHERE id=?').get(match.id);
    if (!target || Boolean(target.enabled) !== match.enabled) throw new Error('Target changed since audit');
    const metadata = JSON.parse(target.metadata_json);
    const ids = new Set([metadata.douyinId, metadata.resolution?.publicDouyinId].map(normalize));
    if (!match.matchedSubmittedIds.length || match.matchedSubmittedIds.some(id => !ids.has(normalize(id)))) throw new Error('Existing account ID changed');
  }
  db.close();
  const result = await request('/api/boards/assign', { name: board, targetIds: matches.map(target => target.id),
    note: `来源：${source.title}；修订${source.revision}；${source.wikiUrl}。按已核实账号ID精确归类，保留启停状态；作品证据独立核验。` });
  await writeFile(`${directory}/existing-assignment.json`, JSON.stringify({ readAt: new Date().toISOString(),
    sourceRevision: source.revision, sourceValuesSha256: source.sourceValuesSha256, matches, result }, null, 2));
  console.log(JSON.stringify({ added: result.added, existing: result.existing, targetCount: matches.length }));
} else if (action === 'submit') {
  await guardNewReceipt('submitted-job.json');
  const preview = JSON.parse(await readFile(`${directory}/app-preview-verified.json`, 'utf8'));
  const validation = JSON.parse(await readFile(`${directory}/preview-validation.json`, 'utf8'));
  if (!validation.accepted || preview.rows.length !== source.rowCount || preview.source.revision !== source.revision
    || validation.contentSha256 !== preview.source.contentSha256) throw new Error('Missing audited corrected cloud preview');
  const job = await request('/api/author-spreadsheet/auto-monitor', { sourceType: 'lark-sheet',
    sourceUrl: preview.source.url, sourceSha256: preview.source.contentSha256, sourceRevision: preview.source.revision,
    sheetName: preview.selectedSheet, defaultBoard: board });
  await writeFile(`${directory}/submitted-job.json`, JSON.stringify(job, null, 2));
  console.log(JSON.stringify(job));
} else {
  const submitted = JSON.parse(await readFile(`${directory}/submitted-job.json`, 'utf8'));
  const [job, all, queue] = await Promise.all([
    request(`/api/author-spreadsheet/jobs/${submitted.id}`), request('/api/targets'),
    request(`/api/author-resolution-queue?board=${encodeURIComponent(board)}&status=all&limit=500`),
  ]);
  const targets = all.targets.filter(target => target.boards?.some(item => item.name === board));
  await writeFile(`${directory}/app-status.json`, JSON.stringify({ readAt: new Date().toISOString(), job, targets, queue }, null, 2));
  const { skipped, created, boardFieldConflicts, ...result } = job.result || {};
  console.log(JSON.stringify({ job: { ...job, result }, targetCount: targets.length,
    enabledCount: targets.filter(target => target.enabled).length, queue: queue.summary }));
}

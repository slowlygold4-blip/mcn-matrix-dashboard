import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildCreatorIntelligence, canonicalSourceAuthors } from '../lib/creator-intelligence.mjs';
import { sourceTrackMemberships } from '../lib/source-ledger-track.mjs';
import {readValidatedCurrentSourceLinks} from '../lib/current-source-link-bridge.mjs';

// Public projection of the imported Feishu workbook. Never export the raw sheets:
// they also contain authorization, rewards, source-row evidence and other private fields.
const [databasePath, outputDirectory, monitorPath] = process.argv.slice(2);
if (!databasePath?.startsWith('/') || !outputDirectory?.startsWith('/')) {
  throw new Error('Supply an absolute SQLite path and absolute public output directory');
}
if (monitorPath !== undefined && !monitorPath.startsWith('/')) throw new Error('Supply an absolute monitor SQLite path');
if (!monitorPath) process.stderr.write('未提供主库路径：仅导出冻结关联，不包含之后核验成功的作者链接。\n');
const text = (value, limit = 240) => value == null ? '' : String(value)
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/<[^>]*>/g, '')
  .trim().slice(0, limit);
const integer = value => {
  if (value == null || typeof value === 'boolean' || typeof value === 'object' || typeof value === 'string' && !value.trim()) return null;
  const number = Number(String(value).replaceAll(',', ''));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const publicUrl = value => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && /(^|\.)douyin\.com$/.test(url.hostname)
      ? (url.origin + url.pathname).slice(0, 600) : null;
  } catch { return null; }
};
const hash = value => createHash('sha256').update(value).digest('hex');
const db = new DatabaseSync(resolve(databasePath), { readOnly: true });
const monitor = monitorPath ? new DatabaseSync(resolve(monitorPath), { readOnly: true }) : null;
let manifest;
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  if (monitor) monitor.exec('PRAGMA query_only=ON; BEGIN');
  const latest = db.prepare('SELECT * FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
  if (!latest) throw new Error('No creator-source import');
  const rows = sheetId => db.prepare('SELECT row_number,values_json FROM source_rows WHERE sheet_id=? ORDER BY row_number').all(sheetId);
  const links = new Map();
  let linkMode = 'frozen', linkFingerprint = '';
  let linkedRows = db.prepare('SELECT author_row,target_id FROM account_links ORDER BY author_row,target_id').all();
  if (monitor) {
    const currentLinks = await readValidatedCurrentSourceLinks(db,monitor,monitorPath);
    linkedRows = currentLinks.accountLinks;
    linkMode = currentLinks.mode;
    linkFingerprint = currentLinks.fingerprint;
  } else {
    linkFingerprint = hash(JSON.stringify(linkedRows));
  }
  for (const row of linkedRows) {
    const items = links.get(row.author_row) ?? [];
    items.push(row.target_id);
    links.set(row.author_row, items);
  }
  const rawAuthors = rows('08').map(({ row_number, values_json }) => {
    const row = JSON.parse(values_json);
    return { row: row_number, name: text(row[0], 160), douyinId: text(row[1], 120),
      posts: integer(row[6]), slicePosts: integer(row[7]), creationPosts: integer(row[8]),
      aiPosts: integer(row[9]), cupPosts: integer(row[10]), plays: integer(row[11]),
      likes: integer(row[12]), followers: integer(row[14]), targetIds: links.get(row_number) ?? [] };
  });
  const {authors,collapsed} = canonicalSourceAuthors(rawAuthors);
  const works = rows('09').map(({ row_number, values_json }) => {
    const row = JSON.parse(values_json);
    return { row: row_number, contentId: text(row[0], 80), author: text(row[1], 160),
      douyinId: text(row[2], 120), publishDate: text(row[3], 40), type: text(row[4], 80),
      track: text(row[5], 100), tracks: text(row[6], 180), plays: integer(row[7]),
      likes: integer(row[8]), title: text(row[10], 300), url: publicUrl(row[11]) };
  });
  // Finish date/identity validation before touching the published partitions.
  const insights = buildCreatorIntelligence(authors, works);
  const stats = { authors: authors.length, rawAuthorRows: rawAuthors.length, reciprocalDuplicates: collapsed.length, works: works.length,
    datedWorks: insights.counts.datedWorks, undatedWorks: insights.counts.undatedWorks,
    linkedAuthors: authors.filter(author => author.targetIds.length > 0).length,
    worksWithPlays: works.filter(work => work.plays !== null).length,
    worksWithLikes: works.filter(work => work.likes !== null).length,
    cumulativePlays: works.reduce((sum, work) => sum + (work.plays ?? 0), 0),
    cumulativeLikes: works.reduce((sum, work) => sum + (work.likes ?? 0), 0) };
  const tracks = new Map();
  for (const work of works) {
    for (const key of sourceTrackMemberships(work)) {
      const stat = tracks.get(key) ?? { name: key, works: 0, cumulativePlays: 0,
        cumulativeLikes: 0, authorKeys: new Set() };
      stat.works++;
      stat.cumulativePlays += work.plays ?? 0;
      stat.cumulativeLikes += work.likes ?? 0;
      stat.authorKeys.add(`${work.douyinId}\u0000${work.author}`);
      tracks.set(key, stat);
    }
  }
  const files = [], prepared = [];
  function prepare(name, items) {
    const body = JSON.stringify({ revision: latest.source_revision, items }) + '\n';
    prepared.push({ name, body });
    files.push({ path: name, count: items.length, bytes: Buffer.byteLength(body), sha256: hash(body) });
  }
  prepare('authors.json', authors);
  for (let index = 0; index < works.length; index += 1000) {
    prepare(`works-${String(index / 1000 + 1).padStart(3, '0')}.json`, works.slice(index, index + 1000));
  }
  prepare('insights.json', [insights]);
  manifest = { version: 1, revision: latest.source_revision, sourceModifiedAt: latest.source_modified_at,
    linkMode, linkFingerprint,
    importedAt: latest.imported_at, sourceRows: latest.source_row_count, stats,
    tracks: [...tracks.values()].map(({ authorKeys, ...track }) => ({ ...track, authors: authorKeys.size }))
      .sort((a, b) => b.works - a.works), files,
    semantics: { plays: '来源表中作品的累计播放，不是区间新增，也不是本机重新采集的实际播放',
      likes: '来源表中作品的累计点赞，不是账号主页获赞或区间新增',
      missing: '空值不补零', privacy: '仅发布作者与去重作品的必要公开字段；授权、奖金和原始来源明细未发布' } };
  const indexBody = JSON.stringify(manifest) + '\n';
  await mkdir(outputDirectory, { recursive: true });
  for (const { name, body } of prepared) await writeFile(join(outputDirectory, name), body);
  await writeFile(join(outputDirectory, 'index.json'), indexBody);
  db.exec('ROLLBACK');
  if (monitor) monitor.exec('ROLLBACK');
} finally { try { db.exec('ROLLBACK'); } catch {} try { monitor?.exec('ROLLBACK'); } catch {} db.close(); monitor?.close(); }
console.log(JSON.stringify({ revision: manifest.revision, stats: manifest.stats, files: manifest.files.length }));

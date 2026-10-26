import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const baseToken = 'VMdZbsT6uajUg4s9wtNcRjZtnEh';
const tableId = 'tblvx0Q1ZmVx88Er';
const wikiUrl = 'https://ccnmwvgvsr3v.feishu.cn/wiki/FbWFw55aqibiMFkig84cKbvhnNe';
const expected = ['reczz28QRP7wc1z2', 'reczz28QTcRHU8cS'];
const cli = args => {
  const output = execFileSync('lark-cli', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4_000_000 });
  const start = output.indexOf('{\n  "ok"');
  if (start < 0) throw new Error('飞书返回无法解析');
  const result = JSON.parse(output.slice(start));
  if (!result.ok) throw new Error(`飞书读取失败：${JSON.stringify(result.error)}`);
  return result.data;
};
const node = cli(['wiki', '+node-get', '--node-token', wikiUrl, '--as', 'user', '--format', 'json']);
if (node.obj_type !== 'bitable' || node.obj_token !== baseToken) throw new Error('授权登记来源对象发生变化');
const records = cli(['base', '+record-get', '--base-token', baseToken, '--table-id', tableId,
  ...expected.flatMap(id => ['--record-id', id]), '--field-id', '抖音ID', '--field-id', '抖音名称',
  '--field-id', '内容类型选项', '--as', 'user', '--format', 'json']);
if (records.record_id_list.length !== expected.length || records.record_id_list.some((id, i) => id !== expected[i]))
  throw new Error('新增登记记录 ID 不匹配');
const db = new DatabaseSync(resolve(root, 'data/douyin-monitor.sqlite'));
db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON');
try {
  const old = new Set(db.prepare("SELECT values_json FROM source_rows WHERE sheet_id='11'").all()
    .map(row => JSON.parse(row.values_json)).filter(row => row[1] === 'slice_registry').map(row => row[0]));
  const existingAuthors = new Set(db.prepare("SELECT values_json FROM source_rows WHERE sheet_id='08'").all()
    .map(row => String(JSON.parse(row.values_json)[1] ?? '').normalize('NFKC').toLowerCase()));
  const additions = records.record_id_list.map((recordId, i) => {
    const [accountId, authorName, labels] = records.data[i];
    if (old.has(recordId) || !accountId || !authorName || !Array.isArray(labels))
      throw new Error(`新增授权记录的去重键或字段不符合预期：${recordId}`);
    const normalizedId = String(accountId).normalize('NFKC').toLowerCase();
    if (!existingAuthors.has(normalizedId)) throw new Error(`新增授权记录不是现有来源作者：${recordId}`);
    const matches = db.prepare(`SELECT id,metadata_json FROM targets WHERE type='account' AND
      (json_extract(metadata_json,'$.douyinId')=? OR json_extract(metadata_json,'$.resolution.publicDouyinId')=?)`)
      .all(String(accountId), String(accountId));
    if (matches.length !== 1) throw new Error(`新增授权记录无法唯一关联现有监控账号：${recordId}`);
    return { recordId, accountId: String(accountId), authorName: String(authorName), labels, targetId: matches[0].id };
  });
  db.exec(`CREATE TABLE IF NOT EXISTS creator_source_registry_additions(
    base_token TEXT NOT NULL, table_id TEXT NOT NULL, record_id TEXT NOT NULL,
    source_rev INTEGER NOT NULL, source_modified_at TEXT NOT NULL, observed_at TEXT NOT NULL,
    author_name TEXT NOT NULL, account_id TEXT NOT NULL, classification_json TEXT NOT NULL,
    target_id INTEGER NOT NULL, source_url TEXT NOT NULL,
    PRIMARY KEY(base_token,record_id,source_rev));`);
  const read = db.prepare('SELECT * FROM creator_source_registry_additions WHERE base_token=? AND record_id=? AND source_rev=?');
  const insert = db.prepare(`INSERT INTO creator_source_registry_additions
    (base_token,table_id,record_id,source_rev,source_modified_at,observed_at,author_name,account_id,classification_json,target_id,source_url)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const observedAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  let inserted = 0;
  try {
    for (const row of additions) {
      const prior = read.get(baseToken, row.recordId, records.rev);
      if (prior) {
        if (prior.account_id !== row.accountId || prior.target_id !== row.targetId || prior.author_name !== row.authorName
          || prior.classification_json !== JSON.stringify(row.labels)) throw new Error(`同版本授权证据已变化：${row.recordId}`);
        continue;
      }
      insert.run(baseToken, tableId, row.recordId, records.rev, node.updated_at, observedAt,
        row.authorName, row.accountId, JSON.stringify(row.labels), row.targetId, wikiUrl);
      inserted++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log(JSON.stringify({ status: inserted ? 'imported' : 'unchanged', inserted, sourceRev: records.rev,
    sourceModifiedAt: node.updated_at, records: additions.map(({ recordId, accountId, authorName, targetId }) =>
      ({ recordId, accountId, authorName, targetId })) }));
} finally { db.close(); }

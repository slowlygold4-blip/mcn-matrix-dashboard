import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) throw new Error('请提供发布前快照和验收输出路径');
const db = new DatabaseSync(new URL('../data/douyin-monitor.sqlite', import.meta.url), { readOnly: true });
try {
  db.prepare('ATTACH DATABASE ? AS before_release').run(baselinePath);
  const tables = {};
  for (const table of ['targets', 'target_boards', 'board_catalog', 'snapshots', 'posts', 'post_metrics']) {
    tables[table] = {
      before: db.prepare(`SELECT COUNT(*) AS count FROM before_release.${table}`).get().count,
      after: db.prepare(`SELECT COUNT(*) AS count FROM main.${table}`).get().count,
      missingOrChangedOriginalRows: db.prepare(`SELECT COUNT(*) AS count FROM (SELECT * FROM before_release.${table} EXCEPT SELECT * FROM main.${table})`).get().count,
    };
  }
  const integrity = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
  const result = { checkedAt: new Date().toISOString(), ok: Object.values(tables).every((table) => table.missingOrChangedOriginalRows === 0) && integrity.every((value) => value === 'ok'), tables, integrity };
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally { db.close(); }

/** Deterministic, read-only full-workbook reconciliation. No network or model. */
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { readWorkSourceWorkbook, reconcileWorkSourceFacts, bindWorkFactsToStoredSourceIds } from '../lib/work-source-workbook.mjs';
import { storedWorkLinkEvidence } from '../lib/work-source-overlay.mjs';

export function reconcileWorkSourceFile({ inputPath, databasePath }) {
  const input = realpathSync(inputPath), database = realpathSync(databasePath);
  if (input === database) throw new Error('来源与数据库不能相同');
  const source = readWorkSourceWorkbook(readFileSync(input));
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const imported = db.prepare('SELECT id,source_sha256,source_revision FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
    if (!imported) throw new Error('目标库没有已审查的作者作品总表；未创建空基准');
    const canonical = db.prepare("SELECT values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='09' ORDER BY row_number").all(imported.id)
      .map(row => {
        const values = JSON.parse(row.values_json);
        return { contentId: String(values[0]), plays: values[7] ?? null, likes: values[8] ?? null };
      });
    const storedLinks = storedWorkLinkEvidence(db, imported.id);
    const binding = bindWorkFactsToStoredSourceIds(source.facts, storedLinks, new Set(canonical.map(row => row.contentId)));
    const reconciliation = reconcileWorkSourceFacts(binding.facts, canonical);
    const writes = db.prepare('SELECT total_changes() n').get().n;
    if (writes !== 0) throw new Error('只读对账不应发生数据库写入');
    db.exec('COMMIT');
    return { mode: 'read-only-dry-run', generatedAt: new Date().toISOString(),
      runtimeAI: false, networkRequests: 0, databaseWrites: writes,
      canonical: { importId: imported.id, sourceSha256: imported.source_sha256,
        revision: imported.source_revision, workCount: canonical.length },
      source: { sourceSha256: source.sourceSha256, summary: source.summary, sheets: source.sheets,
        rejected: source.rejected },
      binding: binding.summary, reconciliation, facts: binding.facts };
  } finally { db.close(); }
}

function main() {
  const flags = new Map();
  const allowed = new Set(['--input', '--database', '--output-directory']);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || flags.has(args[i]))
      throw new Error('用法：node scripts/reconcile-work-source-workbook.mjs --input 原件.xlsx --database 主库.sqlite --output-directory 新证据目录');
    flags.set(args[i], args[i + 1]);
  }
  if (flags.size !== 3) throw new Error('请明确提供来源、现有数据库与新证据目录');
  const output = resolve(flags.get('--output-directory'));
  // Never overwrite prior evidence. Raw facts contain business data and stay
  // private; only the bounded summary is printed to the console.
  mkdirSync(output, { mode: 0o700, recursive: false });
  const result = reconcileWorkSourceFile({ inputPath: flags.get('--input'), databasePath: flags.get('--database') });
  const jsonLines = rows => gzipSync(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  writeFileSync(join(output, 'work-facts.jsonl.gz'), jsonLines(result.facts), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(output, 'work-reconciliation.jsonl.gz'), jsonLines(result.reconciliation.works), { mode: 0o600, flag: 'wx' });
  const { facts, reconciliation, ...report } = result;
  writeFileSync(join(output, 'reconciliation.json'), JSON.stringify({ ...report,
    reconciliation: { summary: reconciliation.summary, workDetails: 'work-reconciliation.jsonl.gz' } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ mode: result.mode, source: result.source.summary,
    canonical: result.canonical, binding: result.binding, comparison: result.reconciliation.summary,
    runtimeAI: false, networkRequests: 0, databaseWrites: result.databaseWrites }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

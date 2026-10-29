import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeBoardKey } from '../lib/database.mjs';
import { readFullRosterMonitoringAudit } from '../lib/full-roster-monitoring-audit.mjs';

const defaultRoot = resolve(import.meta.dirname, '..');
export function resolveRosterBuilderPath(root, env = process.env) {
  const explicit = env.MCN_SITE_ROOT;
  if (explicit !== undefined) {
    if (!explicit.trim()) throw Error('invalid_site_root');
    const path = resolve(explicit, 'lib/tuantuan-roster.mjs');
    if (!existsSync(path)) throw Error('invalid_site_root');
    return path;
  }
  for (const path of [resolve(root, 'frontend/lib/tuantuan-roster.mjs'),
    resolve(root, '../mcn-public-site/lib/tuantuan-roster.mjs')]) if (existsSync(path)) return path;
  throw Error('roster_builder_missing');
}

export function parseAuditArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--database' || arg === '--out') {
      const key = arg === '--database' ? 'database' : 'out';
      if (!args[i + 1] || args[i + 1].startsWith('--') || options[key]) throw Error('invalid_arguments');
      options[key] = args[++i];
    } else if (args.length === 1 && !arg.startsWith('-')) options.out = arg; // Existing positional output usage.
    else throw Error('invalid_arguments');
  }
  return options;
}

export function saveMonitoringAudit(report, out, { root = defaultRoot } = {}) {
  const bjt = new Date(Date.parse(report.generatedAt) + 8 * 3600000).toISOString();
  const suffix = bjt.slice(11, 23).replace(/[:.]/g, '');
  const path = resolve(root, out ?? `data/maintenance-journal/${bjt.slice(0, 10)}-full-roster-monitoring-${suffix}.json`);
  mkdirSync(dirname(path), { recursive: true });
  // The report contains internal author IDs. No overwrites and owner-only read.
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return path;
}

export async function runAuditCli(args, { root = defaultRoot, env = process.env, stdout = process.stdout,
  reference = new Date().toISOString() } = {}) {
  const options = parseAuditArguments(args);
  const { buildTuantuanRoster } = await import(pathToFileURL(resolveRosterBuilderPath(root, env)).href);
  const db = new DatabaseSync(resolve(root, options.database ?? 'data/douyin-monitor.sqlite'), { readOnly: true });
  try {
    db.function('normalize_board_key', { deterministic: true }, normalizeBoardKey);
    db.exec('PRAGMA query_only=ON');
    const report = readFullRosterMonitoringAudit(db, { buildRoster: buildTuantuanRoster, reference });
    const path = saveMonitoringAudit(report, options.out, { root });
    stdout.write(JSON.stringify({ path, generatedAt: report.generatedAt, authorCount: report.authorCount,
      counts: report.counts, queue: report.queue, sourceMode: report.source.sourceMode,
      samplingCoverageEvaluated: false, databaseWrites: 0, modelCalls: 0 }) + '\n');
    return { report, path };
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runAuditCli(process.argv.slice(2)); }
  catch (error) {
    const known = ['invalid_arguments', 'invalid_site_root', 'roster_builder_missing'];
    process.stderr.write(JSON.stringify({ code: error.code === 'EEXIST' ? 'audit_output_exists'
      : known.includes(error.message) ? error.message : 'monitoring_audit_failed' }) + '\n');
    process.exitCode = 1;
  }
}

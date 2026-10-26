// Replay already recorded imports in a temporary restored database only.
// This is a release check, not a production data repair or platform request.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { SQLiteBackupManager, validationCountsMatch } from '../lib/backup-manager.mjs';

const [snapshot, output] = process.argv.slice(2);
if (!snapshot || !output) throw new Error('Usage: node scripts/verify-routine-import-copy.mjs <verified-snapshot.sqlite> <new-report.json>');
const directory = mkdtempSync(join(tmpdir(), 'mcn-routine-import-replay-'));
const copyPath = join(directory, 'replay.sqlite');
const restoreManager = new SQLiteBackupManager({ databasePath: copyPath, backupDir: dirname(resolve(snapshot)) });
await restoreManager.restoreSnapshot(resolve(snapshot), copyPath);
const database = new MonitorDatabase(copyPath);
const protectedTables = ['targets', 'target_boards', 'board_catalog', 'snapshots', 'posts', 'post_metrics', 'audits', 'runs', 'source_probes', 'account_events', 'author_resolution_queue', 'author_resolution_jobs'];
const errors = [];
let outcomes, preserved, migration;
try {
  database.db.prepare('ATTACH DATABASE ? AS original').run(resolve(snapshot));
  const differences = () => Object.fromEntries(protectedTables.map(table => [table,
    database.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT * FROM original.${table} EXCEPT SELECT * FROM main.${table})`).get().n]));
  migration = differences();
  if (Object.values(migration).some(Boolean)) throw new Error('Migration changed prior evidence');
  const recorded = database.db.prepare("SELECT * FROM author_resolution_queue WHERE status='resolved' AND json_valid(source_metadata_json) AND json_extract(source_metadata_json,'$.evidenceReuse.newPublicCollection')=0").all();
  const groups = new Map();
  for (const row of recorded) {
    const sourceMetadata = JSON.parse(row.source_metadata_json);
    delete sourceMetadata.evidenceReuse;
    const context = { fileName: row.file_name, sheetName: row.sheet_name, sourceMetadata };
    const groupKey = JSON.stringify(context);
    if (!groups.has(groupKey)) groups.set(groupKey, { context, items: [] });
    const key = `${row.identity_key}|offline-release-replay`;
    if (key.length > 300) throw new Error('Replay key would truncate');
    groups.get(groupKey).items.push({ key, name: row.name, douyinId: row.douyin_id, accountLocator: row.account_locator,
      videoIds: JSON.parse(row.video_ids_json), shareUrls: JSON.parse(row.share_urls_json),
      boards: JSON.parse(row.boards_json), sourceRows: JSON.parse(row.source_rows_json),
      organization: row.organization, tier: row.tier, category: row.category });
  }
  outcomes = { recordedEvidenceRequestCount: recorded.length, groups: groups.size, reused: 0, pending: 0, secondPassReused: 0, secondPassVerifiedExisting: 0, secondPassPending: 0 };
  for (const group of groups.values()) {
    const result = database.enqueueAuthorResolutions(group.items, group.context);
    outcomes.reused += result.evidenceReusedCount;
    outcomes.pending += result.pendingEvidenceRequestCount;
    const second = database.enqueueAuthorResolutions(group.items, group.context);
    outcomes.secondPassReused += second.evidenceReusedCount;
    outcomes.secondPassVerifiedExisting += second.verifiedExistingEvidenceRequestCount;
    outcomes.secondPassPending += second.pendingEvidenceRequestCount;
  }
  preserved = differences();
  if (Object.values(preserved).some(Boolean)) errors.push('Original evidence changed during replay');
  if (outcomes.secondPassReused !== 0) errors.push('Second pass reused already-resolved proof as new');
  if (outcomes.secondPassVerifiedExisting !== outcomes.reused) errors.push('Second pass lost strict existing verification');
  if (outcomes.secondPassPending !== outcomes.pending) errors.push('Second pass changed pending request count');
  if (outcomes.reused + outcomes.pending !== recorded.length) errors.push('Replay accounting does not balance');
  outcomes.retainedSourceReceipts = database.db.prepare('SELECT COUNT(*) AS n FROM author_resolution_import_sources').get().n;
} finally { database.close(); }
const manager = new SQLiteBackupManager({ databasePath: copyPath, backupDir: join(directory, 'backups'), retention: 60 });
const backup = await manager.createBackup('offline-routine-import-replay');
const verified = await manager.verifySnapshot(backup.path);
const restored = await manager.restoreSnapshot(backup.path, join(directory, 'recovered.sqlite'));
const countsMatch = validationCountsMatch(verified.validation.counts, restored.validation.counts);
if (!countsMatch || !Object.hasOwn(restored.validation.counts, 'author_resolution_import_sources')) errors.push('New source receipt backup coverage missing');
const report = { checkedAt: new Date().toISOString(), scope: 'isolated-restored-copy-not-production-or-new-platform-sampling',
  snapshot, copyPath, migration, outcomes, originalRowsChangedOrMissing: preserved, backupPath: backup.path,
  sha256: verified.manifest.sha256, validation: verified.validation, recoveredValidation: restored.validation, countsMatch, errors, passed: errors.length === 0 };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ passed: report.passed, outcomes, countsMatch, errors, reportPath: output }));
if (errors.length) process.exitCode = 1;

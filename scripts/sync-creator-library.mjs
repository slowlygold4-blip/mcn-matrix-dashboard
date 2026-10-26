/**
 * No-model-token sync for the user-maintained TuanTuan creator workbook.
 * A changed cloud revision is exported, audited and classified by the existing
 * 08/09/16 source adapter, then integrated as a new immutable source version.
 * It never rewrites platform snapshots or guesses account identity by name.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { importCreatorLibrary } from './import-creator-library.mjs';
import { integrateCreatorLibrary } from './integrate-creator-library.mjs';
import { validateSQLiteSnapshot } from '../lib/backup-manager.mjs';
import { larkExportArguments, larkWorkbookInfoArguments, resolveLarkCliCommand } from '../lib/lark-sheet-source.mjs';

export const CREATOR_LIBRARY_URL = 'https://my.feishu.cn/sheets/VQQ3sbwPlh5o39tdqyocXzTYnLg';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runCommand = promisify(execFile);
const safeError = error => String(error?.message || error || '未知错误')
  .replace(/(Bearer\s+|(?:access_token|refresh_token|authorization|cookie|password|secret|api_key)\s*[=:]\s*)[^\s,;&]+/gi, '$1[REDACTED]')
  .slice(0, 500);

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(path, 'utf8')); } catch { owner = null; }
      if (owner && processAlive(Number(owner.pid))) return null;
      if (!owner && Date.now() - (await stat(path)).mtimeMs < 60 * 60_000) return null;
      try { await unlink(path); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  return null;
}

export function planCreatorLibrarySync(remote, latest) {
  const revision = Number(remote?.revision);
  if (remote?.revision == null || !Number.isSafeInteger(revision) || revision < 0 || !Number.isFinite(Date.parse(remote?.modified_time)))
    throw new Error('云端版本或修改时间无效，不能判断是否安全同步');
  const previous = latest && Number(latest.source_revision);
  if (latest && Number.isSafeInteger(previous) && revision < previous)
    throw new Error(`云端版本 ${revision} 早于已入库版本 ${previous}，拒绝回退`);
  if (latest && revision === previous && remote.modified_time === latest.source_modified_at)
    return { action: 'unchanged', revision };
  return { action: 'export-and-audit', revision };
}

export function manifestCoversSourceRevision(manifest, remote, latest) {
  return manifest?.status === 'unchanged-content'
    && Number(manifest.revision) === Number(remote?.revision)
    && manifest.modifiedTime === remote?.modified_time
    && manifest.importId === latest?.id;
}

function latestImport(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_source_imports'").get();
    return table ? db.prepare('SELECT id,source_revision,source_modified_at,source_sha256 FROM creator_source_imports ORDER BY id DESC LIMIT 1').get() : null;
  } finally { db.close(); }
}

function hasActiveCollection(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return Boolean(db.prepare("SELECT 1 FROM runs WHERE status='running' LIMIT 1").get()); }
  finally { db.close(); }
}

function envelope(stdout, label) {
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error(`${label}返回无效 JSON`); }
  if (!result?.ok) throw new Error(`${label}失败：${String(result?.error?.message || '未知错误').slice(0, 240)}`);
  return result.data;
}

async function readCloudInfo(command) {
  const result = await runCommand(command, larkWorkbookInfoArguments(CREATOR_LIBRARY_URL), {
    cwd: root, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LARK_CLI_NO_PROXY: '1' },
  });
  return envelope(result.stdout, '飞书版本读取');
}

async function exportCloud(command, directory) {
  const result = await runCommand(command, larkExportArguments(CREATOR_LIBRARY_URL, 'source.xlsx'), {
    cwd: directory, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LARK_CLI_NO_PROXY: '1' },
  });
  envelope(result.stdout, '飞书导出');
  const sourcePath = join(directory, 'source.xlsx');
  if (!existsSync(sourcePath) || (await stat(sourcePath)).size < 1000) throw new Error('飞书导出未生成完整 XLSX');
  return sourcePath;
}

async function verifiedBackup(databasePath, directory) {
  const size = (await stat(databasePath)).size;
  const disk = await statfs(directory);
  if (disk.bavail * disk.bsize < size * 1.5 + 100_000_000) throw new Error('备份空间不足，已停止入库');
  const backupPath = join(directory, 'monitor-before.sqlite');
  await runCommand('/usr/bin/sqlite3', [databasePath, `.backup ${JSON.stringify(backupPath)}`], {
    cwd: directory, timeout: 10 * 60_000, maxBuffer: 1024 * 1024,
  });
  const validation = validateSQLiteSnapshot(backupPath);
  return { path: backupPath, validation };
}

async function readManifest(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeManifest(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.partial`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export async function syncCreatorLibrary({ checkOnly = false, forcePreview = false,
  databasePath = join(root, 'data/douyin-monitor.sqlite'),
  syncDir = join(root, 'data/creator-source-sync'), command = null } = {}) {
  if (!existsSync(databasePath)) throw new Error('主数据库不存在，拒绝创建空库');
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  const lockPath = join(syncDir, '.sync.lock');
  const lock = await acquireLock(lockPath);
  if (!lock) return { status: 'deferred', reason: 'source-sync-already-running' };
  try {
    const cli = command || await resolveLarkCliCommand();
    const before = await readCloudInfo(cli);
    const previous = latestImport(databasePath);
    const plan = planCreatorLibrarySync(before, previous);
    if (plan.action === 'unchanged' && !forcePreview) return { status: 'unchanged', revision: plan.revision, importId: previous?.id };
    const manifestPath = join(syncDir, 'manifest.json');
    const manifest = await readManifest(manifestPath);
    if (!forcePreview && manifestCoversSourceRevision(manifest, before, previous))
      return { status: 'unchanged-content', revision: plan.revision, importId: previous.id };
    if (checkOnly) return { status: 'would-export', revision: plan.revision, previousRevision: previous?.source_revision ?? null };
    if (!forcePreview && hasActiveCollection(databasePath)) return { status: 'deferred', reason: 'platform-collection-running', revision: plan.revision };

    const directory = join(syncDir, `run-${new Date().toISOString().replace(/[:.]/g, '')}-${randomUUID().slice(0, 8)}`);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const receiptPath = join(directory, 'receipt.json');
    let integrationStarted = false;
    try {
      const sourcePath = await exportCloud(cli, directory);
      const after = await readCloudInfo(cli);
      if (Number(after.revision) !== Number(before.revision) || after.modified_time !== before.modified_time)
        throw new Error('导出过程中云表格发生变化；保留导出证据，不入库，请下轮重试');
      const stagePath = join(directory, 'classified.sqlite');
      const staged = await importCreatorLibrary({ sourcePath, outputPath: stagePath, monitorPath: databasePath,
        revision: String(after.revision), modifiedAt: after.modified_time });
      const audit = integrateCreatorLibrary({ sourcePath: stagePath, targetPath: databasePath, dryRun: true });
      if (forcePreview) {
        const receipt = { status: 'preview', revision: after.revision, sourceSha256: staged.sourceSha256,
          audit: staged.audit, integration: audit, sourcePath, stagePath, productionDatabaseChanged: false };
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        return receipt;
      }
      if (audit.action === 'unchanged') {
        const receipt = { status: 'unchanged-content', revision: after.revision, sourceSha256: staged.sourceSha256,
          audit: staged.audit, sourcePath, productionDatabaseChanged: false };
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await writeManifest(manifestPath, { status: 'unchanged-content', revision: after.revision,
          modifiedTime: after.modified_time, importId: audit.importId, checkedAt: new Date().toISOString() });
        return receipt;
      }
      if (hasActiveCollection(databasePath)) throw new Error('入库前检测到平台采集进行中；已保存来源，不修改主库');
      const backup = await verifiedBackup(databasePath, directory);
      integrationStarted = true;
      const result = integrateCreatorLibrary({ sourcePath: stagePath, targetPath: databasePath });
      const latest = latestImport(databasePath);
      if (latest?.source_sha256 !== staged.sourceSha256 || String(latest.source_revision) !== String(after.revision))
        throw new Error('入库后版本校验不一致；保留备份并要求人工检查');
      const receipt = { status: 'imported', revision: after.revision, sourceSha256: staged.sourceSha256,
        audit: staged.audit, integration: result, backupPath: backup.path, backupValidation: backup.validation,
        sourcePath, stagePath, productionDatabaseChanged: true };
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      return receipt;
    } catch (error) {
      await writeFile(receiptPath, `${JSON.stringify({ status: 'failed', error: safeError(error),
        at: new Date().toISOString(), productionDatabaseMayHaveChanged: integrationStarted }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      throw error;
    }
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some(flag => !['--once', '--check', '--force-preview'].includes(flag))) {
    console.error('用法：node scripts/sync-creator-library.mjs [--once|--check|--force-preview]');
    process.exitCode = 2;
  } else {
    const scheduled = !flags.has('--check') && !flags.has('--force-preview');
    const statusPath = join(root, 'data/creator-source-sync/status.json');
    syncCreatorLibrary({ checkOnly: flags.has('--check'), forcePreview: flags.has('--force-preview') })
      .then(async result => {
        if (scheduled) await writeManifest(statusPath, { checkedAt: new Date().toISOString(),
          status: result.status, revision: result.revision ?? null, importId: result.importId ?? result.integration?.importId ?? null,
          reason: result.reason ?? null });
        console.log(JSON.stringify(result));
      })
      .catch(async error => {
        if (scheduled) {
          try {
            await mkdir(join(root, 'data/creator-source-sync'), { recursive: true, mode: 0o700 });
            await writeManifest(statusPath, { checkedAt: new Date().toISOString(), status: 'failed',
              reason: safeError(error) });
          } catch { /* The error is still reported to launchd stderr. */ }
        }
        console.error(safeError(error)); process.exitCode = 1;
      });
  }
}

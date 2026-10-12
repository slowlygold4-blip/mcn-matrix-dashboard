import { readFileSync, lstatSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { inspectLatestBackup } from './backup-audit.mjs';

const states = new WeakMap();
const isTime = value => Number.isFinite(value) && value >= 0;

// Reuse the published manifest's existing validation, never re-hash/re-open a
// multi-gigabyte database on each scheduler tick. Metadata/file-size checks are
// intentionally shallow; this is backup frequency control, not a new audit.
function latestSuccessAt(manager, now) {
  const inspected = inspectLatestBackup(manager.backupDir, { verifyHash: false, verifySQLite: false });
  if (inspected.status !== 'ok') return null;
  try {
    const name = inspected.fileName;
    if (typeof name !== 'string' || basename(name) !== name || !/^douyin-monitor-auto-.*\.sqlite$/.test(name)) return null;
    const path = join(manager.backupDir, name), metadataPath = `${path}.manifest.json`;
    const dataStat = lstatSync(path), metadataStat = lstatSync(metadataPath);
    if (!dataStat.isFile() || !metadataStat.isFile() || metadataStat.size > 128 * 1024) return null;
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const created = Date.parse(metadata.createdAt), published = metadataStat.mtimeMs;
    if (metadata.format !== 'sqlite-online-backup-v1' || metadata.fileName !== name
      || typeof metadata.source !== 'string' || resolve(metadata.source) !== resolve(manager.databasePath)
      || !Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || metadata.bytes !== dataStat.size
      || metadata.bytes !== inspected.bytes || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? '')
      || !isTime(created) || !isTime(published) || created > published || published > now) return null;
    // The manifest is published after backup+SQLite verification+hash finish;
    // measuring from publication avoids counting a slow backup as already old.
    return published;
  } catch { return null; }
}

/** Only route scheduler automatic micro-batches through this wrapper.
 * Manual/startup/pre-release backups keep calling manager.createBackup itself.
 * No timers, file writes, pruning, source DB reads or changes are added here.
 * The manager retains ownership of its existing backup/lock/validation path.
 */
export function createScheduledBackupThrottle(manager, { minIntervalMs = 600_000, now = Date.now } = {}) {
  if (!manager || typeof manager.createBackup !== 'function' || typeof manager.backupDir !== 'string'
    || typeof manager.databasePath !== 'string' || typeof now !== 'function'
    || !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 1) throw new TypeError('Invalid scheduled backup throttle');
  if (!states.has(manager)) states.set(manager, { inFlight: false, succeededAt: null });
  const state = states.get(manager);
  return async function requestScheduledBackup(reason) {
    if (typeof reason !== 'string' || !/^scheduled-[a-z0-9-]{1,64}$/.test(reason)) {
      return { status: 'skipped', reason: 'not-scheduled' };
    }
    if (state.inFlight || manager.runningPromise) return { status: 'skipped', reason: 'backup-in-progress' };
    const checked = now();
    if (!isTime(checked)) throw new TypeError('Invalid backup clock');
    state.inFlight = true;
    try {
      const stored = latestSuccessAt(manager, checked);
      const candidates = [stored, state.succeededAt].filter(value => isTime(value) && value <= checked);
      const last = candidates.length ? Math.max(...candidates) : null;
      if (last !== null && checked - last < minIntervalMs) return { status: 'throttled', reason: 'recent-successful-backup',
        lastSuccessfulAt: new Date(last).toISOString(), nextEligibleAt: new Date(last + minIntervalMs).toISOString(),
        minIntervalMs, verification: 'published-manifest-and-size-or-current-process-success' };
      // Another explicit backup may start while the shallow metadata is read.
      if (manager.runningPromise) return { status: 'skipped', reason: 'backup-in-progress' };
      const backup = await manager.createBackup(reason);
      if (backup?.status !== 'created') return { status: 'skipped', reason: backup?.reason || 'manager-did-not-create' };
      const finished = now();
      if (!isTime(finished)) throw new TypeError('Invalid backup completion clock');
      state.succeededAt = finished;
      return { status: 'succeeded', reason: 'automatic-backup-created', backup,
        lastSuccessfulAt: new Date(finished).toISOString(), nextEligibleAt: new Date(finished + minIntervalMs).toISOString() };
    } finally { state.inFlight = false; }
  };
}

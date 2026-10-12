// Read-only preflight for a managed-service transition. This does not make
// shutdown atomic with the scheduler; it prevents a known active run from
// being interrupted by an installer/reload command.
export function readServiceTransitionGate(db, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('服务交接检查时间无效');
  for (const table of ['runs', 'author_resolution_jobs', 'author_resolution_queue']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      throw new Error(`服务交接检查缺少 ${table} 表，拒绝停止现有服务`);
    }
  }
  const runningRuns = Number(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='running'").get().n);
  const runningAuthorJobs = Number(db.prepare("SELECT COUNT(*) AS n FROM author_resolution_jobs WHERE status='running'").get().n);
  const activeAuthorLeases = Number(db.prepare(`SELECT COUNT(*) AS n FROM author_resolution_queue
    WHERE status IN ('pending','retry') AND lease_owner IS NOT NULL
      AND lease_until IS NOT NULL AND julianday(lease_until)>julianday(?)`).get(now.toISOString()).n);
  return {
    safe: runningRuns === 0 && runningAuthorJobs === 0 && activeAuthorLeases === 0,
    runningRuns, runningAuthorJobs, activeAuthorLeases,
    checkedAt: now.toISOString(),
  };
}

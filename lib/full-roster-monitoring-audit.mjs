import { validateSubmittedAccountId } from './author-spreadsheet.mjs';
import { readPublicAccountRoster } from './public-replica-export.mjs';
import { creatorSourcePartitions } from './public-creator-source.mjs';
import { readPublicTableFoundation } from './public-table-foundation.mjs';
import { withCreatorSourceLinkSnapshot } from './creator-source-current-links.mjs';
import { publicText } from './public-text.mjs';
import { readMasterRoster } from './master-roster.mjs';

const normal = value => validateSubmittedAccountId(value, 'douyin').value.toLowerCase();
const has = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const unique = values => [...new Set(values)];
const safeError = value => publicText(value, [], 300)?.replace(/\/(?:Users|home|tmp|var)\/[^\s;,，；]+/g, '[本机路径已隐藏]');
export const MONITORING_AUDIT_STATES = Object.freeze(['monitoring', 'paused', 'identity_conflict_paused',
  'identity_conflict_active', 'resolving', 'source_binding_needed', 'previous_resolution_failed',
  'identity_search_needed', 'identifier_repair_needed']);

/** Pure classification of existing enrollment evidence. Never resolves an
 * author, enables a target, or turns an enrollment into a sampling success. */
export function buildFullRosterMonitoringAudit({ roster, targets, queue = [], reference, source = null }) {
  if (!Array.isArray(roster?.rows) || !Array.isArray(targets) || !Array.isArray(queue)
    || !Number.isFinite(Date.parse(reference))) throw Error('invalid-monitoring-audit-input');
  const byTarget = new Map(targets.map(t => [t.id, t]));
  if (byTarget.size !== targets.length) throw Error('duplicate-monitoring-target');
  const byHandle = new Map(), holdsByTarget = new Map();
  for (const q of queue) {
    const handle = normal(q.douyin_id);
    if (handle) { const rows = byHandle.get(handle) ?? []; rows.push(q); byHandle.set(handle, rows); }
    if (q.suspended_target_enabled != null) {
      const rows = holdsByTarget.get(q.resolved_target_id) ?? [];
      rows.push(q); holdsByTarget.set(q.resolved_target_id, rows);
    }
  }
  const counts = Object.fromEntries(MONITORING_AUDIT_STATES.map(state => [state, 0]));
  const keys = new Set();
  const items = roster.rows.map(row => {
    if (typeof row.key !== 'string' || !row.key || keys.has(row.key) || !Array.isArray(row.accounts)) throw Error('invalid-monitoring-roster-row');
    keys.add(row.key);
    const raw = row.source;
    const handles = unique([raw?.douyinId, raw?.submittedAccountId, ...(raw?.douyinIds ?? [])].map(normal).filter(Boolean));
    const targetIds = unique(row.accounts.map(a => a.id).filter(id => byTarget.has(id)));
    const activeTargetIds = targetIds.filter(id => Boolean(byTarget.get(id).enabled));
    const conflictTargetIds = targetIds.filter(id => holdsByTarget.has(id));
    const eligibleTargetIds = activeTargetIds.filter(id => !holdsByTarget.has(id));
    const found = [...new Map([...handles.flatMap(h => byHandle.get(h) ?? []),
      ...conflictTargetIds.flatMap(id => holdsByTarget.get(id))].map(q => [q.id, q])).values()];
    const state = eligibleTargetIds.length ? 'monitoring'
      : conflictTargetIds.length ? activeTargetIds.length ? 'identity_conflict_active' : 'identity_conflict_paused'
      : targetIds.length ? 'paused'
      : found.some(q => ['pending', 'retry'].includes(q.status)) ? 'resolving'
      : found.some(q => q.status === 'resolved') ? 'source_binding_needed'
      : found.length ? 'previous_resolution_failed'
      : handles.length ? 'identity_search_needed' : 'identifier_repair_needed';
    counts[state]++;
    return { key: row.key, name: raw?.name ?? row.accounts[0]?.label ?? '', handles, state, targetIds,
      activeTargetIds, eligibleTargetIds, conflictTargetIds,
      sourceTargetIds: unique(raw?.targetIds ?? []), queueIds: found.map(q => q.id),
      anomalies: activeTargetIds.some(id => holdsByTarget.has(id)) ? ['enabled_target_has_identity_hold'] : [],
      lastErrors: unique(found.map(q => safeError(q.last_error)).filter(Boolean)).slice(0, 3),
      sourceRow: raw?.row ?? null, sourceRows: raw?.sourceRows ?? null,
      samplingStatus: 'not-evaluated' };
  });
  const queueCounts = {};
  for (const q of queue) queueCounts[q.status] = (queueCounts[q.status] ?? 0) + 1;
  return { version: 2, generatedAt: new Date(reference).toISOString(), scope: 'tuantuan',
    stateBasis: 'current-consistent-database-snapshot', source, authorCount: items.length, counts,
    rosterCounts: roster.counts, queue: { itemCount: queue.length, counts: queueCounts,
      matchedItemCount: new Set(items.flatMap(row => row.queueIds)).size },
    semantics: '监控关联和排队不是采集成功；队列项数不是独立作者数。主页、作品与话题成功覆盖另行核验。',
    samplingCoverageEvaluated: false, runtimeAI: false, networkRequests: 0, databaseWrites: 0, modelCalls: 0, items };
}

/** Reads the same live projections and roster builder as the public product,
 * with no static JSON inputs and no complete account metric/history report. */
export function readFullRosterMonitoringAudit(database, { buildRoster, reference = new Date().toISOString() } = {}) {
  if (typeof buildRoster !== 'function' || !Number.isFinite(Date.parse(reference))) throw Error('invalid-monitoring-audit-input');
  reference = new Date(reference).toISOString();
  const db = database?.db ?? database, ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN');
  try {
    return withCreatorSourceLinkSnapshot(db, () => {
      const masterRoster = readMasterRoster(db);
      const accounts = readPublicAccountRoster(db, { masterRoster });
      const creator = creatorSourcePartitions(db, reference);
      const base = creator.find(part => part.kind === 'creatorAuthors')?.items ?? [];
      const index = creator.find(part => part.kind === 'creatorIndex');
      const foundation = readPublicTableFoundation(db, reference, { masterRoster });
      const roster = buildRoster(base, accounts, foundation?.authors ?? [], foundation?.pendingAuthors ?? []);
      const queue = has(db, 'author_resolution_queue') ? db.prepare(`SELECT id,douyin_id,status,last_error,
        resolved_target_id,suspended_target_enabled FROM author_resolution_queue ORDER BY id`).all() : [];
      const targets = db.prepare("SELECT id,enabled FROM targets WHERE type='account' ORDER BY id").all();
      return buildFullRosterMonitoringAudit({ roster, targets, queue, reference,
        source: { creatorRevision: index?.revision ?? null, creatorEditionFingerprint: index?.editionFingerprint ?? null,
          currentLinkFingerprint: index?.linkFingerprint ?? null, foundationRevision: foundation?.revision ?? null,
          sourceMode: 'live-database-projections' } });
    });
  } finally { if (ownsTransaction) db.exec('ROLLBACK'); }
}

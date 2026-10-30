import { matchesMatrixScope } from './matrix-scope.mjs';

const identity = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const sourceKey = row => row?.sourceOnly === true && row.rowKey
  ? `row:${row.rowKey}` : identity(row?.douyinId) ? `id:${identity(row.douyinId)}` : null;
const demand = (condition, code) => { if (!condition) throw Error(`roster-audit-${code}`); };

/** Inclusion audit of the full directory, before search/category/paging.
 * This verifies saved identities and membership, never collection success,
 * metric accuracy, human identity or what a browser actually rendered. */
export function auditRosterInclusion(roster, { authors, supplements = [], pending = [], accounts }) {
  demand([authors, supplements, pending, accounts, roster?.rows].every(Array.isArray), 'input');
  const expected = [...authors, ...supplements, ...pending].map(sourceKey);
  demand(expected.every(Boolean) && new Set(expected).size === expected.length, 'source-identities');
  const expectedKeys = new Set(expected), represented = new Set(), rowKeys = new Set();
  const targets = accounts.filter(account => account?.platform === 'douyin'
    && Number.isSafeInteger(account.id) && account.id > 0 && account.sourceOnly !== true
    && matchesMatrixScope(account, { theme: 'tuantuan' }));
  const byId = new Map(targets.map(account => [account.id, account]));
  demand(byId.size === targets.length, 'target-identities');
  const memberships = new Map(); let sourceRows = 0, accountOnlyRows = 0;
  for (const row of roster.rows) {
    demand(typeof row?.key === 'string' && row.key && !rowKeys.has(row.key), 'duplicate-row');
    rowKeys.add(row.key); demand(Array.isArray(row.accounts), 'row-accounts');
    if (row.source) {
      sourceRows++;
      const keys = row.source.sourceOnly === true ? [sourceKey(row.source)]
        : [row.source.douyinId, ...(row.source.douyinIds || [])].map(id => `id:${identity(id)}`);
      for (const key of new Set(keys)) {
        demand(expectedKeys.has(key) && !represented.has(key), 'source-membership');
        represented.add(key);
      }
    } else { accountOnlyRows++; demand(row.accounts.length > 0, 'empty-row'); }
    const local = new Set();
    for (const account of row.accounts) {
      demand(byId.has(account.id) && !local.has(account.id), 'target-membership');
      local.add(account.id); memberships.set(account.id, (memberships.get(account.id) || 0) + 1);
    }
  }
  demand(represented.size === expectedKeys.size, 'missing-source');
  demand(memberships.size === byId.size, 'missing-target');
  const aliases = expectedKeys.size - sourceRows;
  const enabled = targets.filter(account => account.enabled === true).length;
  demand(roster.counts?.all === roster.rows.length && roster.counts.source === sourceRows
    && roster.counts.monitored === targets.length && roster.counts.monitoredEnabled === enabled
    && roster.counts.monitoredPaused === targets.length - enabled
    && roster.counts.reconciledAliases === aliases, 'counts');
  return { status: 'verified', directoryRows: roster.rows.length, sourceRows, accountOnlyRows,
    inputSourceRecords: expected.length, retainedSourceIdentities: represented.size, foldedAliases: aliases,
    pendingRecords: pending.length, matrixTargets: targets.length, enabledTargets: enabled,
    pausedTargets: targets.length - enabled, representedTargets: memberships.size,
    multiRowTargets: [...memberships.values()].filter(count => count > 1).length,
    collectionSuccessVerified: false, visualVerification: false };
}

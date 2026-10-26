// Bounded production verification through the normal authenticated API.
// This never imports snapshots or backfills missed dates.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { checksum } from '../lib/utils.mjs';

const scope = [269, 277, 453, 610, 748, 749];
const onlyArgument = process.argv.find((value) => value.startsWith('--only='));
const selectedScope = onlyArgument ? onlyArgument.slice(7).split(',').map(Number) : scope;
if (!selectedScope.length || selectedScope.some((id) => !scope.includes(id))) throw new Error('Only the six audited target IDs can be selected');
const expectedOriginals = new Map([[269, '27274555030'], [277, '55086377446'], [453, 'Aa11202759'], [610, '1380535635']]);
const outcome = (id) => id === 610 ? 'identity' : expectedOriginals.has(id) ? 'alias' : 'lifecycle';
const base = 'http://127.0.0.1:4188';
const database = new DatabaseSync(new URL('../data/douyin-monitor.sqlite', import.meta.url), { readOnly: true });
const report = { startedAt: new Date().toISOString(), mode: process.argv.includes('--execute') ? 'normal-live-collection' : 'preview', results: [] };
const output = new URL('../output/playwright/account-continuity-release.json', import.meta.url);
if (process.argv.includes('--resume')) {
  const previous = JSON.parse(readFileSync(output, 'utf8'));
  report.startedAt = previous.startedAt;
  report.results = previous.results.filter((row) => row.passed && scope.includes(row.targetId));
  report.previousAttempts = [...(previous.previousAttempts || []), ...previous.results.filter((row) => !row.passed)];
}
const target = (id) => {
  const row = database.prepare('SELECT * FROM targets WHERE id=?').get(id);
  if (!row?.enabled || row.type !== 'account' || row.provider !== 'public-web') throw new Error(`Target ${id} changed; stopped`);
  const metadata = JSON.parse(row.metadata_json);
  if (expectedOriginals.has(id) && metadata.douyinId !== expectedOriginals.get(id)) throw new Error(`Original identity changed for ${id}; stopped`);
  return row;
};

try {
  if (report.mode === 'preview') {
    console.log(JSON.stringify(scope.map((id) => { const row = target(id); return { id, label: row.label, expectedOutcome: outcome(id) }; })));
  } else {
    for (const id of selectedScope) {
      const before = target(id);
      const completed = report.results.find((row) => row.targetId === id && row.passed);
      if (completed) {
        const stored = database.prepare('SELECT source_checksum FROM account_events WHERE target_id=? AND run_id=?').all(id, completed.runId);
        if (!completed.events.every((event) => stored.some((row) => row.source_checksum === event.sourceChecksum))) throw new Error('Prior accepted evidence is no longer present');
        console.log(JSON.stringify({ targetId: id, alreadyVerified: true, runId: completed.runId }));
        continue;
      }
      const previousSnapshot = database.prepare('SELECT MAX(id) id,COUNT(*) count FROM snapshots WHERE target_id=?').get(id);
      const authResponse = await fetch(`${base}/api/bootstrap`);
      const cookie = authResponse.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
      const boot = await authResponse.json();
      if (!authResponse.ok || !boot.auth?.permissions?.edit || !boot.auth.csrfToken) throw new Error('App authorization unavailable');
      if (boot.scheduler?.running) throw new Error('Background collection is busy; no overlapping job requested');
      const response = await fetch(`${base}/api/sync`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base, 'x-csrf-token': boot.auth.csrfToken },
        body: JSON.stringify({ targetId: id }), signal: AbortSignal.timeout(240_000),
      });
      const run = await response.json();
      const events = database.prepare('SELECT * FROM account_events WHERE target_id=? AND run_id=? ORDER BY id').all(id, run.runId ?? -1);
      const added = database.prepare('SELECT id,captured_at,followers,total_likes,total_posts FROM snapshots WHERE target_id=? AND id>?').all(id, previousSnapshot.id ?? 0);
      const after = target(id);
      const originalPreserved = after.locator === before.locator && after.enabled === before.enabled
        && JSON.stringify(JSON.parse(after.metadata_json).importSource) === JSON.stringify(JSON.parse(before.metadata_json).importSource)
        && JSON.parse(after.metadata_json).douyinId === JSON.parse(before.metadata_json).douyinId;
      const validEvents = events.every((event) => checksum(JSON.parse(event.raw_json)) === event.source_checksum);
      const expectedType = outcome(id);
      const passed = response.ok && originalPreserved && validEvents && events.some((event) => event.event_type === expectedType)
        && (expectedType !== 'lifecycle' ? added.length === 1 && run.successCount === 1
          : added.length === 0 && run.successCount === 0 && run.details?.some((detail) => detail.targetId === id && detail.status === 'inactive'));
      const entry = { targetId: id, originalLabel: before.label, currentLabel: after.label, originalPreserved, validEvents,
        passed, runId: run.runId, outcome: expectedType, details: run.details, snapshotsAdded: added,
        events: events.map((event) => ({ id: event.id, type: event.event_type, sourceChecksum: event.source_checksum, evidence: JSON.parse(event.event_json) })) };
      report.results.push(entry);
      writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(entry));
      if (!passed) throw new Error(`Target ${id} failed release verification; remaining requests stopped`);
    }
    report.finishedAt = new Date().toISOString();
    report.passed = report.results.length === scope.length && report.results.every((row) => row.passed);
    writeFileSync(output, JSON.stringify(report, null, 2));
  }
} finally { database.close(); }

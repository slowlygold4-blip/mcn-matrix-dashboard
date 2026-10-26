import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { checksum } from '../lib/utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = resolve(process.argv[2] || '');
assert.match(stage, /^\/tmp\/phase94-works-async-[A-Za-z0-9]+$/);
const files = ['lib/works-only-observation.mjs', 'lib/works-observation.mjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const before = Object.fromEntries(await Promise.all(files.map(async path => [path, sha(await readFile(join(stage, path)))])));
const { validateWorksOnlyEvidence } = await import(pathToFileURL(join(stage, files[0])));
const { loadVerifiedWorksOnlyRows } = await import(pathToFileURL(join(stage, files[1])));
const audit = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase94-data-audit.json')));
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
const originals = {
  2211: 'e2884db8fb040dac80aa83fd4cdb88db90537a04e20d05d211d71cdc401862b5',
  2215: '999cf27c52037417c6a1b10b88de551fc484f36218a9607469c20189acc4fc04',
  2216: '87ce641d1e8240dce3e8f0eaa89d4adb6a376089115241a8896ddc29805cfef6',
};
let rows, fixed;
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  rows = db.prepare('SELECT run_id,raw_json,source_checksum FROM works_observations WHERE run_id IN (2211,2215,2216) ORDER BY run_id').all();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const source = JSON.parse(row.raw_json), canonical = validateWorksOnlyEvidence(source);
    assert.equal(sha(row.raw_json), originals[row.run_id]);
    assert.equal(checksum(canonical), originals[row.run_id]);
    assert.equal(row.source_checksum, originals[row.run_id]);
    assert.equal(canonical.status, 'unavailable');
    assert.equal(canonical.observedAt, null);
    assert.deepEqual(canonical.posts, []);
    assert.deepEqual(canonical.failureDiagnostics.httpStatuses, row.run_id === 2211 ? [403] : []);
    const falseSuccess = structuredClone(source);
    falseSuccess.status = 'accepted';
    assert.throws(() => validateWorksOnlyEvidence(falseSuccess), { code: 'WORKS_OBSERVATION_INVALID' });
  }
  fixed = loadVerifiedWorksOnlyRows(db, audit.fixedTerminalCutoff, null, { runIds: audit.runIds });
  assert.equal(fixed.length, 22);
  for (const proof of audit.proofs) {
    const row = fixed.find(item => item.run_id === proof.runId);
    assert.ok(row);
    assert.equal(row.status, proof.status);
    assert.equal(row.coverage, proof.coverage);
    assert.equal(row.source_checksum, proof.sourceSha256);
  }
  assert.equal(db.prepare('SELECT total_changes() n').get().n, 0);
  db.exec('ROLLBACK');
} finally { db.close(); }
const after = Object.fromEntries(await Promise.all(files.map(async path => [path, sha(await readFile(join(stage, path)))])));
assert.deepEqual(after, before);
const result = { checkedAt: new Date().toISOString(), stage, candidateSourceHashes: before,
  actualArchivedUnavailableSources: 3, counterfeitSuccessRejected: 3,
  fixedRunIds: audit.runIds, fixedSameStatusCoverageChecksum: true,
  totalChanges: 0, sourceArchiveUnmodified: true, productionCodeUnmodified: true,
  doesNotReplaceFullOriginalArchiveTest: true, noCandidatePromotionClaim: true };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase94-candidate-archive.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ checkedAt: result.checkedAt, archivedSources: 3, counterfeitSuccessRejected: 3, fixedTerminalEvidence: 22, totalChanges: 0 }));

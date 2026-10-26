// One bounded read-only candidate check. Never approves or commits a correction.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { prepareImportAuthorisedDetail } from '../lib/import-authorised-detail.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const db = new DatabaseSync(root + 'data/douyin-monitor.sqlite', { readOnly: true });
let source, expected;
try {
  assert.equal(db.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','queued')").get().n, 0, 'Active collection; no candidate request started');
  assert.equal(db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n, 0, 'Identity worker active; no request started');
  source = JSON.parse(db.prepare('SELECT request_json FROM author_resolution_jobs WHERE id=?').get('c9895a58-14ef-4f1f-8c88-428fb3ce8d6f').request_json).rows.find(row => row.sourceRow === 85);
  assert.equal(source.name, '51058454595'); assert.equal(source.douyinId, '没有后悔药');
  assert.ok(JSON.stringify(source).includes('https://v.douyin.com/xglrKXGaNFU/'));
  expected = db.prepare('SELECT id,locator FROM targets WHERE id=2289').get(); assert.ok(expected);
} finally { db.close(); }
const synthetic = { status: 'completed', request: { rows: [{ ...source, douyinId: source.name }] } };
const input = prepareImportAuthorisedDetail(synthetic, { sourceRow: 85 });
const provider = new PublicWebProvider({}, { authorisedDetailEnabled: true, signal: AbortSignal.timeout(55_000) });
const startedAt = new Date().toISOString(); let result;
try { result = await provider.resolveAuthorisedDetail({ items: [input] }); }
catch (error) { result = { status: 'unavailable', errorCode: /^[A-Z_a-z0-9]+$/.test(error.code || '') ? error.code : 'unclassified' }; }
const report = { startedAt, finishedAt: new Date().toISOString(), sourceRow: 85,
  originalSubmittedId: source.douyinId, candidateId: source.name, candidateSource: '原表B85及其他七行的明确账号ID',
  sourceEvidenceUrl: 'https://v.douyin.com/xglrKXGaNFU/', expectedTargetId: expected.id,
  sameExistingCanonical: result.status === 'ok' && result.candidate?.secUid === expected.locator,
  result, accountWrites: 0, correctionSubmitted: false, sourceJobsUnchanged: true };
const path = root + 'data/maintenance-journal/20261009-id-correction/row85-candidate-' + Date.now() + '.json';
await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ path, status: result.status, errorCode: result.errorCode, diagnostic: result.diagnostic,
  sameExistingCanonical: report.sameExistingCanonical, accountWrites: 0, correctionSubmitted: false }));

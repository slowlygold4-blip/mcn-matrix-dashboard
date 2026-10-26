import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, statSync, createReadStream, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';
const root = new URL('../', import.meta.url);
const backup = new URL('data/backups/automatic/douyin-monitor-auto-20261005T183507283Z-startup-fefada61.sqlite', root).pathname;
const manifest = JSON.parse(readFileSync(`${backup}.manifest.json`, 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'mcn-read-release-'));
const copy = join(temporary, 'snapshot.sqlite');
copyFileSync(backup, copy);
const hash = createHash('sha256');
for await (const chunk of createReadStream(copy)) hash.update(chunk);
const sha256 = hash.digest('hex');
assert.equal(sha256, manifest.sha256);
assert.equal(statSync(copy).size, manifest.bytes);
const validation = validateSQLiteSnapshot(copy);
assert.ok(validationCountsMatch(manifest.validation.counts, validation.counts));
const health = await (await fetch('http://127.0.0.1:4188/healthz')).json();
assert.equal(health.ok, true);
const status = await (await fetch('http://127.0.0.1:4188/api/monitoring-status')).json();
const overviewResponse = await fetch('http://127.0.0.1:4188/api/rebuild/insights?theme=tuantuan&period=month');
assert.equal(overviewResponse.status, 200);
const overview = await overviewResponse.json();
assert.equal(overview.summary.enabledCount, 556);
const result = { checkedAt: new Date().toISOString(), backup, sha256, bytes: manifest.bytes,
  validation, temporaryCopyVerified: true, health,
  scheduler: status.scheduler, updateSla: status.updateSla,
  overview: { range: overview.range, enabledCount: overview.summary.enabledCount, metrics: overview.summary.metrics } };
writeFileSync(new URL('data/maintenance-journal/20261005-read-latency/release.json', root), JSON.stringify(result, null, 2));
unlinkSync(copy); rmdirSync(temporary);
console.log(JSON.stringify({ health: health.ok, sha256, bytes: manifest.bytes, validation,
  enabledCount: result.overview.enabledCount, schedulerRunning: status.scheduler.running,
  nextRunAt: status.scheduler.nextRunAt }));

// One already-monitored account, through the normal authenticated collection
// route. No imported snapshots, historical repair, bulk job or direct DB writes.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { checksum } from '../lib/utils.mjs';

const base = 'http://127.0.0.1:4188';
const targetId = 251;
const endpoint = 'https://www.douyin.com/aweme/v1/web/aweme/post/';
const database = new DatabaseSync(new URL('../data/douyin-monitor.sqlite', import.meta.url), { readOnly: true });
const output = new URL('../output/playwright/publication-pagination-release.json', import.meta.url);
const startedAt = new Date().toISOString();
const before = database.prepare('SELECT * FROM targets WHERE id=?').get(targetId);
assert.equal(before?.enabled, 1);
assert.equal(before.type, 'account');
assert.equal(before.provider, 'public-web');
assert.equal(JSON.parse(before.metadata_json).douyinId, 'ISEN3344');
assert.equal(JSON.parse(before.metadata_json).platform, 'douyin');

try {
  if (!process.argv.includes('--execute')) {
    console.log(JSON.stringify({ mode: 'preview', targetId, label: before.label, maximumAccounts: 1 }));
  } else {
    const last = database.prepare('SELECT MAX(id) id FROM snapshots WHERE target_id=?').get(targetId);
    const response = await fetch(`${base}/api/bootstrap`, { signal: AbortSignal.timeout(30_000) });
    const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const boot = await response.json();
    assert.equal(response.ok, true);
    assert.equal(boot.auth?.permissions?.edit, true);
    assert.ok(boot.auth.csrfToken);
    assert.equal(boot.scheduler?.running, false, 'No overlap with a background run');
    const collectionResponse = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base, 'x-csrf-token': boot.auth.csrfToken },
      body: JSON.stringify({ targetId }), signal: AbortSignal.timeout(180_000),
    });
    const run = await collectionResponse.json();
    assert.equal(collectionResponse.ok, true);
    assert.equal(run.successCount, 1);
    const rows = database.prepare('SELECT * FROM snapshots WHERE target_id=? AND id>? ORDER BY id').all(targetId, last.id ?? 0);
    assert.equal(rows.length, 1);
    const snapshot = rows[0];
    const raw = JSON.parse(snapshot.raw_json);
    assert.equal(checksum(raw), snapshot.source_checksum);
    assert.equal(snapshot.account_status, 'available');
    for (const field of ['followers', 'total_likes', 'total_posts']) assert.equal(Number.isInteger(snapshot[field]), true);
    assert.ok(Date.parse(snapshot.captured_at) >= Date.parse(startedAt) - 1000);
    const pagination = raw.works?.pagination;
    assert.equal(pagination?.evidenceScope, 'sanitized-pagination-fields-not-full-response');
    assert.equal(pagination.requestCount, pagination.pages.length);
    assert.ok(pagination.requestCount >= 1);
    assert.equal(pagination.collectedCount, raw.works.aweme_list.length);
    assert.ok(pagination.collectedCount <= pagination.requestedLimit);
    for (const page of pagination.pages) {
      assert.equal(page.endpoint, endpoint);
      assert.equal(Number.isInteger(page.request.count), true);
      assert.ok(page.request.count > 0 && page.request.count <= 18);
      assert.ok(Number.isFinite(Date.parse(page.capturedAt)));
      assert.equal(page.response.awemeListValid, true);
      assert.equal(page.response.status_code, 0);
    }
    const finalPage = pagination.pages.at(-1);
    assert.equal(raw.works.has_more, finalPage.response.has_more);
    assert.equal(raw.works.max_cursor, finalPage.response.max_cursor);
    if (finalPage.response.anonymousRestricted) {
      assert.equal(raw.works.stopReason, 'anonymous-window');
      assert.equal(snapshot.works_coverage, 'limited');
    } else if (raw.works.stopReason === 'end-of-list') {
      assert.ok([false, 0, '0'].includes(finalPage.response.has_more));
      assert.equal(snapshot.works_coverage, 'complete');
    } else {
      assert.notEqual(snapshot.works_coverage, 'complete');
    }
    const after = database.prepare('SELECT * FROM targets WHERE id=?').get(targetId);
    for (const field of ['locator', 'provider', 'enabled']) assert.equal(after[field], before[field]);
    for (const field of ['douyinId', 'importSource']) {
      assert.deepEqual(JSON.parse(after.metadata_json)[field], JSON.parse(before.metadata_json)[field]);
    }
    const result = {
      startedAt, checkedAt: new Date().toISOString(), ok: true, targetId, runId: run.runId,
      originalIdentityPreserved: true,
      snapshot: { id: snapshot.id, capturedAt: snapshot.captured_at, followers: snapshot.followers,
        likes: snapshot.total_likes, totalPosts: snapshot.total_posts, accountStatus: snapshot.account_status,
        worksCoverage: snapshot.works_coverage, sourceChecksum: snapshot.source_checksum },
      stopReason: raw.works.stopReason, pagination,
      caveat: 'One normal public collection verifies persistence; it does not prove complete daily publication coverage.',
    };
    writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
} finally {
  database.close();
}

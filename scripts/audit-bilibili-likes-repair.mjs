import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { checksum } from '../lib/utils.mjs';

const baseline = process.argv[2];
if (!baseline) throw new Error('Provide the exact pre-release snapshot');
const db = new DatabaseSync(new URL('../data/douyin-monitor.sqlite', import.meta.url), { readOnly: true });
try {
  db.prepare('ATTACH DATABASE ? AS before_release').run(baseline);
  const unchangedTables = {};
  for (const table of ['snapshots', 'post_metrics', 'target_boards', 'board_catalog']) {
    unchangedTables[table] = db.prepare(`SELECT COUNT(*) count FROM (SELECT * FROM before_release.${table} EXCEPT SELECT * FROM main.${table})`).get().count;
  }
  // A real refresh may update last-check status, time and current post metrics.
  // Imported identity, membership and the original time-series must not change.
  const targetColumns = 'id,type,label,locator,provider,enabled,created_at';
  let changedIdentities = db.prepare(`SELECT COUNT(*) count FROM (SELECT ${targetColumns} FROM before_release.targets EXCEPT SELECT ${targetColumns} FROM main.targets)`).get().count;
  const refreshedVerificationTimes = [];
  const changedMetadata = db.prepare('SELECT b.id,b.metadata_json AS oldMetadata,m.metadata_json AS newMetadata FROM before_release.targets b JOIN main.targets m ON b.id=m.id WHERE b.metadata_json<>m.metadata_json').all();
  for (const row of changedMetadata) {
    const before = JSON.parse(row.oldMetadata);
    const after = JSON.parse(row.newMetadata);
    if (row.id >= 985 && row.id <= 998) {
      for (const field of ['identityVerification', 'nameVerification']) {
        if (before[field]?.verifiedAt !== after[field]?.verifiedAt) refreshedVerificationTimes.push({ id: row.id, field: `${field}.verifiedAt`, before: before[field]?.verifiedAt, after: after[field]?.verifiedAt });
        if (before[field]) delete before[field].verifiedAt;
        if (after[field]) delete after[field].verifiedAt;
      }
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) changedIdentities += 1;
  }
  const lostPosts = db.prepare('SELECT COUNT(*) count FROM (SELECT id,target_id,external_id,first_seen_at FROM before_release.posts EXCEPT SELECT id,target_id,external_id,first_seen_at FROM main.posts)').get().count;
  const accounts = Array.from({ length: 14 }, (_, index) => {
    const id = 985 + index;
    const target = db.prepare('SELECT label,locator FROM targets WHERE id=?').get(id);
    const row = db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY julianday(captured_at) DESC,id DESC LIMIT 1').get(id);
    const raw = JSON.parse(row.raw_json);
    const evidence = raw.sourceEvidence?.bilibiliCard;
    return {
      id, label: target.label, capturedAt: row.captured_at, likes: row.total_likes,
      sourceAgrees: row.total_likes !== null && row.total_likes === evidence?.data?.like_num,
      identityAgrees: String(evidence?.data?.card?.mid) === target.locator && evidence?.requestedMid === target.locator,
      checksumAgrees: row.source_checksum === checksum(raw),
      oldNullSnapshots: db.prepare('SELECT COUNT(*) count FROM before_release.snapshots WHERE target_id=? AND total_likes IS NULL').get(id).count,
    };
  });
  const result = { checkedAt: new Date().toISOString(), unchangedTables, changedIdentities, refreshedVerificationTimes, lostPosts, accounts,
    ok: Object.values(unchangedTables).every((value) => value === 0) && changedIdentities === 0 && lostPosts === 0
      && accounts.every((account) => account.sourceAgrees && account.identityAgrees && account.checksumAgrees) };
  writeFileSync(new URL('../output/playwright/bilibili-likes-repair-audit.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally { db.close(); }

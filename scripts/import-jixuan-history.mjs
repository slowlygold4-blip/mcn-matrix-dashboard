#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checksum, nowIso } from "../lib/utils.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const rosterPath = resolve(argument("--roster", ""));
const historyDir = resolve(argument("--history", ""));
const databasePath = resolve(argument("--database", "data/douyin-monitor.sqlite"));
if (!rosterPath || !historyDir) throw new Error("需要 --roster 和 --history");

const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
const historyFiles = readdirSync(historyDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; BEGIN IMMEDIATE;");

try {
  const timestamp = nowIso();
  const addTarget = db.prepare(`
    INSERT OR IGNORE INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
    VALUES('account',?,?, 'public-web',?,?,?,?)
  `);
  const findTarget = db.prepare("SELECT id FROM targets WHERE type='account' AND locator=? AND provider='public-web'");
  for (const item of roster) {
    const requiresCanonicalLink = /\/search\//.test(item.link || "");
    const metadata = JSON.stringify({
      importedFrom: "极炫指令台",
      rating: item.rating || "",
      source: item.source || "",
      douyinId: item.dyid || "",
      requiresCanonicalLink,
    });
    addTarget.run(item.name, item.link, requiresCanonicalLink ? 0 : 1, metadata, timestamp, timestamp);
  }
  db.prepare(`
    UPDATE targets SET enabled=0,last_status='rejected',
      last_error='搜索结果页不是唯一账号定位；请替换为完整主页/分享链接或 sec_uid',updated_at=?
    WHERE provider='public-web' AND locator LIKE 'https://www.douyin.com/search/%'
  `).run(timestamp);

  const insertSnapshot = db.prepare(`
    INSERT OR IGNORE INTO snapshots(
      target_id,captured_at,followers,total_likes,total_posts,hashtag_views,hashtag_posts,author_count,
      quality_status,account_status,works_coverage,account_error,works_error,warnings_json,source_checksum,raw_json
    ) VALUES(?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?,?,?,?)
  `);
  const updateLatest = db.prepare(`
    UPDATE targets SET last_checked_at=?,last_status=?,last_error=?,updated_at=?
    WHERE id=? AND (last_checked_at IS NULL OR last_checked_at < ?)
  `);

  let insertedSnapshots = 0;
  let skippedRows = 0;
  for (const fileName of historyFiles) {
    const document = JSON.parse(readFileSync(resolve(historyDir, fileName), "utf8"));
    const capturedAt = new Date(`${document.generated.replace(" ", "T")}:00`).toISOString();
    for (const talent of document.talents || []) {
      const target = findTarget.get(talent.link);
      if (!target) { skippedRows += 1; continue; }
      const warning = talent.error ? [String(talent.error)] : [];
      const quality = talent.fans == null ? "rejected" : warning.length ? "warning" : "validated";
      const accountStatus = talent.fans == null && talent.likes == null && talent.works == null ? "unavailable" : talent.fans != null && talent.likes != null ? "available" : "partial";
      const worksCoverage = warning.length ? "retry" : "complete";
      const result = insertSnapshot.run(
        target.id,
        capturedAt,
        talent.fans ?? null,
        talent.likes ?? null,
        talent.works ?? null,
        quality,
        accountStatus,
        worksCoverage,
        null,
        talent.error || null,
        JSON.stringify(warning),
        checksum(talent),
        JSON.stringify({ source: "jixuan-history", original: talent }),
      );
      insertedSnapshots += Number(result.changes || 0);
      updateLatest.run(capturedAt, quality, talent.error || null, timestamp, target.id, capturedAt);
    }
  }

  const runExists = db.prepare("SELECT id FROM runs WHERE trigger_type='migration' AND details_json LIKE '%jixuan-history%' LIMIT 1").get();
  if (!runExists) {
    db.prepare(`
      INSERT INTO runs(trigger_type,started_at,finished_at,status,target_count,success_count,error_count,details_json)
      VALUES('migration',?,?, 'success',?,?,0,?)
    `).run(timestamp, timestamp, roster.length, roster.length, JSON.stringify([{ source: "jixuan-history", historyFiles: historyFiles.length }]));
  }
  db.exec("COMMIT;");
  const targetCount = Number(db.prepare("SELECT COUNT(*) AS count FROM targets WHERE provider='public-web'").get().count);
  const snapshotCount = Number(db.prepare("SELECT COUNT(*) AS count FROM snapshots").get().count);
  console.log(JSON.stringify({ ok: true, targetCount, historyFiles: historyFiles.length, insertedSnapshots, snapshotCount, skippedRows }, null, 2));
} catch (error) {
  db.exec("ROLLBACK;");
  throw error;
} finally {
  db.close();
}

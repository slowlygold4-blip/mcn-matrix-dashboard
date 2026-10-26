// Read-only, reproducible maintenance evidence; never starts collection.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { businessDateKey } from "../lib/utils.mjs";

const [output, baseline] = process.argv.slice(2);
const db = new DatabaseSync("data/douyin-monitor.sqlite", { readOnly: true });
try {
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
  const now = new Date(), date = businessDateKey(now);
  const start = new Date(date + "T00:00:00+08:00").toISOString();
  const end = now.toISOString();
  const accounts = db.prepare(`WITH ranked AS (
    SELECT s.*,ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY captured_at DESC,id DESC) n
    FROM snapshots s WHERE captured_at>=? AND captured_at<=?
      AND quality_status IN ('validated','warning'))
    SELECT t.id,s.followers,s.total_likes,s.total_posts,s.works_coverage
    FROM targets t LEFT JOIN ranked s ON s.target_id=t.id AND s.n=1
    WHERE t.enabled=1 AND t.type='account'`).all(start, end);
  const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const works = { complete:0, limited:0, unavailable:0, unknown:0, missing:0 };
  for (const a of accounts) works[Object.hasOwn(works,a.works_coverage) ? a.works_coverage : a.works_coverage == null ? "missing" : "unknown"]++;
  const topics = db.prepare(`SELECT t.id,t.label,s.captured_at,s.hashtag_participants,s.hashtag_views
    FROM targets t LEFT JOIN snapshots s ON s.id=(SELECT id FROM snapshots
      WHERE target_id=t.id AND captured_at>=? AND captured_at<=? AND quality_status IN ('validated','warning')
      ORDER BY captured_at DESC,id DESC LIMIT 1)
    WHERE t.enabled=1 AND t.type='hashtag'`).all(start,end);
  const counts = {};
  for (const table of ["targets","snapshots","posts","post_metrics","runs","audits","target_boards","account_events"]) {
    counts[table] = db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  }
  const result = {
    checkedAt:end,businessDate:date,readOnly:true,
    coverage:{accounts:accounts.length,profileValid:accounts.filter(a=>[a.followers,a.total_likes,a.total_posts].every(finite)).length,works,
      topicValid:topics.filter(t=>[t.hashtag_participants,t.hashtag_views].every(finite)).length,topicTotal:topics.length},
    topics,counts,
    running:db.prepare("SELECT id,trigger_type,started_at,target_count,processed_count FROM runs WHERE status='running'").all(),
    latestRun:db.prepare("SELECT id,status,trigger_type,started_at,finished_at,target_count,processed_count FROM runs ORDER BY id DESC LIMIT 1").get(),
    quickCheck:db.prepare("PRAGMA quick_check").all(),
    foreignKeyViolations:db.prepare("PRAGMA foreign_key_check").all().length,
  };
  if (baseline) {
    db.prepare("ATTACH DATABASE ? AS baseline").run(baseline);
    result.originalRowsChangedOrMissing = {};
    for (const table of ["snapshots","post_metrics","target_boards","board_catalog","account_events","source_probes"]) {
      result.originalRowsChangedOrMissing[table] = db.prepare(`SELECT count(*) n FROM (
        SELECT * FROM baseline.${table} EXCEPT SELECT * FROM main.${table})`).get().n;
    }
    result.originalIdentityChangedOrMissing = db.prepare(`SELECT count(*) n FROM (
      SELECT id,type,provider,label,locator,enabled,created_at FROM baseline.targets
      EXCEPT SELECT id,type,provider,label,locator,enabled,created_at FROM main.targets)`).get().n;
    result.addedSnapshots = counts.snapshots - db.prepare("SELECT count(*) n FROM baseline.snapshots").get().n;
  }
  db.exec("COMMIT");
  if(output) writeFileSync(output,JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result,null,2));
} finally { db.close(); }

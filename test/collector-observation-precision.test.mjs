import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { buildPostIngestionReview } from "../lib/post-ingestion-review.mjs";

const collector = fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url));
function python(code) {
  const child = spawnSync("/usr/bin/python3", ["-B", "-c", `import importlib.util,json,sys\nfrom datetime import datetime,timezone,timedelta\nspec=importlib.util.spec_from_file_location("collector",sys.argv[1]); c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)\n${code}`, collector], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}

test("observation timestamps preserve milliseconds in UTC without accepting naive dates", () => {
  const result = python(`out=[c.observation_timestamp(datetime(2026,9,28,12,35,0,700999,tzinfo=timezone.utc)),c.observation_timestamp(datetime(2026,9,28,20,35,0,700000,tzinfo=timezone(timedelta(hours=8))))]\ntry:\n c.observation_timestamp(datetime(2026,9,28,12,35))\nexcept ValueError:\n out.append("naive-rejected")\nprint(json.dumps(out))`);
  assert.deepEqual(result, ["2026-09-28T12:35:00.700Z", "2026-09-28T12:35:00.700Z", "naive-rejected"]);
  const source = readFileSync(collector, "utf8");
  assert.doesNotMatch(source, /time\.strftime\("%Y-%m-%dT%H:%M:%SZ"/);
});

test("request and response sampling points remain independent and retain existing order", () => {
  const result = python(`sec="MS4wLjABAAAAobservationPrecisionFixture1234567"\nc.extract_sec_uid=lambda _:sec\nc.register_guest=lambda:"private-not-output"\nc.fetch_public_profile=lambda *_:({"user":{"sec_uid":sec,"follower_count":1,"total_favorited":2,"aweme_count":0}},"fixture")\nc.a_bogus_signed_url=lambda *_:"https://fixture.invalid/"\nc.request_json=lambda *_a,**_k:{"status_code":0,"aweme_list":[],"has_more":0,"max_cursor":0}\nclock=iter(["2026-09-28T12:35:00.701Z","2026-09-28T12:35:00.705Z","2026-09-28T12:35:00.709Z"])\nc.observation_timestamp=lambda:next(clock)\nr=c.collect_account(sec,30)\nprint(json.dumps({"request":r["works"]["pagination"]["pages"][0]["requestedAt"],"response":r["works"]["pagination"]["pages"][0]["capturedAt"],"snapshot":r["capturedAt"],"coverage":r["worksCoverage"]}))`);
  assert.deepEqual(result, { request: "2026-09-28T12:35:00.701Z", response: "2026-09-28T12:35:00.705Z", snapshot: "2026-09-28T12:35:00.709Z", coverage: "complete" });
});

test("new same-second .700 sampling binds after .340 start but historical seconds and cross-run data remain excluded", () => {
  const at = python('print(json.dumps(c.observation_timestamp(datetime(2026,9,28,12,35,0,700000,tzinfo=timezone.utc))))');
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE targets(id INTEGER,type TEXT);
    CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER);
    CREATE TABLE audits(id INTEGER,target_id INTEGER,run_id INTEGER,status TEXT,created_at TEXT,source_checksum TEXT);
    CREATE TABLE snapshots(id INTEGER,target_id INTEGER,captured_at TEXT,quality_status TEXT,account_status TEXT,works_coverage TEXT,
      followers INTEGER,total_likes INTEGER,total_posts INTEGER,hashtag_participants INTEGER,hashtag_views INTEGER,source_checksum TEXT);
    INSERT INTO targets VALUES (1,'account');
    INSERT INTO runs VALUES (1,'scheduled','2026-09-28T12:35:00.340Z','2026-09-28T12:35:01.100Z','success',1);
    INSERT INTO audits VALUES (1,1,1,'warning','2026-09-28T12:35:01.000Z','same');`);
  const insert = db.prepare("INSERT INTO snapshots VALUES (?,1,?,'warning','available','unavailable',107,618,7,NULL,NULL,'same')");
  insert.run(1, "2026-09-28T12:35:00Z");
  // Same target/checksum from a later run must not be borrowed as this run's evidence.
  db.exec("INSERT INTO runs VALUES (2,'scheduled','2026-09-28T12:35:02.000Z','2026-09-28T12:35:03.000Z','success',1); INSERT INTO audits VALUES (2,1,2,'warning','2026-09-28T12:35:02.900Z','same')");
  insert.run(3, "2026-09-28T12:35:02.700Z");
  const historical = buildPostIngestionReview({ database: db, runId: 1, now: new Date("2026-09-28T12:36:00Z") });
  assert.equal(historical.snapshotCount, 0); assert.equal(historical.account.profileUsable, 0);
  insert.run(2, at);
  const precise = buildPostIngestionReview({ database: db, runId: 1, now: new Date("2026-09-28T12:36:00Z") });
  assert.equal(precise.snapshotCount, 1); assert.equal(precise.account.profileUsable, 1); assert.equal(precise.samples[0].snapshotId, 2);
  assert.equal(db.prepare('SELECT captured_at FROM snapshots WHERE id=1').get().captured_at, "2026-09-28T12:35:00Z");
  db.close();
});

test("HTTP Retry-After date parsing is not changed by observation clock precision", () => {
  const result = python('print(json.dumps(c.parse_retry_after("Mon, 28 Sep 2026 12:35:01 GMT", now=datetime(2026,9,28,12,35,0,700000,tzinfo=timezone.utc).timestamp())))');
  assert.deepEqual(result, { retryAfterStatus: "valid", retryAfterSeconds: 1 });
});

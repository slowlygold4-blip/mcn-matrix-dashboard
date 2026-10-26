import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { checksum } from "../lib/utils.mjs";

function fixture(t) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-29T00:00:00.000Z") });
  const directory = mkdtempSync(join(tmpdir(), "topic-latest-known-"));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: "hashtag", label: "#真实话题", locator: "#真实话题", provider: "public-web" });
  const insert = (capturedAt, participants, views, qualityStatus = "validated", targetId = target.id) => {
    const sampledAt = new Date(capturedAt).toISOString();
    if (Number(targetId) !== Number(target.id)) {
      const result = database.db.prepare(`
        INSERT INTO snapshots(target_id,captured_at,hashtag_participants,hashtag_views,
          quality_status,account_status,works_coverage,warnings_json,source_checksum,raw_json)
        VALUES(?,?,?,?,?,'unknown','not-applicable','[]','unbound-test-evidence','{}')
      `).run(targetId, sampledAt, participants, views, qualityStatus);
      return Number(result.lastInsertRowid);
    }
    const runId = database.beginRun("scheduled", target.id, 1);
    database.db.prepare("UPDATE runs SET started_at=? WHERE id=?").run(new Date(Date.parse(sampledAt) - 60_000).toISOString(), runId);
    const name = target.locator.replace(/^#/, "");
    const raw = {
      scope: "douyin-official-challenge-detail", businessStatusCode: 0,
      challengeId: "7684603502", label: name, officialName: name,
      participants, views, capturedAt: sampledAt,
      provenance: { mode: "douyin-official-anonymous-challenge-detail",
        endpoint: "https://www.douyin.com/aweme/v1/web/challenge/detail/",
        authenticated: false, runtimeAI: false, paidAPI: false },
    };
    const savedQuality = qualityStatus === "validated" && (participants === null || views === null) ? "warning" : qualityStatus;
    const sourceChecksum = checksum(raw);
    const result = database.db.prepare(`
      INSERT INTO snapshots(target_id,captured_at,hashtag_participants,hashtag_views,
        quality_status,account_status,works_coverage,warnings_json,source_checksum,raw_json)
      VALUES(?,?,?,?,?,'unknown','not-applicable','[]',?,?)
    `).run(targetId, sampledAt, participants, views, savedQuality, sourceChecksum, JSON.stringify(raw));
    const auditAt = new Date(Date.parse(sampledAt) + 1000).toISOString();
    database.db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,source_checksum,message)
      VALUES(?,?,?,'public-web',?,?,?)`).run(target.id, runId, auditAt, savedQuality, sourceChecksum, "isolated topic fixture");
    database.finishRun(runId, { status: "success", successCount: 1, processedCount: 1 });
    return Number(result.lastInsertRowid);
  };
  const read = (startDate = "2026-09-29", endDate = startDate) =>
    database.listTopicHistory({ startDate, endDate }).topics.find(topic => topic.id === target.id);
  const insertUnverified = (targetId, capturedAt, participants, views, qualityStatus = "validated") => database.db.prepare(`
    INSERT INTO snapshots(target_id,captured_at,hashtag_participants,hashtag_views,
      quality_status,account_status,works_coverage,warnings_json,source_checksum,raw_json)
    VALUES(?,?,?,?,?,'unknown','not-applicable','[]','not-bound-to-source','{}')
  `).run(targetId, new Date(capturedAt).toISOString(), participants, views, qualityStatus);
  return { database, target, insert, insertUnverified, read };
}

test("latest-known preserves yesterday and its exact adjacent-day delta outside selected today", (t) => {
  const { database, insert, read } = fixture(t);
  insert("2026-09-27T10:00:00.000Z", 4702, 42269640);
  const snapshotId = insert("2026-09-28T10:00:00.000Z", 5185, 51777019);
  const before = database.db.prepare("SELECT * FROM snapshots ORDER BY id").all();
  const result = read();
  assert.deepEqual(result.latestKnown.participants, {
    date: "2026-09-28", capturedAt: "2026-09-28T10:00:00.000Z", value: 5185,
    delta: 483, baselineDate: "2026-09-27", baselineCapturedAt: "2026-09-27T10:00:00.000Z",
    sourceChecksum: database.db.prepare("SELECT source_checksum FROM snapshots WHERE id=?").get(snapshotId).source_checksum, snapshotId,
    qualityStatus: "validated", sourceVerified: true,
  });
  assert.equal(result.latestKnown.views.value, 51777019);
  assert.equal(result.latestKnown.views.delta, 9507379);
  assert.equal(result.observedCount, 0);
  assert.equal(result.sampledCount, 0);
  assert.equal(result.missingCount, 1);
  assert.equal(result.latestAt, null);
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].date, "2026-09-29");
  assert.equal(result.points[0].participants, null);
  assert.equal(result.points[0].participantsDelta, null);
  assert.deepEqual(database.db.prepare("SELECT * FROM snapshots ORDER BY id").all(), before);
});

test("a gap before latest-known remains null daily change, never cross-gap growth", (t) => {
  const { insert, read } = fixture(t);
  insert("2026-09-25T10:00:00.000Z", 10, 100);
  insert("2026-09-27T10:00:00.000Z", 20, 200);
  const result = read();
  assert.equal(result.latestKnown.participants.value, 20);
  assert.equal(result.latestKnown.participants.delta, null);
  assert.equal(result.latestKnown.participants.baselineDate, null);
  assert.equal(result.latestKnown.views.delta, null);
});

test("rejected last snapshot blocks same-day fallback while older valid daily end stays available", (t) => {
  const { insert, read } = fixture(t);
  insert("2026-09-26T10:00:00.000Z", 10, 100);
  insert("2026-09-27T10:00:00.000Z", 15, 150);
  insert("2026-09-28T09:00:00.000Z", 20, 200);
  insert("2026-09-28T10:00:00.000Z", 25, 250, "rejected");
  const result = read("2026-09-27", "2026-09-29");
  assert.equal(result.latestKnown.participants.date, "2026-09-27");
  assert.equal(result.latestKnown.participants.value, 15);
  assert.equal(result.latestKnown.participants.delta, 5);
  assert.equal(result.latestKnown.views.value, 150);
  assert.equal(result.points[1].qualityStatus, "rejected");
  assert.equal(result.points[1].participants, null);
  assert.equal(result.points[2].participantsDelta, null);
});

test("generic topic targets do not expose raw counters; rejected counters stay hidden", (t) => {
  const { database, target, insert, read } = fixture(t);
  insert("2026-09-26T10:00:00.000Z", 100, 1000);
  insert("2026-09-27T10:00:00.000Z", 900, 9000, "rejected");

  const directTargets = [database.getTarget(target.id), database.listTargets().find(item => item.id === target.id)];
  for (const projected of [...directTargets, database.getOverview().targets.find(item => item.id === target.id)]) {
    assert.equal(projected.latestHashtagQualityStatus, "rejected");
    assert.equal(projected.latestHashtagParticipants, null);
    assert.equal(projected.latestHashtagParticipantsDelta, null);
    assert.equal(projected.latestHashtagViews, null);
    assert.equal(projected.latestHashtagViewsDelta, null);
  }
  assert.equal(directTargets[0].latestSnapshotAt, "2026-09-27T10:00:00.000Z");
  assert.equal(directTargets[1].latestSnapshotAt, "2026-09-27T10:00:00.000Z");
  const rejectedHistory = read("2026-09-26", "2026-09-29");
  assert.equal(rejectedHistory.points[1].qualityStatus, "rejected");
  assert.equal(rejectedHistory.points[1].participants, null);
  assert.equal(rejectedHistory.latestKnown.participants.value, 100, "the history API retains the older valid observation with its own date");

  insert("2026-09-28T10:00:00.000Z", 110, 1200);
  const recovered = database.getTarget(target.id);
  assert.equal(recovered.latestHashtagQualityStatus, "unverified",
    "generic target projections do not claim a counter passed history provenance validation");
  assert.equal(recovered.previousHashtagQualityStatus, "rejected");
  assert.equal(recovered.latestHashtagParticipants, null);
  assert.equal(recovered.latestHashtagParticipantsDelta, null, "a rejected previous sample cannot become the change baseline");
  assert.equal(recovered.latestHashtagViews, null);
  assert.equal(recovered.latestHashtagViewsDelta, null);
  assert.equal(recovered.topicMetricsReadSource, "verified-history-only");
  const recoveredHistory = read("2026-09-26", "2026-09-29");
  assert.equal(recoveredHistory.points[2].participants, 110);
  assert.equal(recoveredHistory.points[2].participantsDelta, null);
  assert.equal(database.db.prepare("SELECT hashtag_participants FROM snapshots WHERE target_id=? AND quality_status='rejected'").get(target.id).hashtag_participants, 900,
    "source evidence remains untouched in storage");
});

test("independent indicators keep different latest dates and never fill absent same-day fields", (t) => {
  const { insert, read } = fixture(t);
  insert("2026-09-25T10:00:00.000Z", 5, 50);
  insert("2026-09-26T10:00:00.000Z", 10, 100);
  insert("2026-09-27T09:00:00.000Z", 15, 120);
  insert("2026-09-27T10:00:00.000Z", null, 150);
  insert("2026-09-28T10:00:00.000Z", 20, null);
  const result = read();
  assert.equal(result.latestKnown.participants.date, "2026-09-28");
  assert.equal(result.latestKnown.participants.value, 20);
  assert.equal(result.latestKnown.participants.delta, null);
  assert.equal(result.latestKnown.participants.baselineDate, null,
    "the last sample of the previous calendar day lacked participants; an earlier same-day value cannot replace it");
  assert.equal(result.latestKnown.views.date, "2026-09-27");
  assert.equal(result.latestKnown.views.value, 150);
  assert.equal(result.latestKnown.views.delta, 50);
});

test("real zero remains valid and negative adjacent-day changes are not clamped", (t) => {
  const { insert, read } = fixture(t);
  insert("2026-09-27T10:00:00.000Z", 10, 20);
  insert("2026-09-28T10:00:00.000Z", 0, 0);
  const result = read();
  assert.equal(result.latestKnown.participants.value, 0);
  assert.equal(result.latestKnown.participants.delta, -10);
  assert.equal(result.latestKnown.views.value, 0);
  assert.equal(result.latestKnown.views.delta, -20);
});

test("history cutoff is chronological across offset timestamps and never leaks later days", (t) => {
  const { insert, read } = fixture(t);
  insert("2026-09-26T10:00:00.000Z", 5, 50);
  insert("2026-09-27T23:59:59.999+08:00", 10, 100);
  insert("2026-09-27T16:00:00.000Z", 20, 200);
  insert("2026-09-28T23:59:59.999+08:00", 30, 300);
  const result = read("2026-09-27");
  assert.equal(result.latestKnown.participants.date, "2026-09-27");
  assert.equal(result.latestKnown.participants.capturedAt, "2026-09-27T15:59:59.999Z");
  assert.equal(result.latestKnown.participants.value, 10);
  assert.equal(result.latestKnown.participants.delta, 5);
  assert.equal(result.points[0].participants, 10);
});

test("daily closing selection uses the timestamp instant rather than lexical timezone ordering", (t) => {
  const { insert, read } = fixture(t);
  insert("2026-09-28T20:00:00.000+08:00", 10, 100);
  insert("2026-09-28T13:00:00.000Z", 20, 200);
  const result = read("2026-09-28");
  assert.equal(result.latestKnown.participants.value, 20);
  assert.equal(result.points[0].participants, 20);
});

test("wall-clock future samples including same-day records are excluded", (t) => {
  const { insert, read } = fixture(t);
  insert("2026-09-28T10:00:00.000Z", 10, 100);
  insert("2026-09-29T00:00:01.000Z", 999, 9999);
  insert("2026-09-30T00:00:00.000Z", 9999, 99999);
  const result = read("2026-09-29", "2026-09-30");
  assert.equal(result.latestKnown.participants.value, 10);
  assert.equal(result.latestKnown.participants.date, "2026-09-28");
  assert.equal(result.observedCount, 0);
  assert.equal(result.sampledCount, 0);
  assert.ok(result.points.every(point => point.participants === null && point.capturedAt === null));
});

test("empty/rejected/invalid metrics yield explicit null latest-known rather than zero", (t) => {
  const { insert, read } = fixture(t);
  assert.deepEqual(read().latestKnown, { participants: null, views: null });
  insert("2026-09-26T10:00:00.000Z", 10, 100, "rejected");
  insert("2026-09-27T10:00:00.000Z", -1, -2);
  insert("2026-09-28T10:00:00.000Z", null, null);
  assert.deepEqual(read().latestKnown, { participants: null, views: null });
});

test("latest-known is topic-only and does not expand the requested calendar history", (t) => {
  const { database, insert, read } = fixture(t);
  const account = database.createTarget({ type: "account", label: "排除账号", locator: "topic-only-check", provider: "manual" });
  insert("2026-08-01T10:00:00.000Z", 10, 100);
  insert("2026-09-28T10:00:00.000Z", 999, 9999, "validated", account.id);
  const result = read("2026-09-28", "2026-09-29");
  assert.equal(result.latestKnown.participants.date, "2026-08-01");
  assert.equal(result.latestKnown.participants.value, 10);
  assert.deepEqual(result.points.map(point => point.date), ["2026-09-28", "2026-09-29"]);
  assert.equal(result.missingCount, 2);
  assert.equal(database.listTopicHistory({ startDate: "2026-09-28", endDate: "2026-09-29" }).topics.length, 1);
});

test("unverified later same-day topic row cannot replace verified counters or become a change baseline", (t) => {
  const { database, target, insert, insertUnverified, read } = fixture(t);
  insert("2026-09-27T10:00:00.000Z", 100, 1000);
  insert("2026-09-28T09:00:00.000Z", 120, 1300);
  insertUnverified(target.id, "2026-09-28T10:00:00.000Z", 999999, 99999999);

  const result = read("2026-09-27", "2026-09-29");
  assert.equal(result.points[1].qualityStatus, "unverified");
  assert.equal(result.points[1].sourceVerified, false);
  assert.equal(result.points[1].participants, null);
  assert.equal(result.points[1].views, null);
  assert.equal(result.points[1].participantsDelta, null);
  assert.equal(result.latestKnown.participants.value, 100);
  assert.equal(result.latestKnown.views.value, 1000);
  assert.equal(result.observedCount, 1);
  assert.equal(result.sampledCount, 2);
  for (const projected of [database.getTarget(target.id), database.listTargets().find(item => item.id === target.id),
    database.getOverview().targets.find(item => item.id === target.id)]) {
    assert.equal(projected.latestHashtagQualityStatus, "unverified");
    assert.equal(projected.latestHashtagParticipants, null);
    assert.equal(projected.latestHashtagViews, null);
    assert.equal(projected.latestHashtagParticipantsDelta, null);
    assert.equal(projected.latestHashtagViewsDelta, null);
    assert.equal(projected.topicMetricsReadSource, "verified-history-only");
  }
});

test("manual topic rows remain visible as sampled but never count as real Douyin metrics", (t) => {
  const { database, insertUnverified } = fixture(t);
  const manual = database.createTarget({ type: "hashtag", label: "#手工话题", locator: "#手工话题", provider: "manual" });
  insertUnverified(manual.id, "2026-09-28T10:00:00.000Z", 400, 5000);
  const result = database.listTopicHistory({ startDate: "2026-09-28", endDate: "2026-09-29" }).topics.find(row => row.id === manual.id);
  assert.equal(result.points[0].qualityStatus, "unverified");
  assert.equal(result.points[0].participants, null);
  assert.equal(result.points[0].views, null);
  assert.equal(result.latestKnown.participants, null);
  assert.equal(result.latestKnown.views, null);
  assert.equal(result.sampledCount, 1);
});

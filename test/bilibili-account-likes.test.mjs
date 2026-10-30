import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MonitorDatabase } from "../lib/database.mjs";
import { normalizeCollection } from "../lib/providers/normalize.mjs";
import { checksum } from "../lib/utils.mjs";

const collectorPath = fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url));
const mid = "525138167";
const target = { id: 1, type: "account", provider: "public-web", locator: mid, metadata: { platform: "bilibili" } };

function collectFixtures(scenarios) {
  const python = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("collector", sys.argv[1])
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
output = []
for case in json.loads(sys.argv[2]):
    calls = []
    requested_mid = "525138167"
    data = {"card": {"mid": case.get("returnedMid", requested_mid), "name": "作者", "fans": 20844}}
    if "likes" in case:
        data["like_num"] = case["likes"]
    if case.get("special"):
        data["like_num"] = float(case["special"])
    def fake_json(_opener, url):
        calls.append(url)
        if "/x/web-interface/card?" in url:
            return {"code": 0, "data": data}
        if "/x/space/navnum?" in url:
            return {"code": 0, "data": {"video": 1088}}
        if "/x/web-interface/view?" in url:
            return {"code": 0, "data": {
                "bvid": "BV1fi416bEpi",
                "owner": {"mid": requested_mid}, "title": "最近一条作品",
                "stat": {"like": 99999999}, "pubdate": 1789250000,
            }}
        raise AssertionError("Unexpected network route: " + url)
    collector.bili_json = fake_json
    collector.bili_opener = lambda: object()
    collector.bili_latest_videos = lambda _opener, _mid, _limit, **_kwargs: (
        [{"bvid": "BV1fi416bEpi"}] if case.get("works") else []
    )
    try:
        result = collector.collect_bilibili_account(requested_mid, 1)
        output.append({"result": result, "calls": calls})
    except collector.CollectorError as error:
        output.append({"error": str(error), "calls": calls})
print(json.dumps(output, ensure_ascii=False, allow_nan=False))
`;
  const child = spawnSync("/usr/bin/python3", ["-B", "-c", python, collectorPath, JSON.stringify(scenarios)], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

test("Bilibili card maps UID-verified account cumulative likes through the normalizer", () => {
  const [{ result, calls }] = collectFixtures([{ likes: 919721, works: true }]);
  const normalized = normalizeCollection(target, result);
  assert.equal(result.profile.user.total_favorited, 919721);
  assert.equal(normalized.snapshot.totalLikes, 919721);
  assert.equal(normalized.snapshot.followers, 20844);
  assert.equal(normalized.snapshot.totalPosts, 1088);
  assert.equal(normalized.posts[0].likes, 99999999);
  assert.notEqual(normalized.snapshot.totalLikes, normalized.posts[0].likes);
  assert.equal(result.provenance.totalLikesScope, "account-cumulative-received-likes");
  assert.equal(result.provenance.totalLikesSource, "https://api.bilibili.com/x/web-interface/card:data.like_num");
  assert.equal(result.provenance.paidAPI, false);
  assert.equal(result.provenance.cookiePersisted, false);
  assert.deepEqual(result.sourceEvidence.bilibiliCard.data, {
    card: { mid }, like_num: 919721,
  });
  assert.equal(result.sourceEvidence.bilibiliCard.likeNumPresent, true);
  assert.equal(result.sourceEvidence.bilibiliCard.likeNumValid, true);
  assert.equal(calls.length, 3, "mapping reuses the existing card request without a new API call");
});

test("Bilibili card retains explicit zero and exact finite integer values", () => {
  const values = [0, 0.0, 22, 919721, Number.MAX_SAFE_INTEGER];
  const fixtures = collectFixtures(values.map((likes) => ({ likes })));
  for (const [index, { result }] of fixtures.entries()) {
    assert.equal(normalizeCollection(target, result).snapshot.totalLikes, values[index]);
    assert.ok(!result.warnings.some((warning) => warning.includes("累计获赞")));
  }
});

test("Bilibili missing or invalid account likes stay null even when recent works have likes", () => {
  const scenarios = [
    {}, { likes: null }, { likes: "" }, { likes: "100" }, { likes: true }, { likes: false },
    { likes: -1 }, { likes: 1.5 }, { likes: [] }, { likes: {} },
    { likes: Number.MAX_SAFE_INTEGER + 1 }, { special: "nan" }, { special: "inf" },
    { special: "-inf" },
  ];
  for (const { result } of collectFixtures(scenarios.map((value) => ({ ...value, works: true })))) {
    assert.equal(result.profile.user.total_favorited, null);
    assert.equal(normalizeCollection(target, result).snapshot.totalLikes, null);
    assert.equal(result.sourceEvidence.bilibiliCard.data.like_num, null);
    assert.equal(result.sourceEvidence.bilibiliCard.likeNumValid, false);
    assert.match(result.warnings.join("；"), /未返回有效累计获赞.*保留为空/);
  }
});

test("normal snapshot persistence retains the public card evidence and never backfills old null history", (t) => {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const account = database.createTarget({ ...target, label: "测试 B站作者" });
  const runId = database.beginRun("test", account.id, 1);
  const [old, fresh] = collectFixtures([{}, { likes: 919721 }]);
  // This fixture represents two real historical collection times, including
  // the response-clock receipt. Do not relabel only the normalized timestamp.
  for (const [fixture, at] of [[old, '2026-09-12T12:00:00.000Z'], [fresh, '2026-09-13T12:00:00.000Z']]) {
    fixture.result.capturedAt = at;
    fixture.result.workObservationTimes.startedAt = at;
    fixture.result.workObservationTimes.completedAt = at;
  }
  const before = normalizeCollection(account, old.result, { capturedAt: old.result.capturedAt });
  const after = normalizeCollection(account, fresh.result, { capturedAt: fresh.result.capturedAt });
  database.saveCollection(account, runId, before);
  const original = database.db.prepare("SELECT * FROM snapshots WHERE target_id=?").get(account.id);
  database.saveCollection(account, runId, after);
  const rows = database.db.prepare("SELECT * FROM snapshots WHERE target_id=? ORDER BY id").all(account.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], original);
  assert.equal(rows[0].total_likes, null);
  assert.equal(rows[1].total_likes, 919721);
  const raw = JSON.parse(rows[1].raw_json);
  assert.deepEqual(raw.sourceEvidence.bilibiliCard.data, { card: { mid }, like_num: 919721 });
  assert.equal(raw.sourceEvidence.bilibiliCard.endpoint,
    `https://api.bilibili.com/x/web-interface/card?mid=${mid}&photo=true`);
  assert.equal(rows[1].source_checksum, checksum(raw));
});

test("Bilibili card UID mismatch or absence rejects before likes and works can be accepted", () => {
  for (const { error, calls } of collectFixtures([
    { returnedMid: "999999999", likes: 919721, works: true },
    { returnedMid: "", likes: 919721, works: true },
  ])) {
    assert.match(error, /UID 与提交 UID 不一致/);
    assert.equal(calls.length, 1);
  }
});

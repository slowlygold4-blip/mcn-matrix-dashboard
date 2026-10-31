import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MonitorDatabase } from "../lib/database.mjs";
import { MonitorScheduler } from "../lib/scheduler.mjs";
import { normalizeCollection } from "../lib/providers/normalize.mjs";
import { localDateKey, checksum } from "../lib/utils.mjs";

const SEC_UID = "MS4wLjABAAAApaginationFixtureCanonicalIdentity12345";
const ENDPOINT = "https://www.douyin.com/aweme/v1/web/aweme/post/";
const target = { id: 1, type: "account", provider: "public-web", locator: SEC_UID, metadata: { platform: "douyin" } };
const work = (id, secUid = SEC_UID) => ({ aweme_id: String(7770000000000000000n + BigInt(id)),
  create_time: 1789250000, author: { sec_uid: secUid }, statistics: { digg_count: 5 } });
const page = (count, start = 0, extra = {}) => ({ status_code: 0,
  aweme_list: Array.from({ length: count }, (_, index) => work(start + index)), has_more: 1, max_cursor: 123, ...extra });

function collectFixtures(cases) {
  const python = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("collector",sys.argv[1])
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
original_request_json=c.request_json
out=[]
for case in json.loads(sys.argv[2]):
    calls=[]
    pages=iter(case.get("pages",[]))
    c.register_guest=lambda:"do-not-persist-guest-cookie"
    c.fetch_public_profile=lambda *_args:({"status_code":0,"user":{
        "sec_uid":sys.argv[3],"uid":"1234567890","unique_id":"pagination_fixture",
        "nickname":"分页隔离作者","follower_count":100,"total_favorited":200,"aweme_count":case.get("totalPosts",100)
    }},"guest-ttwid-unsigned-profile")
    def sign(endpoint,params):
        assert endpoint==c.POSTS_URL
        calls.append({"count":int(params["count"]),"max_cursor":params["max_cursor"]})
        return endpoint+"?a_bogus=[REDACTED]"
    def request(url,**kwargs):
        assert kwargs["cookie"]=="do-not-persist-guest-cookie"
        try: value=next(pages)
        except StopIteration: raise AssertionError("Unexpected additional page request")
        if "fixtureError" in value: raise c.CollectorError(value["fixtureError"])
        return value
    c.a_bogus_signed_url=sign
    c.request_json=request
    c.request=lambda *_a,**_k:(_ for _ in ()).throw(AssertionError("External requests forbidden"))
    if "rawBody" in case:
        c.request_json=original_request_json
        c.request=lambda url,**_kwargs:(case["rawBody"].encode("utf-8"),url)
    c.time.sleep=lambda *_a:None
    result=c.collect_account(sys.argv[3],case.get("limit",30))
    out.append({"result":result,"calls":calls})
print(json.dumps(out,ensure_ascii=False))
`;
  const child = spawnSync("/usr/bin/python3", ["-B", "-c", python,
    fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url)), JSON.stringify(cases), SEC_UID],
  { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stdout, /do-not-persist/);
  return JSON.parse(child.stdout);
}

test("two ordinary pages reaching the local limit retain upstream continuation and never claim complete", () => {
  const [{ result, calls }] = collectFixtures([{ pages: [page(18), page(12, 18, { max_cursor: "456" })] }]);
  assert.equal(result.worksCoverage, "limited");
  assert.equal(result.works.stopReason, "local-limit");
  assert.equal(result.works.aweme_list.length, 30);
  assert.equal(result.works.has_more, 1);
  assert.equal(result.works.max_cursor, "456", "retain the response value and its string type");
  assert.deepEqual(calls, [{ count: 18, max_cursor: "0" }, { count: 12, max_cursor: "123" }]);
  assert.equal(result.works.pagination.requestCount, 2);
  assert.deepEqual(result.works.pagination.pages.map((item) => item.retainedCount), [18, 12]);
  assert.equal(result.profile.user.aweme_count, 100);
  assert.equal(normalizeCollection(target, result).worksCoverage, "limited");
});

test("missing and malformed work arrays remain retryable and differ from an explicit terminal empty list", () => {
  const fixtures = collectFixtures([
    { pages: [{ status_code: 0 }] },
    ...[null, {}, ""].map((value) => ({ pages: [{ status_code: 0, aweme_list: value, has_more: 0, max_cursor: 0 }] })),
    { totalPosts: 0, pages: [page(0, 0, { has_more: 0, max_cursor: 0 })] },
  ]);
  for (const [index, { result, calls }] of fixtures.slice(0, 4).entries()) {
    assert.equal(result.worksCoverage, "retry");
    assert.equal(result.works.stopReason, index ? "invalid-list" : "missing-list");
    assert.equal(result.works.pagination.pages[0].rawCount, null);
    assert.equal(result.works.pagination.pages[0].response.awemeListPresent, index > 0);
    assert.equal(result.works.pagination.pages[0].response.awemeListValid, false);
    assert.equal(normalizeCollection(target, result).worksCoverage, "retry");
    assert.equal(calls.length, 1);
  }
  assert.equal(fixtures[0].result.works.has_more, null);
  assert.equal(fixtures[0].result.works.max_cursor, null);
  const explicit = fixtures[4].result;
  assert.equal(explicit.worksCoverage, "complete");
  assert.equal(explicit.works.stopReason, "end-of-list");
  assert.equal(explicit.works.has_more, 0);
  assert.equal(explicit.works.max_cursor, 0);
  assert.equal(explicit.works.pagination.pages[0].rawCount, 0);
  assert.equal(normalizeCollection(target, explicit).worksCoverage, "complete");
});

test("unknown continuation, non-progressing cursors and empty pages with more cannot produce false completeness", () => {
  const cases = [
    [page(1, 0, { has_more: undefined }), "missing-has-more"],
    [page(1, 0, { has_more: "do-not-persist-invalid-value" }), "invalid-has-more"],
    [page(1, 0, { max_cursor: undefined }), "missing-or-invalid-cursor"],
    [page(1, 0, { max_cursor: "do-not-persist-invalid-cursor" }), "missing-or-invalid-cursor"],
    [page(1, 0, { max_cursor: "000" }), "cursor-repeated"],
    [page(0), "empty-page-with-more"],
  ];
  const results = collectFixtures(cases.map(([value]) => ({ pages: [value] })));
  results.forEach(({ result, calls }, index) => {
    assert.equal(result.worksCoverage, "retry");
    assert.equal(result.works.stopReason, cases[index][1]);
    assert.equal(normalizeCollection(target, result).worksCoverage, "retry");
    assert.equal(calls.length, 1);
  });
});

test("two-cursor cycles and pure duplicate pages stop without an unbounded request loop", () => {
  const results = collectFixtures([
    { pages: [page(1, 0), page(1, 1, { max_cursor: 456 }), page(1, 2, { max_cursor: 123 })] },
    { pages: [page(1, 0), page(1, 0, { max_cursor: 456 })] },
  ]);
  assert.equal(results[0].result.works.stopReason, "cursor-repeated");
  assert.equal(results[0].calls.length, 3);
  assert.equal(results[0].result.works.max_cursor, 123);
  assert.equal(results[1].result.works.stopReason, "no-new-items");
  assert.equal(results[1].calls.length, 2);
  assert.equal(results[1].result.works.pagination.pages[1].duplicateCount, 1);
  for (const { result } of results) assert.equal(result.worksCoverage, "retry");
});

test("anonymous windows retain original pagination but store only labelled whitelist evidence", () => {
  const payload = page(3, 0, { max_cursor: "999", has_more: true,
    not_login_module: { note: "do-not-persist-module-secret" }, extra_secret: "do-not-persist-unknown-field" });
  payload.aweme_list.push(work(3, "MS4wLjABAAAAanotherAuthorIdentity12345"), work(0), null);
  const [{ result, calls }] = collectFixtures([{ pages: [payload] }]);
  assert.equal(calls.length, 1);
  assert.equal(result.worksCoverage, "latest-public-window");
  assert.equal(normalizeCollection(target, result).worksCoverage, "limited");
  assert.equal(result.works.stopReason, "anonymous-window");
  assert.equal(result.works.has_more, true);
  assert.equal(result.works.max_cursor, "999");
  assert.equal(result.works.public_window_limited, true);
  const evidence = result.works.pagination;
  assert.equal(evidence.evidenceScope, "sanitized-pagination-fields-not-full-response");
  assert.equal(evidence.collectedCount, 3);
  const first = evidence.pages[0];
  assert.equal(first.endpoint, ENDPOINT);
  assert.equal(first.rawCount, 6);
  assert.equal(first.retainedCount, 3);
  assert.equal(first.excludedNonTargetCount, 1);
  assert.equal(first.duplicateCount, 1);
  assert.equal(first.invalidCount, 1);
  assert.equal(first.response.notLoginModulePresent, true);
  assert.equal(first.response.anonymousRestricted, true);
  assert.match(first.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(first.request, { count: 18, max_cursor: 0 });
  assert.doesNotMatch(JSON.stringify(evidence), /Cookie|a_bogus|Set-Cookie|extra_secret/);
});

test("oversized terminal responses are limited if truncated, while exact-size terminal pages can complete", () => {
  const results = collectFixtures([
    { limit: 2, pages: [page(3, 0, { has_more: 0, max_cursor: 0 })] },
    { limit: 2, pages: [page(2, 0, { has_more: "0", max_cursor: "0" })] },
  ]);
  assert.equal(results[0].result.worksCoverage, "limited");
  assert.equal(results[0].result.works.stopReason, "local-limit");
  assert.equal(results[0].result.works.pagination.pages[0].localOmittedCount, 1);
  assert.equal(results[0].result.works.aweme_list.length, 2);
  assert.equal(results[1].result.worksCoverage, "complete");
  assert.equal(results[1].result.works.stopReason, "end-of-list");
  assert.equal(results[1].result.works.has_more, "0");
});

test("a later transport failure retains earlier work evidence and the valid profile without claiming an end", () => {
  const [{ result, calls }] = collectFixtures([{ pages: [page(1), { fixtureError: "fixture timeout" }] }]);
  assert.equal(calls.length, 2);
  assert.equal(result.worksCoverage, "unavailable");
  assert.equal(result.works.stopReason, "request-failed");
  assert.equal(result.works.aweme_list.length, 1);
  assert.equal(result.works.has_more, 1);
  assert.equal(result.works.max_cursor, 123);
  assert.equal(result.works.pagination.pages[1].response, null);
  assert.equal(result.profile.user.follower_count, 100);
  assert.equal(normalizeCollection(target, result).accountStatus, "available");
});

test("real JSON parsing rejects whole-response arrays and scalars while keeping the already-read profile", () => {
  const results = collectFixtures([
    ...["[]", "null", '"not-an-object"', "123"].map((rawBody) => ({ rawBody })),
    { totalPosts: 0, rawBody: JSON.stringify(page(0, 0, { has_more: 0, max_cursor: 0 })) },
  ]);
  for (const { result, calls } of results.slice(0, 4)) {
    assert.equal(calls.length, 1);
    assert.equal(result.worksCoverage, "unavailable");
    assert.equal(result.works.stopReason, "request-failed");
    assert.match(result.worksError, /JSON 对象/);
    assert.equal(result.works.pagination.pages[0].response, null);
    assert.equal(result.profile.user.follower_count, 100);
    assert.equal(normalizeCollection(target, result).accountStatus, "available");
  }
  assert.equal(results[4].result.worksCoverage, "complete");
});

test("anonymous works require integer business success before accepting even a terminal empty array", () => {
  const terminal = { aweme_list: [], has_more: 0, max_cursor: 0 };
  const bodies = [
    JSON.stringify(terminal),
    ...[null, false, true, "0"].map((status_code) => JSON.stringify({ ...terminal, status_code })),
    '{"status_code":0.0,"aweme_list":[],"has_more":0,"max_cursor":0}',
  ];
  const results = collectFixtures([
    ...bodies.map((rawBody) => ({ totalPosts: 0, rawBody })),
    { totalPosts: 0, rawBody: JSON.stringify({ ...terminal, status_code: 0 }) },
    { totalPosts: 1, rawBody: JSON.stringify(page(1, 0, { has_more: 0, max_cursor: 0 })) },
  ]);
  for (const { result, calls } of results.slice(0, bodies.length)) {
    assert.equal(calls.length, 1);
    assert.equal(result.worksCoverage, "unavailable");
    assert.equal(result.worksErrorCode, "upstream_changed");
    assert.equal(result.works.stopReason, "request-failed");
    assert.deepEqual(result.works.aweme_list, []);
    assert.equal(result.works.pagination.pages[0].response, null);
    const normalized = normalizeCollection(target, result);
    assert.equal(normalized.accountStatus, "available");
    assert.equal(normalized.snapshot.followers, 100);
    assert.equal(normalized.snapshot.totalLikes, 200);
    assert.equal(normalized.worksCoverage, "unavailable");
  }
  for (const { result } of results.slice(bodies.length)) {
    assert.equal(result.worksCoverage, "complete");
    assert.equal(result.works.stopReason, "end-of-list");
    assert.equal(result.works.pagination.pages[0].response.status_code, 0);
  }
  assert.equal(results.at(-1).result.works.aweme_list.length, 1);
});

test("profile and post require explicit business success; detail and uninstrumented contracts stay independent", () => {
  const python = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("collector",sys.argv[1])
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
out=[]
detail_url="https://www.douyin.com/aweme/v1/web/aweme/detail/"
for endpoint,payload,evidence in [
    (c.PROFILE_URL,{},{}),
    (c.POSTS_URL,{},None),
    (detail_url,{},{}),
    (detail_url,{"status_code":0},{}),
    (detail_url,{"status_code":2483},{}),
    (c.POSTS_URL,{"status_code":2483},{}),
    (c.POSTS_URL,{"status_code":1},{}),
]:
    c.request=lambda url,**kwargs:(json.dumps(payload).encode(),url)
    try:
        c.request_json(endpoint,referer="offline",transport_evidence=evidence)
        out.append("accepted")
    except c.CollectorError as error:
        out.append(error.code)
print(json.dumps(out))
`;
  const child = spawnSync("/usr/bin/python3", ["-B", "-c", python,
    fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url))],
  { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ["upstream_changed", "accepted", "upstream_changed", "accepted",
    "business_error", "login_required", "business_error"]);
});

test("missing works business status cannot erase saved posts, metrics or their accepted snapshot", (t) => {
  const [{ result: previous }, { result: rejected }] = collectFixtures([
    { totalPosts: 1, rawBody: JSON.stringify(page(1, 0, { has_more: 0, max_cursor: 0 })) },
    { totalPosts: 0, rawBody: JSON.stringify({ aweme_list: [], has_more: 0, max_cursor: 0 }) },
  ]);
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const storedTarget = database.createTarget({ ...target, label: "作品成功状态保全测试" });
  previous.capturedAt = new Date(Date.parse(previous.capturedAt) - 1000).toISOString();
  database.saveCollection(storedTarget, null, normalizeCollection(storedTarget, previous, { capturedAt: previous.capturedAt }));
  const oldPosts = database.db.prepare("SELECT * FROM posts ORDER BY id").all();
  const oldMetrics = database.db.prepare("SELECT * FROM post_metrics ORDER BY id").all();
  const oldSnapshot = database.db.prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1").get();
  assert.equal(oldPosts.length, 1);
  assert.equal(oldMetrics.length, 1);
  assert.equal(oldSnapshot.works_coverage, "complete");
  database.saveCollection(storedTarget, null, normalizeCollection(storedTarget, rejected, { capturedAt: rejected.capturedAt }));
  assert.deepEqual(database.db.prepare("SELECT * FROM posts ORDER BY id").all(), oldPosts);
  assert.deepEqual(database.db.prepare("SELECT * FROM post_metrics ORDER BY id").all(), oldMetrics);
  assert.deepEqual(database.db.prepare("SELECT * FROM snapshots WHERE id=?").get(oldSnapshot.id), oldSnapshot);
  const latest = database.db.prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1").get();
  assert.equal(latest.works_coverage, "unavailable");
  assert.equal(latest.followers, 100);
  assert.equal(latest.total_likes, 200);
});

test("real terminal JSON with malformed items preserves profile and good works without claiming complete", () => {
  const invalidItems = [null, { ...work(1), statistics: "invalid" },
    { ...work(1), statistics: [1] }, { ...work(1), text_extra: 123 }, { ...work(1), text_extra: {} }];
  const results = collectFixtures(invalidItems.map((invalid) => ({ rawBody: JSON.stringify({
    status_code: 0, aweme_list: [work(0), invalid], has_more: 0, max_cursor: 0,
  }) })));
  for (const { result, calls } of results) {
    assert.equal(calls.length, 1);
    assert.equal(result.worksCoverage, "retry");
    assert.equal(result.works.stopReason, "invalid-items");
    assert.equal(result.works.aweme_list.length, 1);
    assert.equal(result.works.pagination.pages[0].invalidCount, 1);
    assert.equal(result.profile.user.total_favorited, 200);
    assert.equal(normalizeCollection(target, result).accountStatus, "available");
  }
});

test("invalid records on an earlier page prevent terminal completeness while optional null fields remain allowed", () => {
  const first = page(1, 0);
  first.aweme_list.push({ ...work(99), statistics: "invalid" });
  const second = page(1, 1, { has_more: 0, max_cursor: 0 });
  second.aweme_list[0].statistics = null;
  second.aweme_list[0].text_extra = null;
  const [{ result, calls }] = collectFixtures([{ pages: [first, second] }]);
  assert.equal(calls.length, 2);
  assert.equal(result.worksCoverage, "retry");
  assert.equal(result.works.stopReason, "invalid-items");
  assert.equal(result.works.aweme_list.length, 2);
  assert.deepEqual(result.works.pagination.pages.map((item) => item.invalidCount), [1, 0]);
  assert.equal(result.works.aweme_list[1].statistics.digg_count, undefined);
});

test("normal scheduler persistence keeps limited collection settled but malformed pagination retryable", async (t) => {
  const fixtures = collectFixtures([{ limit: 1, pages: [page(1)] }, { pages: [{ status_code: 0 }] }]);
  for (const [index, { result: raw }] of fixtures.entries()) {
    const database = new MonitorDatabase(":memory:");
    t.after(() => database.close());
    database.setSettings({ scheduleTime: "00:00" });
    const storedTarget = database.createTarget({ ...target, label: "分页落库测试" });
    const scheduler = new MonitorScheduler(database, { scheduledRetryDelaysMs: [0],
      providerOptions: { cooldownMs: 0, execFileImpl: (_file, _args, _options, callback) =>
        callback(null, JSON.stringify({ ok: true, data: raw }), "") } });
    await scheduler.runAll({ triggerType: "scheduled" });
    const snapshot = database.db.prepare("SELECT * FROM snapshots WHERE target_id=?").get(storedTarget.id);
    assert.equal(snapshot.works_coverage, index ? "retry" : "limited");
    assert.equal(snapshot.total_posts, 100);
    assert.equal(snapshot.source_checksum, checksum(JSON.parse(snapshot.raw_json)));
    assert.deepEqual(JSON.parse(snapshot.raw_json).works.pagination, raw.works.pagination);
    const due = scheduler.scheduledDueTargetIds(localDateKey(), new Date(Date.now() + 60_000));
    assert.deepEqual(due, index ? [storedTarget.id] : []);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";

const collector = fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url));
const fixture = String.raw`
import importlib.util, io, json, sys, urllib.error
spec = importlib.util.spec_from_file_location("collector", sys.argv[1])
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
case = json.loads(sys.argv[2]); calls = []; sleeps = []
video = {"bvid": "BV1fi416bEpi", "title": "offline", "created": 1}
class Opener:
    def open(self, request, timeout=None):
        path = c.urllib.parse.urlparse(request.full_url).path; calls.append(path)
        dynamic = "web-dynamic" in path
        if case.get("dynamic") and not dynamic:
            payload = {"code": 0, "data": {"list": {"vlist": []}}}
        elif case.get("transport") and len(calls) == 1:
            raise urllib.error.URLError("offline timeout")
        elif "http" in case:
            raise urllib.error.HTTPError(request.full_url, case["http"], "offline refusal", {}, None)
        else:
            payload = {"code": case.get("code", 0), "data": {"list": {"vlist": [video]}, "items": [{"modules": {"module_dynamic": {"major": {"archive": video}}}}]}}
        if case.get("empty"):
            payload = {"code": 0, "data": {"list": {"vlist": []}, "items": []}}
        if case.get("missingList"):
            payload = {"code": 0, "data": {}}
        if case.get("badElement") and (not case.get("dynamic") or dynamic):
            payload = {"code": 0, "data": {"list": {"vlist": [None]}, "items": [None]}}
        if case.get("badNested") and dynamic:
            payload = {"code": 0, "data": {"items": [{"modules": "invalid"}]}}
        if case.get("mixedNonvideo") and dynamic:
            payload = {"code": 0, "data": {"items": [
                {"modules": {"module_dynamic": {"major": None}}},
                {"modules": {"module_dynamic": {"major": {"archive": None}}}},
                {"modules": {"module_dynamic": {"major": {"archive": video}}}},
            ]}}
        return io.BytesIO(json.dumps(payload).encode())
c.bili_wbi_key = lambda opener: "offline-fixture"
if case.get("keyError"):
    def fail_key(opener):
        raise c.CollectorError("offline unclassified key refusal")
    c.bili_wbi_key = fail_key
c.time.sleep = lambda seconds: sleeps.append(seconds)
opener = Opener(); evidence = {}
if case.get("account"):
    def account_json(opener, url):
        if "/card?" in url:
            return {"code": 0, "data": {"card": {"mid": "525138167", "fans": 42}, "like_num": 91}}
        if "/navnum?" in url:
            return {"code": 0, "data": {"video": case.get("inventory", 17)}}
        raise AssertionError("Rejected list must never request video details")
    c.bili_json = account_json; c.bili_opener = lambda: opener
    result = c.collect_bilibili_account("525138167", 30)
else:
    result = c.bili_latest_videos(opener, "525138167", 30, evidence=evidence)
print(json.dumps({"result": result, "calls": calls, "sleeps": sleeps, "evidence": evidence}))
`;
function run(options) {
  const child = spawnSync("/usr/bin/python3", ["-B", "-c", fixture, collector, JSON.stringify(options)], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
for (const dynamic of [false, true]) {
  for (const options of [{ http: 401 }, { http: 403 }, { http: 429 }, { code: -352 }, { code: -101 }, { code: null }, { code: false }]) {
    test(`Bilibili actual list path stops on refusal ${JSON.stringify({ dynamic, ...options })}`, () => {
      const { result, calls, sleeps } = run({ dynamic, ...options });
      assert.deepEqual(result, []);
      assert.equal(calls.length, dynamic ? 2 : 1, "no retry or alternate works endpoint after refusal");
      assert.deepEqual(sleeps, []);
    });
  }
}
test("Bilibili transient network failure retains its existing bounded retry", () => {
  const { result, calls, sleeps } = run({ transport: true });
  assert.equal(result.length, 1); assert.equal(calls.length, 2); assert.deepEqual(sleeps, [2]);
});
test("Bilibili successful empty WBI response retains normal dynamic fallback", () => {
  const { result, calls } = run({ dynamic: true });
  assert.equal(result.length, 1); assert.equal(calls.length, 2);
});
test("Bilibili dynamic nonvideo null fields preserve the later video and raw item count", () => {
  const { result, calls, evidence } = run({ dynamic: true, mixedNonvideo: true });
  assert.deepEqual(result.map(row => row.bvid), ["BV1fi416bEpi"]);
  assert.equal(calls.length, 2); assert.equal(evidence.status, "success");
  assert.equal(evidence.listObserved, true); assert.equal(evidence.rawCount, 3);
});
test("Bilibili unclassified navigation-key failure does not try another works endpoint", () => {
  const { result, calls } = run({ keyError: true });
  assert.deepEqual(result, []); assert.deepEqual(calls, []);
});
test("Bilibili refusal preserves verified positive profile inventory and remains unavailable", async () => {
  const { result, calls } = run({ account: true, code: -352 });
  const normalized = await new PublicWebProvider({}, { execFileImpl: (_file, _args, _options, callback) =>
    callback(null, JSON.stringify({ ok: true, data: result }), "") }).collect({ id: 1, type: "account", locator: "525138167", metadata: { platform: "bilibili" } });
  assert.equal(calls.length, 1); assert.deepEqual(normalized.posts, []);
  assert.equal(normalized.snapshot.followers, 42); assert.equal(normalized.snapshot.totalPosts, 17);
  assert.equal(normalized.snapshot.totalLikes, 91); assert.equal(normalized.worksCoverage, "unavailable");
  assert.match(result.warnings.join(" "), /未用空列表覆盖历史作品/);
});
for (const options of [{ http: 403 }, { code: -352 }, { missingList: true }, { code: null }, { badElement: true }, { dynamic: true, badElement: true }, { dynamic: true, badNested: true }, { dynamic: true, http: 403 }, { dynamic: true, code: -352 }, { empty: true }]) {
  test(`Bilibili zero inventory requires successful observed empty list ${JSON.stringify(options)}`, async () => {
    const { result } = run({ account: true, inventory: 0, ...options });
    const normalized = await new PublicWebProvider({}, { execFileImpl: (_file, _args, _options, callback) =>
      callback(null, JSON.stringify({ ok: true, data: result }), "") }).collect({ id: 1, type: "account", locator: "525138167", metadata: { platform: "bilibili" } });
    assert.equal(normalized.worksCoverage, options.empty ? "complete" : "unavailable");
    assert.equal(normalized.snapshot.followers, 42); assert.equal(normalized.snapshot.totalPosts, 0);
    assert.deepEqual(normalized.posts, []);
    assert.equal(result.worksListEvidence.listObserved, Boolean(options.empty));
    assert.equal(result.worksListEvidence.status, options.empty ? "success" : (options.http || options.code === -352) ? "refused" : "unavailable");
    if (options.dynamic) assert.equal(result.worksListEvidence.source, "dynamic");
    if (options.empty) assert.doesNotMatch(result.warnings.join(" "), /列表当前受限/);
  });
}

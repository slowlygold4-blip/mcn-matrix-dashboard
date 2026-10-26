import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function pythonFixture(source) {
  const program = `import importlib.util,json,sys,datetime\nNOW=datetime.datetime(2026,9,26,7,tzinfo=datetime.timezone.utc).timestamp()\nspec=importlib.util.spec_from_file_location("collector",sys.argv[1])\nc=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)\n${source}`;
  const child = spawnSync("/usr/bin/python3", ["-B", "-c", program, fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url))], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stdout, /PRIVATE_SECRET/);
  return JSON.parse(child.stdout);
}

test("Retry-After validates seconds/date, past dates, overflow and hostile headers without retaining originals", () => {
  const rows = pythonFixture(String.raw`
values=["120","0","Sat, 26 Sep 2026 09:00:00 GMT","Fri, 25 Sep 2026 09:00:00 GMT","-1","1.5","+20","1e3","120\r\nCookie: PRIVATE_SECRET","999999999999999999999",None]
print(json.dumps([c.parse_retry_after(v,NOW) for v in values]))`);
  assert.deepEqual(rows[0], { retryAfterStatus: "valid", retryAfterSeconds: 120 });
  assert.equal(rows[1].retryAfterSeconds, 0);
  assert.equal(rows[2].retryAfterStatus, "valid");
  assert.equal(rows[2].retryAfterSeconds, 7200);
  assert.equal(rows[3].retryAfterSeconds, 0);
  for (const i of [4, 5, 6, 7, 8, 10]) assert.equal(rows[i].retryAfterStatus, "invalid");
  assert.equal(rows[9].retryAfterStatus, "too-long");
});

test("only final HTTP response wait is used; duplicates and folding are rejected", () => {
  const rows = pythonFixture(String.raw`
headers=[b"HTTP/2 429\r\nRetry-After: 120\r\nSet-Cookie: PRIVATE_SECRET\r\n\r\n",b"HTTP/2 429\r\nRetry-After: 120\r\nRetry-After: 240\r\n\r\n",b"HTTP/2 429\r\nRetry-After: 120\r\n folded\r\n\r\n",b"HTTP/2 302\r\nRetry-After: 7200\r\n\r\nHTTP/2 429\r\nRetry-After: 60\r\n\r\n"]
print(json.dumps([c.post_transport_evidence(h,429,1789286400) for h in headers]))`);
  assert.equal(rows[0].retryAfterSeconds, 120);
  assert.equal(rows[1].retryAfterStatus, "invalid");
  assert.equal(rows[2].retryAfterStatus, "invalid");
  assert.equal(rows[3].retryAfterSeconds, 60);
});

test("all three RFC HTTP-date forms are accepted, but invalid calendar or weekday values are not", () => {
  const rows = pythonFixture(String.raw`
values=["Sat, 26 Sep 2026 09:00:00 GMT","Saturday, 26-Sep-26 09:00:00 GMT","Sat Sep 26 09:00:00 2026","Sun, 26 Sep 2026 09:00:00 GMT","Sat, 31 Feb 2026 09:00:00 GMT","2026-09-26T09:00:00Z"]
print(json.dumps([c.parse_retry_after(v,NOW) for v in values]))`);
  for (const row of rows.slice(0, 3)) assert.equal(row.retryAfterSeconds, 7200);
  for (const row of rows.slice(3)) assert.equal(row.retryAfterStatus, "invalid");
});

test("profile-only deferred mode never requests or signs works, including a zero-works profile", () => {
  const result = pythonFixture(String.raw`
uid="MS4wLjABAAAApolicyOfflineFixture"
c.extract_sec_uid=lambda _:uid
c.register_guest=lambda:"PRIVATE_SECRET"
c.fetch_public_profile=lambda *_:({"user":{"sec_uid":uid,"nickname":"fixture","follower_count":12,"total_favorited":34,"aweme_count":0}},"fixture-profile")
def forbidden(*a,**k):raise AssertionError("Works/network forbidden")
c.request_json=forbidden;c.request=forbidden;c.a_bogus_signed_url=forbidden
print(json.dumps(c.collect_account(uid,30,works_mode="deferred")))`);
  assert.equal(result.worksCoverage, "unavailable");
  assert.equal(result.worksErrorCode, "deferred");
  assert.equal(result.profile.user.follower_count, 12);
  assert.equal(result.works.aweme_list, undefined);
  assert.equal(result.works.pagination.requestCount, 0);
});

test("typed transport failures win over misleading human-readable text", () => {
  const result = pythonFixture(String.raw`
print(json.dumps([c.classify_works_error(c.CollectorError("HTTP 403 misleading",code=code)) for code in ["login_required","rate_limited","business_error","network_error"]]))`);
  assert.deepEqual(result, ["login_required", "rate_limited", "business_error", "network_error"]);
});

test("real mocked HTTP failures preserve the fresh profile and sanitized wait/error evidence", () => {
  const result = pythonFixture(String.raw`
from types import SimpleNamespace
uid="MS4wLjABAAAApolicyOfflineFixture"
c.extract_sec_uid=lambda _:uid
c.register_guest=lambda:"PRIVATE_SECRET"
c.fetch_public_profile=lambda *_:({"user":{"sec_uid":uid,"nickname":"fixture","follower_count":12,"total_favorited":34,"aweme_count":5}},"fixture-profile")
c.a_bogus_signed_url=lambda endpoint,_:endpoint
out=[]
for status in [401,403,429,503]:
    c.subprocess.run=lambda *_a,**_k:SimpleNamespace(returncode=0,stdout=("PRIVATE_SECRET\\n__CODEX_HTTP_META__%s\\thttps://www.douyin.com/aweme/v1/web/aweme/post/"%status).replace("\\n","\n").replace("\\t","\t").encode(),stderr=("HTTP/2 %s\r\nRetry-After: 7200\r\nSet-Cookie: PRIVATE_SECRET\r\n\r\n"%status).encode())
    out.append(c.collect_account(uid,30))
print(json.dumps(out))`);
  assert.deepEqual(result.map((row) => row.worksErrorCode), ["login_required", "blocked", "rate_limited", "network_error"]);
  for (const row of result) {
    assert.equal(row.profile.user.follower_count, 12);
    assert.equal(row.worksCoverage, "unavailable");
    assert.equal(row.works.pagination.pages[0].transport.retryAfterSeconds, 7200);
  }
});

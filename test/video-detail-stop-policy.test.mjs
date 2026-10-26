import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const collector = fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url));
const VIDEO = "7678272839845855921";
const python = (code, data = {}) => {
  const source = `import importlib.util,json,sys,subprocess,types\nspec=importlib.util.spec_from_file_location("c",sys.argv[1]);c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)\nfixture=json.loads(sys.argv[2])\n${code}`;
  const child = spawnSync("/usr/bin/python3", ["-B", "-c", source, collector, JSON.stringify(data)], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
};
const safe = (value) => assert.doesNotMatch(JSON.stringify(value), /PRIVATE_TEST_SECRET|signature=|cookie=|status_msg/);
const success = { status_code: 0, aweme_detail: { aweme_id: VIDEO, author: { sec_uid: "MS4wLjABAAAAabcdefghijklmnopqrstuvwx" } } };
function transport(sequence) {
  return python(String.raw`
calls=[]
responses=iter(fixture["sequence"])
c.a_bogus_signed_url=lambda endpoint,params:endpoint+"?aweme_id="+params["aweme_id"]+"&signature=PRIVATE_TEST_SECRET"
def fake_run(args,**kwargs):
    calls.append({"signed": "signature=" in args[-1], "headersCaptured": "-D" in args})
    row=next(responses)
    if row.get("timeout"): raise subprocess.TimeoutExpired("PRIVATE_TEST_SECRET",1)
    if row.get("curlError"):
        return types.SimpleNamespace(returncode=28,stdout=b"",stderr=b"cookie=PRIVATE_TEST_SECRET")
    status=row.get("status",200)
    body=row.get("text")
    if body is None: body=json.dumps(row.get("body"))
    output=body.encode()+b"\n__CODEX_HTTP_META__"+str(status).encode()+b"\thttps://www.douyin.com/aweme/v1/web/aweme/detail/"
    return types.SimpleNamespace(returncode=row.get("returncode",0),stdout=output,stderr=("HTTP/2 %s\r\nContent-Type: application/json\r\nSet-Cookie: PRIVATE_TEST_SECRET\r\n\r\n"%status).encode())
c.subprocess.run=fake_run
try:
    value,mode=c.fetch_public_video_detail(fixture["video"],"private-memory-cookie")
    result={"ok":True,"value":value,"mode":mode}
except c.CollectorError as error:
    result={"ok":False,"error":str(error),"code":error.code,"suppressedContext":error.__suppress_context__}
result["calls"]=calls
print(json.dumps(result))
`, { sequence, video: VIDEO });
}

test("video details stop after the first HTTP 401, 403 or 429 and suppress secret body text", () => {
  for (const [status, code] of [[401, "login_required"], [403, "blocked"], [429, "rate_limited"]]) {
    const result = transport([{ status, text: "cookie=PRIVATE_TEST_SECRET" }, { body: success }]);
    assert.equal(result.ok, false); assert.equal(result.calls.length, 1); assert.equal(result.code, code);
    assert.equal(result.calls[0].headersCaptured, true); safe(result);
  }
});

test("explicit business rejection including 2483 stops without inventing login-expiry attribution", () => {
  for (const status_code of [2483, 8, 403, "0"]) {
    const result = transport([{ body: { status_code, status_msg: "PRIVATE_TEST_SECRET" } }, { body: success }]);
    assert.equal(result.ok, false); assert.equal(result.calls.length, 1); assert.equal(result.code, "business_error"); safe(result);
  }
});

test("an observed HTTP refusal wins over a simultaneous curl transport failure", () => {
  for (const [status, code] of [[401, "login_required"], [403, "blocked"], [429, "rate_limited"], [400, "business_error"]]) {
    const result = transport([{ status, returncode: 28, text: "PRIVATE_TEST_SECRET" }, { body: success }]);
    assert.equal(result.ok, false); assert.equal(result.calls.length, 1); assert.equal(result.code, code); safe(result);
  }
});

test("HTML login or captcha, empty or invalid JSON and unknown failures cannot trigger alternate requests", () => {
  for (const row of [{ text: "<html>login captcha PRIVATE_TEST_SECRET</html>" }, { text: "" }, { body: [] }, { text: "invalid PRIVATE_TEST_SECRET" }]) {
    const result = transport([row, { body: success }]);
    assert.equal(result.ok, false); assert.equal(result.calls.length, 1); safe(result);
  }
});

test("only a classified transient transport failure retains one bounded legacy fallback", () => {
  for (const row of [{ status: 503, text: "PRIVATE_TEST_SECRET" }, { timeout: true }, { curlError: true }]) {
    const result = transport([row, { body: success }]);
    assert.equal(result.ok, true); assert.equal(result.calls.length, 2);
    assert.deepEqual(result.calls.map((call) => call.signed), [true, false]);
    assert.equal(result.mode, "guest-ttwid-unsigned-video-detail-fallback"); assert.deepEqual(result.value, success); safe(result);
  }
});

test("fallback rejection ends at two requests and sanitizes the second failure", () => {
  const result = transport([{ status: 503, text: "PRIVATE_TEST_SECRET" }, { status: 403, text: "PRIVATE_TEST_SECRET" }, { body: success }]);
  assert.equal(result.ok, false); assert.equal(result.calls.length, 2); assert.equal(result.code, "blocked"); safe(result);
});

test("successful signed identity evidence is preserved unchanged without a fallback", () => {
  const result = transport([{ body: success }]);
  assert.equal(result.ok, true); assert.equal(result.calls.length, 1); assert.deepEqual(result.value, success);
  assert.equal(result.mode, "guest-ttwid-a-bogus-video-detail");
});

test("detail opt-in requires explicit integer business success rather than null, false or float zero", () => {
  for (const row of [{ body: { aweme_detail: success.aweme_detail } }, { body: { ...success, status_code: null } },
    { body: { ...success, status_code: false } }, { text: JSON.stringify(success).replace('"status_code":0', '"status_code":0.0') }]) {
    const result = transport([row, { body: success }]);
    assert.equal(result.ok, false); assert.equal(result.calls.length, 1); assert.equal(result.code, "upstream_changed"); safe(result);
  }
});

test("explicit login and challenge flags stop on status zero without treating module presence as expiry", () => {
  for (const field of ["need_login", "login_required", "captcha_required", "verify_required"]) {
    for (const value of [true, 1, "PRIVATE_TEST_SECRET", [], {}]) {
      const result = transport([{ body: { ...success, [field]: value } }, { body: success }]);
      assert.equal(result.ok, false); assert.equal(result.calls.length, 1); assert.equal(result.code, "business_error"); safe(result);
    }
  }
  const permitted = transport([{ body: { ...success, need_login: false, login_required: 0, captcha_required: null,
    verify_required: "", not_login_module: { marker: "normal-public-module" } } }]);
  assert.equal(permitted.ok, true); assert.equal(permitted.calls.length, 1);
});

test("both detail consumers reject a missing/non-integer status or malformed detail from an injected reader", () => {
  const result = python(String.raw`
c.register_guest=lambda:"memory-only"
c.a_bogus_signed_url=lambda *_:"https://fixture.invalid/"
out=[]
cases=[{"aweme_detail":{}},{"status_code":None,"aweme_detail":{}},{"status_code":False,"aweme_detail":{}},{"status_code":0.0,"aweme_detail":{}},{"status_code":"0","aweme_detail":{}},{"status_code":0,"aweme_detail":[]},{"status_code":0,"aweme_detail":"PRIVATE_TEST_SECRET"}]
for payload in cases:
    c.request_json=lambda *_a,**_k:payload
    row=[]
    for collect in [lambda:c.resolve_video_author(fixture["video"],"memory-only"),lambda:c.collect_identity_work(fixture["video"])]:
        try: collect();row.append(True)
        except c.CollectorError: row.append(False)
    out.append(row)
print(json.dumps(out))
`, { video: VIDEO });
  assert.deepEqual(result, Array.from({ length: 7 }, () => [false, false]));
});

test("unknown CollectorErrors cannot be retried or leak signed URLs, even without structured transport metadata", () => {
  const result = python(String.raw`
calls=[]
c.a_bogus_signed_url=lambda *_:"https://fixture.invalid/"
def fail(*_a,**_k):
    calls.append(1)
    raise c.CollectorError("captcha PRIVATE_TEST_SECRET signature=hidden")
c.request_json=fail
try: c.fetch_public_video_detail(fixture["video"],"memory-only")
except c.CollectorError as error: print(json.dumps({"count":len(calls),"error":str(error),"code":error.code}))
`, { video: VIDEO });
  assert.equal(result.count, 1); assert.equal(result.code, "unknown"); safe(result);
});

test("outer video-author retry loop never rotates a guest or repeats after explicit refusal", () => {
  const results = python(String.raw`
c.time.sleep=lambda *_:None
out=[]
for code in ["blocked","login_required","rate_limited","business_error","upstream_changed",None]:
    calls=[]; guests=[]
    def fail(*_args):
        calls.append(1)
        raise c.CollectorError("fixed-safe-error",code=code)
    c.resolve_video_author=fail
    c.register_guest=lambda:guests.append(1) or "guest"
    result=c.resolve_author_item({"key":"fixture","videoIds":[fixture["video"]]},"existing",3)
    out.append({"code":code,"calls":len(calls),"guests":len(guests),"candidateCount":len(result["candidates"])})
print(json.dumps(out))
`, { video: VIDEO });
  for (const result of results) { assert.equal(result.calls, 1); assert.equal(result.guests, 0); assert.equal(result.candidateCount, 0); }
});

test("ordinary transient video-author errors keep the original finite retry maximum", () => {
  const results = python(String.raw`
c.time.sleep=lambda *_:None
out=[]
for retries in [1,3,99]:
    calls=[]; guests=[]
    def fail(*_args):
        calls.append(1)
        raise c.CollectorError("safe transport failure",code="network_error")
    c.resolve_video_author=fail
    c.register_guest=lambda:guests.append(1) or "guest"
    c.resolve_author_item({"key":"fixture","videoIds":[fixture["video"]]},"existing",retries)
    out.append({"calls":len(calls),"guests":len(guests)})
print(json.dumps(out))
`, { video: VIDEO });
  assert.deepEqual(results, [{ calls: 1, guests: 0 }, { calls: 3, guests: 2 }, { calls: 4, guests: 3 }]);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyQueuedAuthorEvidence } from "../lib/author-resolution.mjs";

const COLLECTOR_PATH = fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url));
const SEC_A = "MS4wLjABAAAAshareResolverAuthorAAAAAAAA";
const SEC_B = "MS4wLjABAAAAshareResolverAuthorBBBBBBBB";
const VIDEO_A = "7684603502224910331";
const VIDEO_B = "7684601076515477690";
const SHARE_A = "https://v.douyin.com/ShareAa/";
const SHARE_B = "https://v.douyin.com/ShareBb/";

function runPython(body, payload) {
  const script = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("douyin_public_collector", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(sys.argv[2])
` + body;
  const child = spawnSync("/usr/bin/python3", ["-c", script, COLLECTOR_PATH, JSON.stringify(payload)], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message || child.stdout);
  return JSON.parse(child.stdout);
}

function queuedItem(videoIds = [], shareUrls = []) {
  return {
    key: `douyin:account:${SEC_A}`,
    platform: "douyin",
    accountLocator: SEC_A,
    name: "严格短链作者",
    videoIds,
    shareUrls,
    sourceRows: [2],
  };
}

function resolveFixture(item, { destinations = {}, owners = {} } = {}) {
  return runPython(String.raw`
detail_calls = []
redirect_calls = []

def resolve_detail(video_id, cookie):
    detail_calls.append(video_id)
    return {
        "videoId": video_id,
        "secUid": payload["owners"].get(video_id, payload["secUid"]),
        "nickname": "严格短链作者",
        "uniqueId": "",
        "shortId": "",
        "uid": "",
        "provenance": "public-video-detail",
    }

def redirect(url):
    redirect_calls.append(str(url))
    destination = payload["destinations"].get(str(url))
    if destination is None:
        raise module.CollectorError("fixture: official short link temporarily unavailable")
    return (302, destination)

module.resolve_video_author = resolve_detail
module.official_share_redirect = redirect
module.register_guest = lambda: "fixture-anonymous-cookie"
module.time.sleep = lambda *_args: None
result = module.resolve_author_item(payload["item"], "", 1)
print(json.dumps({"result": result, "detailCalls": detail_calls, "redirectCalls": redirect_calls}))
`, { item, destinations, owners, secUid: SEC_A });
}

test("signed resolver verifies both an explicit video ID and its actual short link, fetching detail once", () => {
  const item = queuedItem([VIDEO_A], [SHARE_A]);
  const { result, detailCalls } = resolveFixture(item, {
    destinations: { [SHARE_A]: `https://www.douyin.com/video/${VIDEO_A}` },
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(detailCalls, [VIDEO_A]);
  assert.ok(result.candidates.some((candidate) => candidate.videoId === VIDEO_A && candidate.sourceEvidenceUrl === SHARE_A));
  const verified = verifyQueuedAuthorEvidence(item, result);
  assert.equal(verified.status, "ready", verified.reason);
  assert.equal(verified.row.resolution.verifiedEvidenceCount, 2);
});

test("signed resolver accepts a share-only author after expanding the official video destination", () => {
  const item = queuedItem([], [SHARE_A]);
  const { result, detailCalls } = resolveFixture(item, {
    destinations: { [SHARE_A]: `https://www.iesdouyin.com/share/video/${VIDEO_A}/` },
  });
  assert.deepEqual(detailCalls, [VIDEO_A]);
  assert.equal(result.candidates[0].sourceEvidenceUrl, SHARE_A);
  assert.equal(verifyQueuedAuthorEvidence(item, result).status, "ready");
});

test("all distinct case-sensitive share proofs survive when five links resolve to one cached video", () => {
  const shares = ["CaseAa", "Caseaa", "CaseBb", "CaseCc", "CaseDd"].map((path) => `https://v.douyin.com/${path}/`);
  const item = queuedItem([VIDEO_A], shares);
  const { result, detailCalls } = resolveFixture(item, {
    destinations: Object.fromEntries(shares.map((share) => [share, `https://www.douyin.com/video/${VIDEO_A}`])),
  });
  assert.deepEqual(detailCalls, [VIDEO_A]);
  assert.deepEqual(new Set(result.candidates.map((candidate) => candidate.sourceEvidenceUrl).filter(Boolean)), new Set(shares));
  const verified = verifyQueuedAuthorEvidence(item, result);
  assert.equal(verified.status, "ready", verified.reason);
  assert.equal(verified.row.resolution.verifiedEvidenceCount, 6);
});

test("a short link resolving to another author cannot borrow the directly submitted video's identity", () => {
  const item = queuedItem([VIDEO_A], [SHARE_A]);
  const { result } = resolveFixture(item, {
    destinations: { [SHARE_A]: `https://www.douyin.com/video/${VIDEO_B}` },
    owners: { [VIDEO_B]: SEC_B },
  });
  assert.ok(result.candidates.some((candidate) => candidate.videoId === VIDEO_B && candidate.secUid === SEC_B && candidate.sourceEvidenceUrl === SHARE_A));
  assert.equal(result.candidates.some((candidate) => candidate.videoId === VIDEO_A && candidate.sourceEvidenceUrl === SHARE_A), false);
  assert.equal(verifyQueuedAuthorEvidence(item, result).status, "rejected");
});

test("a user-supplied video query cannot bypass actual short-link expansion or forge its owner", () => {
  const untrustedHint = `${SHARE_A}?aweme_id=${VIDEO_A}`;
  const item = queuedItem([VIDEO_A], [untrustedHint]);
  const { result, redirectCalls } = resolveFixture(item, {
    destinations: { [untrustedHint]: `https://www.douyin.com/video/${VIDEO_B}` },
    owners: { [VIDEO_B]: SEC_B },
  });
  assert.deepEqual(redirectCalls, [untrustedHint]);
  assert.ok(result.candidates.some((candidate) => candidate.videoId === VIDEO_B && candidate.sourceEvidenceUrl === untrustedHint));
  assert.equal(result.candidates.some((candidate) => candidate.videoId === VIDEO_A && candidate.sourceEvidenceUrl === untrustedHint), false);
  assert.equal(verifyQueuedAuthorEvidence(item, result).status, "rejected");
});

test("one unavailable share remains a retry with its original URL, without contaminating successful proof", () => {
  const item = queuedItem([VIDEO_A], [SHARE_A, SHARE_B]);
  const { result } = resolveFixture(item, {
    destinations: { [SHARE_A]: `https://www.douyin.com/video/${VIDEO_A}` },
  });
  assert.ok(result.errors.some((error) => error.shareUrl === SHARE_B));
  assert.equal(result.candidates.some((candidate) => candidate.sourceEvidenceUrl === SHARE_B), false);
  assert.ok(result.candidates.some((candidate) => candidate.sourceEvidenceUrl === SHARE_A));
  assert.equal(verifyQueuedAuthorEvidence(item, result).status, "retry");
});

test("short-link URL validation refuses external hosts, credentials, HTTP and nonstandard ports", () => {
  const invalidUrls = [
    "https://example.com/video/7684603502224910331",
    "https://v.douyin.com.evil.example/ShareAa/",
    "https://user:password@v.douyin.com/ShareAa/",
    "http://v.douyin.com/ShareAa/",
    "https://v.douyin.com:444/ShareAa/",
    "https://127.0.0.1/ShareAa/",
  ];
  const result = runPython(String.raw`
output = []
for url in payload:
    try:
        module.validated_douyin_url(url)
        output.append({"url": url, "accepted": True})
    except (module.CollectorError, ValueError):
        output.append({"url": url, "accepted": False})
print(json.dumps(output))
`, invalidUrls);
  assert.deepEqual(result.map((row) => row.accepted), invalidUrls.map(() => false));
});

test("profile share resolution validates every redirect hop and never accepts an external user path", () => {
  const result = runPython(String.raw`
def redirect(url):
    destination = payload["destinations"].get(str(url))
    if destination is None:
        raise module.CollectorError("fixture: redirect unavailable")
    return (302, destination)

module.official_share_redirect = redirect
output = []
for raw in payload["inputs"]:
    try:
        output.append({"input": raw, "accepted": True, "secUid": module.extract_sec_uid(raw)})
    except module.CollectorError as exc:
        output.append({"input": raw, "accepted": False, "error": str(exc)})
print(json.dumps(output))
`, {
    inputs: [
      `https://www.douyin.com/user/${SEC_A}`,
      SHARE_A,
      "https://example.com/user/" + SEC_A,
      "http://127.0.0.1/user/" + SEC_A,
      SHARE_B,
    ],
    destinations: {
      [SHARE_A]: `https://www.douyin.com/user/${SEC_A}`,
      [SHARE_B]: SHARE_A,
    },
  });
  assert.deepEqual(result.slice(0, 2).map((row) => row.secUid), [SEC_A, SEC_A]);
  assert.deepEqual(result.slice(2).map((row) => row.accepted), [false, false, true]);
});

test("profile share resolution bounds redirect cycles", () => {
  const result = runPython(String.raw`
module.official_share_redirect = lambda url: (302, payload["destinations"][str(url)])
try:
    module.extract_sec_uid(payload["start"])
    print(json.dumps({"accepted": True}))
except module.CollectorError as exc:
    print(json.dumps({"accepted": False, "error": str(exc)}))
`, { start: SHARE_A, destinations: { [SHARE_A]: SHARE_B, [SHARE_B]: SHARE_A } });
  assert.equal(result.accepted, false);
  assert.match(result.error, /循环跳转|超过 8 次/);
});

test("an official short link cannot redirect a request to an external or local destination", () => {
  for (const destination of ["https://example.com/video/7684603502224910331", "http://127.0.0.1/private"]) {
    const { result, redirectCalls, detailCalls } = resolveFixture(queuedItem([], [SHARE_A]), {
      destinations: { [SHARE_A]: destination },
    });
    assert.deepEqual(redirectCalls, [SHARE_A]);
    assert.deepEqual(detailCalls, []);
    assert.deepEqual(result.candidates, []);
    assert.ok(result.errors.some((error) => error.shareUrl === SHARE_A));
  }
});

test("cyclic official redirects terminate within the fixed hop budget", () => {
  const { result, redirectCalls, detailCalls } = resolveFixture(queuedItem([], [SHARE_A]), {
    destinations: { [SHARE_A]: SHARE_B, [SHARE_B]: SHARE_A },
  });
  assert.ok(redirectCalls.length > 0 && redirectCalls.length <= 9);
  assert.deepEqual(detailCalls, []);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.errors.some((error) => error.shareUrl === SHARE_A));
});

test("public detail must echo the exact video ID and a valid author sec_uid before producing evidence", () => {
  const result = runPython(String.raw`
module.a_bogus_signed_url = lambda base, params: base
output = []
for case in payload["cases"]:
    module.request_json = lambda *_args, **_kwargs: case
    try:
        candidate = module.resolve_video_author(payload["videoId"], "")
        output.append({"accepted": True, "candidate": candidate})
    except module.CollectorError as exc:
        output.append({"accepted": False, "error": str(exc)})
print(json.dumps(output))
`, {
    videoId: VIDEO_A,
    cases: [
      { status_code: 0, aweme_detail: { aweme_id: VIDEO_B, author: { sec_uid: SEC_A } } },
      { status_code: 0, aweme_detail: { author: { sec_uid: SEC_A } } },
      { status_code: 0, aweme_detail: { aweme_id: VIDEO_A, author: { nickname: "严格短链作者" } } },
      { status_code: 0, aweme_detail: { aweme_id: VIDEO_A, author: { sec_uid: "not-a-sec-uid" } } },
      { status_code: 0, aweme_detail: { aweme_id: VIDEO_A, author: { sec_uid: SEC_A, nickname: "严格短链作者" } } },
    ],
  });
  assert.deepEqual(result.map((row) => row.accepted), [false, false, false, false, true]);
  assert.equal(result[4].candidate.videoId, VIDEO_A);
  assert.equal(result[4].candidate.secUid, SEC_A);
});

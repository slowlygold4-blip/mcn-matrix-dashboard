import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalEvidenceFromUrl,
  decideStrictMatch,
  expandOfficialShortUrl,
} from "../scripts/probes/identity-resolution-probe.mjs";

test("canonical evidence parser recognizes official account and content URLs", () => {
  const secUid = "MS4wLjABAAAA_TEST_CANONICAL_123456";
  assert.deepEqual(canonicalEvidenceFromUrl(`https://www.douyin.com/user/${secUid}?from_tab_name=main`), {
    platform: "douyin", kind: "account", canonicalId: secUid, canonicalUrl: `https://www.douyin.com/user/${secUid}`,
  });
  assert.equal(canonicalEvidenceFromUrl("https://www.douyin.com/video/7525538910311632128").canonicalId, "7525538910311632128");
  assert.equal(canonicalEvidenceFromUrl("https://space.bilibili.com/1809444890/video").canonicalId, "1809444890");
  assert.equal(canonicalEvidenceFromUrl("https://www.bilibili.com/video/BV1fi416bEpi").canonicalId, "BV1fi416bEpi");
  assert.equal(canonicalEvidenceFromUrl("https://www.xiaohongshu.com/user/profile/619e0b66000000001000e923").canonicalId, "619e0b66000000001000e923");
  assert.equal(canonicalEvidenceFromUrl("https://www.xiaohongshu.com/explore/68e66fef0000000004023fdb").kind, "content");
});

test("short-link expansion follows only same-platform official HTTPS hops", async () => {
  const responses = new Map([
    ["https://v.douyin.com/abc", { status: 302, location: "https://www.iesdouyin.com/share/video/7525538910311632128/" }],
    ["https://www.iesdouyin.com/share/video/7525538910311632128/", { status: 302, location: "https://www.douyin.com/video/7525538910311632128" }],
    ["https://www.douyin.com/video/7525538910311632128", { status: 200, location: null }],
  ]);
  const fetchImpl = async (url) => {
    const row = responses.get(String(url));
    assert.ok(row, `unexpected URL ${url}`);
    return { status: row.status, headers: new Headers(row.location ? { location: row.location } : {}) };
  };
  const result = await expandOfficialShortUrl("https://v.douyin.com/abc", { fetchImpl });
  assert.equal(result.canonical.kind, "content");
  assert.equal(result.canonical.canonicalId, "7525538910311632128");
  assert.equal(result.chain.length, 3);
  assert.equal(result.persistentCookiesRead, false);
});

test("short-link expansion rejects cross-platform redirects", async () => {
  const fetchImpl = async () => ({ status: 302, headers: new Headers({ location: "https://space.bilibili.com/12345" }) });
  await assert.rejects(() => expandOfficialShortUrl("https://v.douyin.com/abc", { fetchImpl }), /跨平台/);
});

test("official URL parsing rejects embedded credentials", () => {
  assert.throws(() => canonicalEvidenceFromUrl("https://user:pass@www.douyin.com/video/7525538910311632128"), /不得包含 URL 凭据/);
});

test("strict ID matching resolves exactly one canonical account", () => {
  const candidates = [
    { canonicalId: "SEC-1", uniqueId: "Author_ID", nickname: "同名" },
    { canonicalId: "SEC-2", uniqueId: "different", nickname: "同名" },
  ];
  const decision = decideStrictMatch({ platform: "douyin", queryKind: "id", query: "@author_id", candidates });
  assert.equal(decision.status, "resolved");
  assert.equal(decision.matches[0].canonicalId, "SEC-1");
});

test("nickname-only search never auto-resolves even with one exact result", () => {
  const decision = decideStrictMatch({
    platform: "douyin", queryKind: "name", query: "测试作者",
    candidates: [{ canonicalId: "SEC-1", nickname: "测试作者" }],
  });
  assert.equal(decision.status, "candidate-only");
  assert.match(decision.reason, /不是平台唯一键/);
});

test("ambiguous ID hits fail closed", () => {
  const decision = decideStrictMatch({
    platform: "douyin", queryKind: "id", query: "same-id",
    candidates: [
      { canonicalId: "SEC-1", uniqueId: "same-id" },
      { canonicalId: "SEC-2", shortId: "same-id" },
    ],
  });
  assert.equal(decision.status, "unresolved");
  assert.match(decision.reason, /多个 canonical/);
});

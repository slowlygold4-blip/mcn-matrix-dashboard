import test from "node:test";
import assert from "node:assert/strict";
import { repairDouyinShareLink } from "../lib/douyin-share-link-repair.mjs";
import { parseAuthorSpreadsheet } from "../lib/author-spreadsheet.mjs";
import { verifyQueuedAuthorEvidence } from "../lib/author-resolution.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";

const url = "https://v.douyin.com/ByEl0nCN868/";
const damaged = "https://v.douyin.com/ByEl0nCN868](https://v.douyin.com/ByEl0nCN868/https://v.douyin.com/ByEl0nCN868/";
const secUid = "MS4wLjABAAAAiUHmRpLewwQ8Ycvp2rhaL4q-E4Gu_Ssf79r_USBq9tY";

test("repairs the observed broken Markdown while preserving its exact source", () => {
  const originalValue = "https://v.douyin.com/ByEl0nCN868](https://v.douyin.com/ByEl0nCN868/https://v.douyin.com/ByEl0nCN868/";
  assert.deepEqual(repairDouyinShareLink(originalValue), {
    original: originalValue,
    normalizedUrl: url,
    reason: "repeated-identical-douyin-share-markdown",
    occurrences: 3,
    identityVerified: false,
  });
});

test("accepts repeated identical balanced Markdown and optional trailing slash", () => {
  for (const originalValue of [
    `[${url}](${url})`,
    `  [https://v.douyin.com/ByEl0nCN868](${url})\n`,
    `[${url}](${url}${url})`,
  ]) {
    const result = repairDouyinShareLink(originalValue);
    assert.equal(result?.normalizedUrl, url);
    assert.equal(result?.original, originalValue);
    assert.equal(result?.identityVerified, false);
  }
});

test("never chooses between distinct or case-different opaque short codes", () => {
  for (const other of ["OtherValid12", "ByEl0NCN868", "ByEl0nCN868_"]) {
    assert.equal(repairDouyinShareLink(`[${url}](https://v.douyin.com/${other}/)`), null);
  }
});

test("does not truncate extra path components, query strings, fragments or escapes", () => {
  for (const suffix of ["165", "extra/", "/", "?a=1", "#x", "%2F", "%5D", "../", "./"]) {
    assert.equal(repairDouyinShareLink(`[${url}](${url}${suffix})`), null, suffix);
  }
  assert.equal(repairDouyinShareLink("https://v.douyin.com/_AICAiW0eZo/165"), null);
});

test("rejects untrusted host, credentials, ports and non-HTTPS candidates", () => {
  for (const candidate of [
    "http://v.douyin.com/ByEl0nCN868/",
    "https://v.douyin.com.evil.test/ByEl0nCN868/",
    "https://v.douyin.com@evil.test/ByEl0nCN868/",
    "https://evil.test@v.douyin.com/ByEl0nCN868/",
    "https://v.douyin.com:443/ByEl0nCN868/",
    "https://www.douyin.com/ByEl0nCN868/",
    "https://v.douyin.com\\@evil.test/ByEl0nCN868/",
  ]) assert.equal(repairDouyinShareLink(`[${url}](${candidate})`), null, candidate);
});

test("leaves ordinary URLs, captions, mixed platforms and arbitrary text to the normal parser", () => {
  for (const value of [
    url, `[${url}]`, `${url}${url}`, `作品[${url}](${url})`,
    `[查看作品](${url})`, `[${url}](https://b23.tv/abcd/)`,
    `[${url}](${url}) suffix`, `[${url}](${url})\0`,
  ]) assert.equal(repairDouyinShareLink(value), null, value);
});

test("bounds work and rejects non-string input without coercion", () => {
  for (const value of [null, undefined, 123, {}, [], "", "()", ` [${url}](${url})${" ".repeat(1_001)}`]) {
    assert.equal(repairDouyinShareLink(value), null);
  }
});

test("calls are independent after failed sticky-regex matches", () => {
  assert.equal(repairDouyinShareLink(`[${url}](invalid)`), null);
  assert.equal(repairDouyinShareLink(`[${url}](${url})`)?.normalizedUrl, url);
});

test("spreadsheet parsing preserves the source cell and repairs only its extracted request URL", async () => {
  const preview = await parseAuthorSpreadsheet({
    fileName: "broken-markdown.csv",
    buffer: Buffer.from(`作者,抖音号,视频链接\n测试作者,65079367972,${damaged}`),
  });
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].videoLink, damaged);
  assert.equal(preview.rows[0].shareUrl, url);
  assert.equal(preview.rows[0].douyinId, "65079367972");
  assert.equal(preview.rows[0].status, "resolvable", "repair is not verified ownership");
});

test("queued evidence can match repaired request echoes but still requires the correct public ID", () => {
  const item = { key: "legacy-key-with-original-evidence", platform: "douyin", douyinId: "65079367972", videoIds: [], shareUrls: [damaged], sourceRows: [1879] };
  const before = structuredClone(item);
  const candidate = { videoId: "7689084583479936369", secUid, uniqueId: "65079367972", nickname: "测试作者", sourceEvidenceUrl: url };
  const accepted = verifyQueuedAuthorEvidence(item, { candidates: [candidate], errors: [] });
  assert.equal(accepted.status, "ready");
  assert.equal(accepted.row.locator, secUid);
  assert.equal(accepted.row.resolution.verificationPolicy, "all-submitted-evidence-v2");
  assert.deepEqual(item, before, "the original queue evidence stays unchanged");
  for (const altered of [
    { ...candidate, uniqueId: "different-account" },
    { ...candidate, sourceEvidenceUrl: "https://v.douyin.com/OtherValid12/" },
    { ...candidate, secUid: "" },
  ]) assert.notEqual(verifyQueuedAuthorEvidence(item, { candidates: [altered], errors: [] }).status, "ready");
  assert.notEqual(verifyQueuedAuthorEvidence(item, { candidates: [], errors: [] }).status, "ready");
});

test("provider repairs only transport input, preserving request keys and original evidence objects", async () => {
  const item = { key: `share:${damaged}`, platform: "douyin", douyinId: "65079367972", videoIds: [], shareUrls: [damaged, "https://v.douyin.com/_AICAiW0eZo/165"] };
  const before = structuredClone(item);
  const provider = new PublicWebProvider({}, { authorResolverMode: "signed-only" });
  let transported = null;
  provider.run = async (operation, _args, input) => {
    assert.equal(operation, "resolve-authors");
    transported = JSON.parse(input).items;
    return { items: transported.map(({ key }) => ({ key, candidates: [], errors: [] })) };
  };
  const response = await provider.resolveDouyinAuthors([item]);
  assert.equal(transported?.[0]?.key, item.key);
  assert.deepEqual(transported?.[0]?.shareUrls, [url, "https://v.douyin.com/_AICAiW0eZo/165"]);
  assert.deepEqual(item, before);
  assert.equal(response.items[0].key, item.key);
});

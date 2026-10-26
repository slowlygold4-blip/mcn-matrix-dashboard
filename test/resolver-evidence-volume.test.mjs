import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyQueuedAuthorEvidence } from "../lib/author-resolution.mjs";
import { normalizeAuthorResolverItems } from "../scripts/douyin_browser_resolver.mjs";

const SEC_UID = "MS4wLjABAAAAvolumeEvidenceAuthor123456789";
const VIDEO_IDS = [1, 2, 3, 4, 5].map((number) => `7679000000000000${number}01`);
const SHARE_URLS = ["Aa", "Bb", "Cc", "Dd", "Ee"].map((suffix) => `https://v.douyin.com/Volume${suffix}/`);

test("browser and signed resolvers retain and verify every proof beyond the former three-item cap", () => {
  const browserItems = normalizeAuthorResolverItems({
    items: [{ key: `douyin:account:${SEC_UID}`, videoIds: VIDEO_IDS, shareUrls: SHARE_URLS }],
  });
  assert.deepEqual(browserItems[0].videoIds, VIDEO_IDS);
  assert.deepEqual(browserItems[0].shareUrls, SHARE_URLS);

  const collectorPath = fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url));
  const python = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("douyin_public_collector", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
video_ids = json.loads(sys.argv[2])
module.resolve_video_author = lambda video_id, _cookie: {
    "videoId": video_id,
    "secUid": sys.argv[3],
    "nickname": "批量证据作者",
    "uniqueId": "",
    "shortId": "",
    "uid": "",
    "provenance": "public-video-detail",
}
print(json.dumps(module.resolve_author_item({"key": "volume", "videoIds": video_ids}, "", 1)))
`;
  const child = spawnSync("/usr/bin/python3", ["-c", python, collectorPath, JSON.stringify(VIDEO_IDS), SEC_UID], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const signedResult = JSON.parse(child.stdout);
  assert.equal(signedResult.candidates.length, VIDEO_IDS.length);

  const verified = verifyQueuedAuthorEvidence({
    key: `douyin:account:${SEC_UID}`,
    platform: "douyin",
    accountLocator: SEC_UID,
    videoIds: VIDEO_IDS,
    shareUrls: [],
    sourceRows: [2, 3, 4, 5, 6],
  }, signedResult);
  assert.equal(verified.status, "ready");
  assert.equal(verified.row.locator, SEC_UID);
  assert.equal(verified.row.resolution.verifiedEvidenceCount, VIDEO_IDS.length);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthorEvidenceRequests } from "../lib/author-resolution.mjs";
import { canonicalAuthorEvidenceUrlSet, sameResolvedAuthorEvidence } from "../lib/author-evidence-equivalence.mjs";
import { MonitorDatabase } from "../lib/database.mjs";

const STORED = {
  douyin_id: "62169822674",
  account_locator: "MS4wLjABAAAApfUNMEFi_f40NHMt1GioCHOGu34jRcJZQyho_8TGjR_NHz4BwIb6ldvcY0JqMgPe",
  video_ids_json: "[]",
  share_urls_json: '["https://v.douyin.com/sO0KNedzAAg/"]',
};

test("resolved evidence treats only a short-link trailing slash as equivalent", () => {
  const incoming = {
    douyin_id: STORED.douyin_id,
    account_locator: STORED.account_locator,
    video_ids_json: "[]",
    share_urls_json: '["https://v.douyin.com/sO0KNedzAAg"]',
  };
  assert.equal(STORED.share_urls_json === incoming.share_urls_json, false, "raw JSON reproduces the false conflict");
  assert.equal(sameResolvedAuthorEvidence(STORED, incoming), true);
  assert.deepEqual(canonicalAuthorEvidenceUrlSet(STORED.share_urls_json), ["https://v.douyin.com/sO0KNedzAAg"]);
});

test("the queue key and evidence comparator agree for the production regression", () => {
  const row = (shareUrl) => ({
    status: "unresolved",
    platform: "douyin",
    name: "一条团总ovo",
    locator: STORED.account_locator,
    douyinId: STORED.douyin_id,
    shareUrl,
    sourceRow: 127,
  });
  const withSlash = buildAuthorEvidenceRequests([row("https://v.douyin.com/sO0KNedzAAg/")])[0];
  const withoutSlash = buildAuthorEvidenceRequests([row("https://v.douyin.com/sO0KNedzAAg")])[0];
  assert.equal(withSlash.key, withoutSlash.key);
  assert.equal(sameResolvedAuthorEvidence(
    { ...STORED, share_urls_json: JSON.stringify(withSlash.shareUrls) },
    { ...STORED, share_urls_json: JSON.stringify(withoutSlash.shareUrls) },
  ), true);
});

test("real identity or work changes still fail closed", () => {
  const variants = [
    { douyin_id: "different" },
    { account_locator: "MS4wLjDifferent" },
    { video_ids_json: '["7684617087687331118"]' },
    { share_urls_json: '["https://v.douyin.com/OtherWork/"]' },
    { share_urls_json: '["https://v.douyin.com/sO0KNedzAAg/?from=other"]' },
    { share_urls_json: '["https://v.douyin.com/so0KNedzAAg/"]' },
    { share_urls_json: "not-json" },
    { share_urls_json: '[""]' },
  ];
  for (const patch of variants) assert.equal(sameResolvedAuthorEvidence(STORED, { ...STORED, ...patch }), false);
});

test("evidence arrays compare as sets without weakening exact item identity", () => {
  const stored = { ...STORED,
    video_ids_json: '["7684617087687331117","7684617087687331118"]',
    share_urls_json: '["https://v.douyin.com/AbCd/","https://v.douyin.com/EfGh"]',
  };
  const reordered = { ...STORED,
    video_ids_json: '["7684617087687331118","7684617087687331117","7684617087687331117"]',
    share_urls_json: '["https://v.douyin.com/EfGh/","https://v.douyin.com/AbCd"]',
  };
  assert.equal(sameResolvedAuthorEvidence(stored, reordered), true);
  assert.equal(sameResolvedAuthorEvidence(stored, { ...reordered, video_ids_json: '["7684617087687331118"]' }), false);
});

test("resolved queue accepts the same short link with a trailing slash change without rewriting proof", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mcn-evidence-equivalence-"));
  const database = new MonitorDatabase(join(directory, "fixture.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: "account", provider: "public-web", label: "一条团总ovo",
    locator: STORED.account_locator, metadata: { platform: "douyin" } });
  const item = { key: `douyin:account:${STORED.account_locator}|same-share`, name: "一条团总ovo",
    douyinId: STORED.douyin_id, accountLocator: STORED.account_locator,
    videoIds: [], shareUrls: ["https://v.douyin.com/sO0KNedzAAg/"], sourceRows: [127], boards: [] };
  database.enqueueAuthorResolutions([item], { fileName: "热点表.xlsx", sheetName: "Sheet1" });
  const before = database.db.prepare("SELECT * FROM author_resolution_queue WHERE identity_key=?").get(item.key);
  assert.equal(database.markAuthorResolutionResolved(before.id, target.id), true);
  const verified = database.db.prepare("SELECT * FROM author_resolution_queue WHERE id=?").get(before.id);
  const result = database.enqueueAuthorResolutions([{ ...item,
    shareUrls: ["https://v.douyin.com/sO0KNedzAAg"], sourceRows: [127, 128],
  }], { fileName: "登记表.xlsx", sheetName: "Sheet1" });
  const after = database.db.prepare("SELECT * FROM author_resolution_queue WHERE id=?").get(before.id);
  assert.equal(result.alreadyResolvedEvidenceRequestCount, 1);
  assert.equal(after.status, "resolved");
  assert.equal(after.resolved_target_id, target.id);
  assert.equal(after.share_urls_json, verified.share_urls_json);
  assert.equal(after.video_ids_json, verified.video_ids_json);
  assert.equal(after.evidence_version, verified.evidence_version);
  assert.equal(after.updated_at, verified.updated_at);
  assert.equal(database.db.prepare("SELECT count(*) AS n FROM author_resolution_import_sources WHERE queue_id=?").get(before.id).n, 2);
  assert.throws(() => database.enqueueAuthorResolutions([{ ...item,
    shareUrls: ["https://v.douyin.com/OtherWork/"],
  }]), /内容冲突/);
});

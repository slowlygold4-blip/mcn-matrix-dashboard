import test from "node:test";
import assert from "node:assert/strict";
import { applyAuthorEvidence, buildAuthorEvidenceRequests, summarizeAuthorAccountIdentities, summarizeQueuedAuthorEvidence, verifyQueuedAuthorEvidence } from "../lib/author-resolution.mjs";

test('long account evidence keys remain bounded without merging different submitted works', () => {
  const locator = `MS4wLj${'A'.repeat(220)}`;
  const common = { status: 'resolvable', platform: 'douyin', locator, douyinId: 'fixture123',
    videoId: '7684603502123456789' };
  const left = buildAuthorEvidenceRequests([{ ...common, shareUrl: `https://v.douyin.com/${'q'.repeat(50)}a` }])[0];
  const right = buildAuthorEvidenceRequests([{ ...common, shareUrl: `https://v.douyin.com/${'q'.repeat(50)}b` }])[0];
  assert.ok(left.key.length <= 300);
  assert.ok(right.key.length <= 300);
  assert.ok(left.key.startsWith(`douyin:account:${locator}|sha256:`));
  assert.notEqual(left.key, right.key);
});

const SEC_A = "MS4wLjABAAAAiUHmRpLewwQ8Ycvp2rhaL4q-E4Gu_Ssf79r_USBq9tY";
const SEC_B = "MS4wLjABAAAAgK5EimMoCOQUuFwOpy1uqUkPSQXh24xGfC5GtO0GpXk31RSSx9XEpUMNPBEBfSBr";
const BVID_A = "BV1xx411c7mD";
const BVID_B = "BV1Q541167Qg";

function bilibiliCandidate({ bvid = BVID_A, mid = "1809444890", nickname = "B站作者", sourceEvidenceUrl } = {}) {
  return {
    platform: "bilibili",
    canonicalId: mid,
    canonicalUrl: `https://space.bilibili.com/${mid}`,
    nickname,
    videoId: bvid,
    evidenceUrl: `https://www.bilibili.com/video/${bvid}`,
    sourceEvidenceUrl: sourceEvidenceUrl ?? `https://www.bilibili.com/video/${bvid}`,
    endpoint: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    provenance: "bilibili-official-anonymous-view",
  };
}

test("public video evidence groups duplicate rows and verifies exact Douyin IDs", () => {
  const rows = [
    { sourceRow: 2, name: "猪啊", douyinId: "zhuaazhu", videoId: "7679097628281376036", locator: null, status: "resolvable" },
    { sourceRow: 3, name: "猪啊", douyinId: "zhuaazhu", videoId: "7679274629319380276", locator: null, status: "resolvable" },
    { sourceRow: 4, name: "", douyinId: "71381029603", videoId: "7679270829082823972", locator: null, status: "resolvable" },
  ];
  const requests = buildAuthorEvidenceRequests(rows);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((item) => item.videoIds), [["7679097628281376036"], ["7679274629319380276"], ["7679270829082823972"]]);

  const resolved = applyAuthorEvidence(rows, { items: [
    { key: "douyin:zhuaazhu|video:7679097628281376036", candidates: [{ videoId: "7679097628281376036", secUid: SEC_A, nickname: "猪啊", uniqueId: "zhuaazhu", shortId: "2972076173", uid: "99312146596" }], errors: [] },
    { key: "douyin:zhuaazhu|video:7679274629319380276", candidates: [{ videoId: "7679274629319380276", secUid: SEC_A, nickname: "猪啊", uniqueId: "zhuaazhu", shortId: "2972076173", uid: "99312146596" }], errors: [] },
    { key: "douyin:71381029603|video:7679270829082823972", candidates: [{ videoId: "7679270829082823972", secUid: SEC_B, nickname: "小枫叶99999(斗子黑切)", uniqueId: "71381029603", shortId: "71381029603", uid: "7583543305947726907" }], errors: [] },
  ] });
  assert.equal(resolved.summary.requestedAuthors, 3);
  assert.equal(resolved.summary.resolvedAuthors, 3);
  assert.equal(resolved.summary.resolvedEvidenceRequestCount, 3);
  assert.equal(resolved.summary.requestedAccountIdentitySummary.distinctAccountCount, 2);
  assert.equal(resolved.summary.resolvedAccountIdentitySummary.distinctAccountCount, 2);
  assert.equal(resolved.summary.matchedById, 3);
  assert.deepEqual(resolved.rows.map((row) => row.locator), [SEC_A, SEC_A, SEC_B]);
  assert.equal(resolved.rows[2].name, "小枫叶99999(斗子黑切)");
});

test("explicit account IDs deduplicate across evidence while nickname-only identity stays unknown", () => {
  const known = summarizeAuthorAccountIdentities([
    { platform: "douyin", douyinId: "@same-id", name: "旧昵称", videoId: "7679097628281376036" },
    { platform: "douyin", douyinId: "same-id", name: "新昵称", videoId: "7679274629319380276" },
    { platform: "bilibili", bilibiliId: "1234" },
    { platform: "bilibili", locator: "1234" },
    { platform: "douyin", douyinId: "1234" },
    { platform: "douyin", locator: SEC_A },
    { platform: "douyin", locator: SEC_A },
  ]);
  assert.equal(known.distinctAccountCount, 4);
  assert.equal(known.unknownIdentityItemCount, 0);
  assert.equal(known.inputItemCount, 7);
  const unknown = summarizeAuthorAccountIdentities([
    { name: "同名", videoId: "7679097628281376036" },
    { name: "同名", videoId: "7679274629319380276" },
    { douyinId: "known" },
    { douyinId: "conflicting", locator: SEC_A, status: "identity_conflict" },
  ]);
  assert.equal(unknown.knownDistinctAccountCount, 1);
  assert.equal(unknown.unknownIdentityItemCount, 3);
  assert.equal(unknown.distinctAccountCount, null);
  const malformed = summarizeAuthorAccountIdentities([
    { douyinId: "没有后悔药", name: "误填昵称" },
    { douyinId: "?!", name: "标点占位" },
    { douyinId: "valid_123" },
  ]);
  assert.equal(malformed.knownDistinctSubmittedIdentityCount, 1);
  assert.equal(malformed.unknownIdentityItemCount, 2);
  assert.equal(malformed.distinctAccountCount, null);
  const bound = summarizeAuthorAccountIdentities([
    { douyinId: "public-handle", locator: SEC_A }, { locator: SEC_A }, { douyinId: "public-handle" },
  ]);
  assert.equal(bound.distinctAccountCount, 1);
  assert.equal(bound.knownDistinctSubmittedIdentityCount, 1);
  const conflict = summarizeAuthorAccountIdentities([
    { douyinId: "same", locator: SEC_A }, { douyinId: "same", locator: SEC_B }, { locator: SEC_A },
  ]);
  assert.equal(conflict.distinctAccountCount, null);
  assert.equal(conflict.ambiguousIdentityItemCount, 3);
  assert.equal(conflict.knownDistinctSubmittedIdentityCount, 0);
  assert.equal(summarizeAuthorAccountIdentities([
    { douyinId: "different1", locator: SEC_A }, { douyinId: "different2", locator: SEC_A },
  ]).distinctAccountCount, null);
});

test("enqueue outcome counts only this batch's actual pending evidence and labels stored reuse separately", () => {
  const requests = [
    { key: "a", platform: "douyin", douyinId: "same" },
    { key: "b", platform: "douyin", douyinId: "same" },
    { key: "c", platform: "douyin", douyinId: "reused" },
    { key: "d", platform: "douyin", douyinId: "old-success" },
    { key: "a", platform: "douyin", douyinId: "same" },
  ];
  const summary = summarizeQueuedAuthorEvidence(requests, { pending: 8000, pendingEvidenceRequestKeys: ["a", "b", "a", "unrelated"],
    evidenceReusedKeys: ["c", "unrelated"], verifiedExistingEvidenceRequestKeys: ["d", "unrelated"], resolvedEvidenceRequestKeys: ["c", "d", "unrelated"] });
  assert.equal(summary.submittedEvidenceRequestCount, 4);
  assert.equal(summary.queuedEvidenceRequestCount, 2);
  assert.equal(summary.queuedAccountIdentitySummary.distinctAccountCount, 1);
  assert.equal(summary.evidenceReusedEvidenceRequestCount, 1);
  assert.equal(summary.alreadyResolvedEvidenceRequestCount, 1);
  assert.equal(summary.verifiedExistingEvidenceRequestCount, 1);
  const legacy = summarizeQueuedAuthorEvidence(requests, { pending: 8000 });
  assert.equal(legacy.queuedEvidenceRequestCount, null);
  assert.equal(legacy.queuedAccountIdentitySummary, null);
  assert.equal(legacy.evidenceReusedEvidenceRequestCount, null);
  assert.equal(legacy.verifiedExistingEvidenceRequestCount, null);
  assert.equal(summarizeQueuedAuthorEvidence([], {}).queuedEvidenceRequestCount, 0);
});

test("deliberately deferred requests are not fetch errors, failed authors or completed verification", () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ sourceRow: index + 2, douyinId: "same-account",
    videoId: String(7_679_000_000_000_000_000n + BigInt(index)), status: "resolvable" }));
  const requests = buildAuthorEvidenceRequests(rows);
  const resolved = applyAuthorEvidence(rows, { items: requests.map(({ key }) => ({ key,
    status: "deferred", networkAttempted: false, candidates: [], errors: [] })) });
  assert.equal(resolved.summary.requestedEvidenceRequestCount, 40);
  assert.equal(resolved.summary.requestedAccountIdentitySummary.distinctAccountCount, 1);
  assert.equal(resolved.summary.deferredEvidenceRequestCount, 40);
  assert.equal(resolved.summary.fetchFailedEvidenceRequestCount, 0);
  assert.equal(resolved.summary.fetchFailedAuthors, 0);
  assert.equal(resolved.summary.failedAuthors, 0);
  assert.equal(resolved.summary.evidenceErrors, 0);
  assert.equal(resolved.summary.resolvedEvidenceRequestCount, 0);
  assert.ok(resolved.rows.every((row) => row.status === "unresolved" && /尚未请求.*自动重试/.test(row.reason)));
  assert.match(resolved.summary.legacyCountSemantics, /not-distinct-authors/);
});

test("missing results, actual errors and partial evidence remain separate from deliberate deferral", () => {
  const rows = [{ douyinId: "expected", videoId: "7679097628281376036", shareUrl: "https://v.douyin.com/Proof/", status: "resolvable" }];
  const key = buildAuthorEvidenceRequests(rows)[0].key;
  const missing = applyAuthorEvidence(rows, { items: [] });
  assert.equal(missing.summary.noResultEvidenceRequestCount, 1);
  assert.equal(missing.summary.fetchFailedEvidenceRequestCount, 0);
  const failed = applyAuthorEvidence(rows, { items: [{ key, status: "deferred", networkAttempted: false, candidates: [], errors: [{ error: "actual failure" }] }] });
  assert.equal(failed.summary.deferredEvidenceRequestCount, 0, "an error cannot be disguised as a no-network deferral");
  assert.equal(failed.summary.fetchFailedEvidenceRequestCount, 1);
  assert.equal(failed.summary.evidenceErrors, 1);
  const partial = applyAuthorEvidence(rows, { items: [{ key, candidates: [{ videoId: rows[0].videoId, secUid: SEC_A, uniqueId: "expected" }], errors: [] }] });
  assert.equal(partial.summary.incompleteEvidenceRequestCount, 1);
  assert.equal(partial.summary.fetchFailedEvidenceRequestCount, 0);
  assert.equal(partial.summary.resolvedEvidenceRequestCount, 0);
  const empty = applyAuthorEvidence(rows, { items: [{ key, candidates: [], errors: [] }] });
  assert.equal(empty.summary.noEvidenceEvidenceRequestCount, 1);
  assert.equal(empty.summary.fetchFailedEvidenceRequestCount, 0);
});

test("author evidence groups retain bounded spreadsheet classification fields", () => {
  const requests = buildAuthorEvidenceRequests([
    {
      sourceRow: 2,
      name: "作者",
      douyinId: "same-author",
      videoId: "7679097628281376036",
      organization: "  机构　A  ",
      tier: "甲".repeat(140),
      category: "",
      owner: "负责人甲",
      filledDate: "2026-09-08",
      note: "首批名单",
      board: "杨齐家切片矩阵",
    },
    {
      sourceRow: 3,
      name: "作者",
      douyinId: "same-author",
      videoId: "7679274629319380276",
      organization: "不应覆盖机构A",
      tier: "不应覆盖层级",
      category: ` 游戏 ${"垂".repeat(130)} `,
      owner: "负责人乙",
      filledDate: "2026-09-09",
      note: "第二批名单",
      board: "一条小团团切片矩阵",
    },
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].organization, "机构 A");
  assert.equal(requests[0].tier.length, 120);
  assert.equal(requests[1].category.length, 120);
  assert.match(requests[1].category, /^游戏 /);
  assert.deepEqual(requests.flatMap((request) => request.boards.map((board) => board.name)), ["杨齐家切片矩阵", "一条小团团切片矩阵"]);
  assert.deepEqual({
    organization: requests[0].boards[0].organization,
    owner: requests[0].boards[0].owner,
    filledDate: requests[0].boards[0].filledDate,
    note: requests[0].boards[0].note,
    sourceRow: requests[0].boards[0].sourceRow,
  }, { organization: "机构 A", owner: "负责人甲", filledDate: "2026-09-08", note: "首批名单", sourceRow: 2 });
  assert.deepEqual({
    organization: requests[1].boards[0].organization,
    owner: requests[1].boards[0].owner,
    sourceRow: requests[1].boards[0].sourceRow,
  }, { organization: "不应覆盖机构A", owner: "负责人乙", sourceRow: 3 });
});

test("automatic resolution rejects mismatched author evidence", () => {
  const rows = [{ sourceRow: 2, name: "提交作者", douyinId: "expected-id", videoId: "7679097628281376036", locator: null, status: "resolvable" }];
  const resolved = applyAuthorEvidence(rows, { items: [{
    key: "douyin:expected-id|video:7679097628281376036",
    candidates: [{ videoId: "7679097628281376036", secUid: SEC_A, nickname: "其他作者", uniqueId: "other-id", shortId: "1", uid: "2" }],
    errors: [],
  }] });
  assert.equal(resolved.summary.resolvedAuthors, 0);
  assert.equal(resolved.summary.identityMismatchAuthors, 1);
  assert.equal(resolved.summary.fetchFailedAuthors, 0);
  assert.equal(resolved.rows[0].locator, null);
  assert.equal(resolved.rows[0].status, "unresolved");
  assert.match(resolved.rows[0].reason, /不一致/);
});

test("a submitted Douyin sec_uid plus work is imported only after the work owner matches", () => {
  const rows = [{ sourceRow: 2, platform: "douyin", name: "", locator: SEC_A, videoId: "7679097628281376036", status: "ready" }];
  const requests = buildAuthorEvidenceRequests(rows);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].key, `douyin:account:${SEC_A}|video:7679097628281376036`);
  assert.equal(requests[0].accountLocator, SEC_A);

  const accepted = applyAuthorEvidence(rows, { items: [{
    key: `douyin:account:${SEC_A}|video:7679097628281376036`,
    candidates: [{ videoId: "7679097628281376036", secUid: SEC_A, nickname: "正确作者" }],
    errors: [],
  }] });
  assert.equal(accepted.rows[0].status, "ready");
  assert.equal(accepted.rows[0].locator, SEC_A);
  assert.match(accepted.rows[0].reason, /发布者 sec_uid.*严格一致/);

  const rejected = applyAuthorEvidence(rows, { items: [{
    key: `douyin:account:${SEC_A}|video:7679097628281376036`,
    candidates: [{ videoId: "7679097628281376036", secUid: SEC_B, nickname: "其他作者" }],
    errors: [],
  }] });
  assert.equal(rejected.summary.identityMismatchAuthors, 1);
  assert.equal(rejected.rows[0].status, "unresolved");
  assert.equal(rejected.rows[0].locator, SEC_A, "保留提交证据不代表允许写入，status 必须作为写入门禁");
});

test("a public video alone can identify its own publishing author", () => {
  const rows = [{ sourceRow: 8, name: "", douyinId: "", videoId: "7679270829082823972", status: "resolvable" }];
  const resolved = applyAuthorEvidence(rows, { items: [{
    key: "video:7679270829082823972",
    candidates: [{ videoId: "7679270829082823972", secUid: SEC_A, nickname: "公开视频作者", uniqueId: "DY-PUBLIC" }],
    errors: [],
  }] });
  assert.equal(resolved.summary.resolvedAuthors, 1);
  assert.equal(resolved.rows[0].locator, SEC_A);
  assert.equal(resolved.rows[0].name, "公开视频作者");
  assert.match(resolved.rows[0].reason, /补全/);
});

test("nickname-only evidence requires an exact normalized nickname", () => {
  const rows = [{ sourceRow: 2, name: "作者 甲", douyinId: "", videoId: "7679097628281376036", locator: null, status: "resolvable" }];
  const resolved = applyAuthorEvidence(rows, { items: [{
    key: "video:7679097628281376036",
    candidates: [{ videoId: "7679097628281376036", secUid: SEC_A, nickname: "作者 甲", uniqueId: "someone" }],
    errors: [],
  }] });
  assert.equal(resolved.summary.matchedByName, 1);
  assert.equal(resolved.rows[0].locator, SEC_A);
});

test("temporary public fetch failures are separated from identity mismatches", () => {
  const rows = [{ sourceRow: 2, name: "提交作者", douyinId: "expected-id", videoId: "7679097628281376036", locator: null, status: "resolvable" }];
  const resolved = applyAuthorEvidence(rows, { items: [{
    key: "douyin:expected-id|video:7679097628281376036",
    candidates: [],
    errors: [{ videoId: "7679097628281376036", error: "公开网页返回空内容", attempts: 3 }],
  }] });
  assert.equal(resolved.summary.resolvedAuthors, 0);
  assert.equal(resolved.summary.fetchFailedAuthors, 1);
  assert.equal(resolved.summary.identityMismatchAuthors, 0);
  assert.match(resolved.rows[0].reason, /稍后自动重试/);
});

test("short-share evidence is retained without inserting an empty video ID", () => {
  const rows = [{ sourceRow: 2, name: "", shareUrl: "https://v.douyin.com/AbCdEfG/", locator: null, status: "resolvable" }];
  const requests = buildAuthorEvidenceRequests(rows);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].videoIds, []);
  assert.deepEqual(requests[0].shareUrls, ["https://v.douyin.com/AbCdEfG/"]);

  const failed = applyAuthorEvidence(rows, { items: [{ key: "share:https://v.douyin.com/AbCdEfG/", candidates: [], errors: [{ error: "temporary" }] }] });
  assert.equal(failed.rows[0].status, "unresolved");
  assert.match(failed.rows[0].reason, /自动重试/);
});

test("share evidence normalizes only its scheme and hostname", () => {
  const requests = buildAuthorEvidenceRequests([
    { sourceRow: 2, shareUrl: "HTTPS://V.DOUYIN.COM/AbCdEfG/?Ref=CaseSensitive", status: "resolvable" },
    { sourceRow: 3, shareUrl: "https://v.douyin.com/AbCdEfG/?Ref=CaseSensitive", status: "resolvable" },
    { sourceRow: 4, shareUrl: "https://v.douyin.com/abcdefg/?Ref=CaseSensitive", status: "resolvable" },
    { sourceRow: 5, shareUrl: "https://v.douyin.com/AbCdEfG/?ref=CaseSensitive", status: "resolvable" },
  ]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((item) => item.shareUrls), [
    ["https://v.douyin.com/AbCdEfG/?Ref=CaseSensitive"],
    ["https://v.douyin.com/abcdefg/?Ref=CaseSensitive"],
    ["https://v.douyin.com/AbCdEfG/?ref=CaseSensitive"],
  ]);
});

test("share evidence treats a trailing slash as the same work without losing the submitted URL", () => {
  const requests = buildAuthorEvidenceRequests([
    { sourceRow: 2, shareUrl: "https://v.douyin.com/AbCdEfG", status: "resolvable" },
    { sourceRow: 3, shareUrl: "https://v.douyin.com/AbCdEfG/", status: "resolvable" },
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].shareUrls, ["https://v.douyin.com/AbCdEfG"]);
});

test("nickname-only evidence stays unresolved when the same nickname maps to multiple authors", () => {
  const rows = [{ sourceRow: 2, name: "同名作者", videoId: "7679097628281376036", locator: null, status: "resolvable" }];
  const resolved = applyAuthorEvidence(rows, { items: [{
    key: "video:7679097628281376036",
    candidates: [
      { videoId: "7679097628281376036", secUid: SEC_A, nickname: "同名作者" },
      { videoId: "7679097628281376036", secUid: SEC_B, nickname: "同名作者" },
    ],
    errors: [],
  }] });
  assert.equal(resolved.summary.resolvedAuthors, 0);
  assert.equal(resolved.summary.ambiguousAuthors, 1);
  assert.equal(resolved.rows[0].status, "unresolved");
  assert.match(resolved.rows[0].reason, /多个不同作者/);
});

test("Douyin candidates must echo the exact submitted work identity", () => {
  const rows = [{ sourceRow: 2, name: "作者", videoId: "7679097628281376036", status: "resolvable" }];
  for (const candidate of [
    { secUid: SEC_A, nickname: "作者", videoId: "" },
    { secUid: SEC_A, nickname: "作者", videoId: "7679274629319380276" },
  ]) {
    const resolved = applyAuthorEvidence(rows, { items: [{
      key: "video:7679097628281376036",
      candidates: [candidate],
      errors: [],
    }] });
    assert.equal(resolved.rows[0].status, "unresolved");
    assert.equal(resolved.summary.identityMismatchAuthors, 1);
  }
});

test("every submitted work proof on one row must resolve to the same Douyin author", () => {
  const shareUrl = "https://v.douyin.com/AbCdEfG/";
  const rows = [{
    sourceRow: 2,
    platform: "douyin",
    locator: SEC_A,
    videoId: "7679097628281376036",
    shareUrl,
    status: "resolvable",
  }];
  const requests = buildAuthorEvidenceRequests(rows);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].videoIds, ["7679097628281376036"]);
  assert.deepEqual(requests[0].shareUrls, [shareUrl]);

  const missingShare = applyAuthorEvidence(rows, { items: [{
    key: requests[0].key,
    candidates: [{ videoId: rows[0].videoId, secUid: SEC_A, nickname: "正确作者" }],
    errors: [],
  }] });
  assert.equal(missingShare.rows[0].status, "unresolved");

  const conflictingOwners = applyAuthorEvidence(rows, { items: [{
    key: requests[0].key,
    candidates: [
      { videoId: rows[0].videoId, secUid: SEC_A, nickname: "正确作者" },
      { videoId: "7679274629319380276", sourceEvidenceUrl: shareUrl, secUid: SEC_B, nickname: "另一作者" },
    ],
    errors: [],
  }] });
  assert.equal(conflictingOwners.rows[0].status, "unresolved");
  assert.equal(conflictingOwners.summary.ambiguousAuthors, 1);

  const accepted = applyAuthorEvidence(rows, { items: [{
    key: requests[0].key,
    candidates: [
      { videoId: rows[0].videoId, secUid: SEC_A, nickname: "正确作者" },
      { videoId: "7679274629319380276", sourceEvidenceUrl: shareUrl, secUid: SEC_A, nickname: "正确作者" },
    ],
    errors: [],
  }] });
  assert.equal(accepted.rows[0].status, "ready");
  assert.equal(accepted.rows[0].locator, SEC_A);
});

test("a fourth distinct short-link proof is never truncated from a repeated account and work", () => {
  const videoId = "7679097628281376036";
  const shortCodes = ["Abcd", "aBcd", "abCd", "abcD"];
  const rows = shortCodes.map((shortCode, index) => ({
    sourceRow: index + 2,
    platform: "douyin",
    locator: SEC_A,
    videoId,
    shareUrl: `https://v.douyin.com/${shortCode}/`,
    status: "resolvable",
  }));
  const requests = buildAuthorEvidenceRequests(rows);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map((item) => item.shareUrls[0]), rows.map((row) => row.shareUrl));
  const resolved = applyAuthorEvidence(rows, { items: requests.map((request, index) => ({
    key: request.key,
    candidates: [
      { videoId, secUid: SEC_A, nickname: "正确作者" },
      { videoId, sourceEvidenceUrl: request.shareUrls[0], secUid: index === 3 ? SEC_B : SEC_A, nickname: index === 3 ? "另一作者" : "正确作者" },
    ],
    errors: [],
  })) });
  assert.deepEqual(resolved.rows.map((row) => row.status), ["ready", "ready", "ready", "unresolved"]);
  assert.equal(resolved.summary.ambiguousAuthors, 1);
});

test("b23 short-link paths preserve case and never inherit another row's proof", () => {
  const shortCodes = ["Abcd", "aBcd", "abCd", "abcD"];
  const rows = shortCodes.map((shortCode, index) => ({
    sourceRow: index + 2,
    platform: "bilibili",
    locator: "1809444890",
    bilibiliId: "1809444890",
    videoId: BVID_A,
    shareUrl: `https://b23.tv/${shortCode}`,
    status: "resolvable",
  }));
  const requests = buildAuthorEvidenceRequests(rows);
  assert.equal(requests.length, 4);
  assert.equal(new Set(requests.map((item) => item.key)).size, 4);
  assert.deepEqual(requests.map((item) => item.shareUrls[0]), rows.map((row) => row.shareUrl));

  const resolved = applyAuthorEvidence(rows, { items: requests.map((request, index) => ({
    key: request.key,
    candidates: [bilibiliCandidate({
      mid: index === 3 ? "946974" : "1809444890",
      nickname: index === 3 ? "另一作者" : "正确作者",
      sourceEvidenceUrl: request.shareUrls[0],
    })],
    errors: [],
  })) });
  assert.deepEqual(resolved.rows.map((row) => row.status), ["ready", "ready", "ready", "unresolved"]);
  assert.equal(resolved.summary.identityMismatchAuthors, 1);
});

test("rows sharing a sec_uid and work retain their own submitted ID constraint", () => {
  const videoId = "7679097628281376036";
  const rows = [
    { sourceRow: 2, platform: "douyin", locator: SEC_A, douyinId: "correct-id", videoId, status: "resolvable" },
    { sourceRow: 3, platform: "douyin", locator: SEC_A, douyinId: "wrong-id", videoId, status: "resolvable" },
  ];
  const requests = buildAuthorEvidenceRequests(rows);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].key, requests[1].key);
  const resolved = applyAuthorEvidence(rows, { items: requests.map((request) => ({
    key: request.key,
    candidates: [{ videoId, secUid: SEC_A, nickname: "作者", uniqueId: "correct-id" }],
    errors: [],
  })) });
  assert.deepEqual(resolved.rows.map((row) => row.status), ["ready", "unresolved"]);
  assert.equal(resolved.summary.identityMismatchAuthors, 1);
});

test("same-name rows with different public works never inherit another row's author identity", () => {
  const rows = [
    { sourceRow: 2, name: "同名作者", videoId: "7679097628281376036", locator: null, status: "resolvable" },
    { sourceRow: 3, name: "同名作者", videoId: "7679274629319380276", locator: null, status: "resolvable" },
  ];
  const requests = buildAuthorEvidenceRequests(rows);
  assert.deepEqual(requests.map((item) => item.key), ["video:7679097628281376036", "video:7679274629319380276"]);
  const resolved = applyAuthorEvidence(rows, { items: [{
    key: "video:7679097628281376036",
    candidates: [{ videoId: "7679097628281376036", secUid: SEC_A, nickname: "同名作者" }],
    errors: [],
  }] });
  assert.equal(resolved.rows[0].locator, SEC_A);
  assert.equal(resolved.rows[1].locator, null);
  assert.notEqual(resolved.rows[1].status, "ready");
});

test("the same submitted account verifies every work independently across boards", () => {
  const rows = [
    { sourceRow: 2, board: "板块一", platform: "douyin", locator: SEC_A, videoId: "7679097628281376036", status: "resolvable" },
    { sourceRow: 3, board: "板块二", platform: "douyin", locator: SEC_A, videoId: "7679274629319380276", status: "resolvable" },
  ];
  const requests = buildAuthorEvidenceRequests(rows);
  assert.deepEqual(requests.map((item) => item.key), [
    `douyin:account:${SEC_A}|video:7679097628281376036`,
    `douyin:account:${SEC_A}|video:7679274629319380276`,
  ]);
  const resolved = applyAuthorEvidence(rows, { items: [
    { key: requests[0].key, candidates: [{ videoId: rows[0].videoId, secUid: SEC_A, nickname: "正确作者" }], errors: [] },
    { key: requests[1].key, candidates: [{ videoId: rows[1].videoId, secUid: SEC_B, nickname: "另一作者" }], errors: [] },
  ] });
  assert.equal(resolved.rows[0].status, "ready");
  assert.equal(resolved.rows[1].status, "unresolved");
  assert.deepEqual(resolved.rows.map((row) => row.board), ["板块一", "板块二"]);
  assert.equal(resolved.summary.resolvedAuthors, 1);
  assert.equal(resolved.summary.identityMismatchAuthors, 1);
});

test("Bilibili BV evidence resolves only its official owner.mid and retains provenance", () => {
  const rows = [{ sourceRow: 2, platform: "bilibili", name: "", videoId: BVID_A, locator: null, status: "resolvable" }];
  const requests = buildAuthorEvidenceRequests(rows);
  assert.deepEqual(requests.map((item) => ({ key: item.key, platform: item.platform, videoIds: item.videoIds })), [{
    key: `bilibili:video:${BVID_A}`,
    platform: "bilibili",
    videoIds: [BVID_A],
  }]);

  const resolved = applyAuthorEvidence(rows, { items: [{
    key: `bilibili:video:${BVID_A}`,
    candidates: [bilibiliCandidate()],
    errors: [],
  }] });
  assert.equal(resolved.summary.resolvedAuthors, 1);
  assert.equal(resolved.summary.matchedByEvidence, 1);
  assert.equal(resolved.rows[0].locator, "1809444890");
  assert.equal(resolved.rows[0].name, "B站作者");
  assert.deepEqual({
    platform: resolved.rows[0].resolution.platform,
    canonicalAccountId: resolved.rows[0].resolution.canonicalAccountId,
    canonicalAccountUrl: resolved.rows[0].resolution.canonicalAccountUrl,
    evidenceVideoId: resolved.rows[0].resolution.evidenceVideoId,
    provenance: resolved.rows[0].resolution.provenance,
  }, {
    platform: "bilibili",
    canonicalAccountId: "1809444890",
    canonicalAccountUrl: "https://space.bilibili.com/1809444890",
    evidenceVideoId: BVID_A,
    provenance: "bilibili-official-anonymous-view",
  });
});

test("a submitted Bilibili UID plus BV is imported only after official owner.mid matches", () => {
  const rows = [{ sourceRow: 2, platform: "bilibili", name: "", locator: "1809444890", bilibiliId: "1809444890", videoId: BVID_A, status: "ready" }];
  const requests = buildAuthorEvidenceRequests(rows);
  assert.equal(requests[0].key, `bilibili:account:1809444890|video:${BVID_A}`);
  assert.equal(requests[0].accountLocator, "1809444890");
  const accepted = applyAuthorEvidence(rows, { items: [{ key: requests[0].key, candidates: [bilibiliCandidate()], errors: [] }] });
  assert.equal(accepted.rows[0].status, "ready");
  assert.match(accepted.rows[0].reason, /发布者 UID.*严格一致/);

  const rejected = applyAuthorEvidence(rows, { items: [{
    key: requests[0].key,
    candidates: [bilibiliCandidate({ mid: "946974", nickname: "其他作者" })],
    errors: [],
  }] });
  assert.equal(rejected.summary.identityMismatchAuthors, 1);
  assert.equal(rejected.rows[0].status, "unresolved");
});

test("identity conflicts and unverifiable Xiaohongshu work ownership never become direct imports", () => {
  const conflict = { sourceRow: 2, platform: "douyin", locator: SEC_A, videoId: "7679097628281376036", status: "identity_conflict" };
  assert.deepEqual(buildAuthorEvidenceRequests([conflict]), []);
  assert.equal(applyAuthorEvidence([conflict], { items: [] }).rows[0].status, "identity_conflict");

  const xhs = {
    sourceRow: 3,
    platform: "xiaohongshu",
    locator: "https://www.xiaohongshu.com/user/profile/64b1234567890abcdef12345",
    videoId: "68e66fef0000000004023fdb",
    status: "ready",
  };
  const reviewed = applyAuthorEvidence([xhs], { items: [] });
  assert.equal(reviewed.rows[0].status, "unresolved");
  assert.match(reviewed.rows[0].reason, /无法核验.*未写入/);
});

test("same-name Bilibili works never cross-assign publisher UIDs", () => {
  const rows = [
    { sourceRow: 2, platform: "bilibili", name: "同名作者", videoId: BVID_A, locator: null, status: "resolvable" },
    { sourceRow: 3, platform: "bilibili", name: "同名作者", videoId: BVID_B, locator: null, status: "resolvable" },
  ];
  const requests = buildAuthorEvidenceRequests(rows);
  assert.deepEqual(requests.map((item) => item.key), [`bilibili:video:${BVID_A}`, `bilibili:video:${BVID_B}`]);
  const resolved = applyAuthorEvidence(rows, { items: [
    { key: `bilibili:video:${BVID_A}`, candidates: [bilibiliCandidate({ nickname: "同名作者" })], errors: [] },
    { key: `bilibili:video:${BVID_B}`, candidates: [bilibiliCandidate({ bvid: BVID_B, mid: "946974", nickname: "同名作者" })], errors: [] },
  ] });
  assert.deepEqual(resolved.rows.map((row) => row.locator), ["1809444890", "946974"]);
});

test("Bilibili resolution rejects a publisher that differs from submitted UID or nickname", () => {
  const uidMismatch = applyAuthorEvidence([
    { sourceRow: 2, platform: "bilibili", name: "", bilibiliId: "111111", videoId: BVID_A, locator: null, status: "resolvable" },
  ], { items: [{ key: `bilibili:111111|video:${BVID_A}`, candidates: [bilibiliCandidate({ mid: "222222" })], errors: [] }] });
  assert.equal(uidMismatch.summary.identityMismatchAuthors, 1);
  assert.equal(uidMismatch.rows[0].status, "unresolved");
  assert.equal(uidMismatch.rows[0].locator, null);

  const nameMismatch = applyAuthorEvidence([
    { sourceRow: 3, platform: "bilibili", name: "提交作者", videoId: BVID_A, locator: null, status: "resolvable" },
  ], { items: [{ key: `bilibili:video:${BVID_A}`, candidates: [bilibiliCandidate({ nickname: "其他作者" })], errors: [] }] });
  assert.equal(nameMismatch.summary.identityMismatchAuthors, 1);
  assert.equal(nameMismatch.rows[0].status, "unresolved");
  assert.match(nameMismatch.rows[0].reason, /不一致.*拒绝/);
});

test("Bilibili candidates without exact official source proof are rejected", () => {
  const rows = [{ sourceRow: 2, platform: "bilibili", name: "", videoId: BVID_A, locator: null, status: "resolvable" }];
  const wrongVideo = bilibiliCandidate({ bvid: BVID_B });
  const missingProvenance = { ...bilibiliCandidate(), provenance: "" };
  for (const candidate of [wrongVideo, missingProvenance]) {
    const resolved = applyAuthorEvidence(rows, { items: [{ key: `bilibili:video:${BVID_A}`, candidates: [candidate], errors: [] }] });
    assert.equal(resolved.summary.resolvedAuthors, 0);
    assert.equal(resolved.summary.identityMismatchAuthors, 1);
    assert.equal(resolved.rows[0].status, "unresolved");
  }
});

test("queued multi-work evidence is committed only when every work resolves to one owner", () => {
  const videoIds = ["7679000000000000201", "7679000000000000202", "7679000000000000203", "7679000000000000204"];
  const item = {
    platform: "douyin",
    accountLocator: SEC_A,
    videoIds,
    shareUrls: [],
    sourceRows: [2, 3, 4, 5],
    boards: [{ name: "杨齐家切片矩阵" }],
  };
  const accepted = verifyQueuedAuthorEvidence(item, {
    candidates: videoIds.map((videoId) => ({ videoId, secUid: SEC_A, nickname: "严格作者" })),
    errors: [],
  });
  assert.equal(accepted.status, "ready");
  assert.equal(accepted.row.locator, SEC_A);
  assert.equal(accepted.row.resolution.verificationPolicy, "all-submitted-evidence-v2");
  assert.equal(accepted.row.resolution.verifiedEvidenceCount, 4);
  assert.equal(accepted.row.resolution.verifiedEvidence.length, 4);
  assert.match(accepted.row.resolution.verifiedEvidenceSha256, /^[a-f0-9]{64}$/);

  const rejected = verifyQueuedAuthorEvidence(item, {
    candidates: videoIds.map((videoId, index) => ({ videoId, secUid: index === 3 ? SEC_B : SEC_A, nickname: "严格作者" })),
    errors: [],
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.row, null);
  assert.match(rejected.reason, /不一致|不同作者/);
});

test("queued multi-work evidence retries rather than partially committing when one work is missing", () => {
  const videoIds = ["7679000000000000211", "7679000000000000212"];
  const reviewed = verifyQueuedAuthorEvidence({
    platform: "douyin",
    accountLocator: SEC_A,
    videoIds,
    sourceRows: [2, 3],
  }, {
    candidates: [{ videoId: videoIds[0], secUid: SEC_A, nickname: "严格作者" }],
    errors: [{ error: "第二项公开详情暂时读取失败" }],
  });
  assert.equal(reviewed.status, "retry");
  assert.equal(reviewed.row, null);
  assert.match(reviewed.reason, /并非每一项|读取失败/);
});

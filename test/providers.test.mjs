import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";

const STRICT_SEC_UID = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const OTHER_SEC_UID = "MS4wLjABAAAAzyxwvutsrqponmlkjihgfedc";

test("public-web account provider runs the local helper and normalizes data", async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, JSON.stringify({ ok: true, data: {
      capturedAt: "2026-08-31T12:00:00Z",
      profile: { user: { sec_uid: "SEC-1", nickname: "作者", follower_count: 99, total_favorited: 1_234, aweme_count: 1 } },
      works: { aweme_list: [{ aweme_id: "A1", desc: "#测试 作品", create_time: 1788184800, author: { sec_uid: "SEC-1", nickname: "作者" }, statistics: { digg_count: 10, collect_count: 3 } }] },
      warnings: [],
    } }), "");
  };
  const provider = new PublicWebProvider({ publicPostsPerAccount: "30" }, { execFileImpl });
  const result = await provider.collect({ id: 1, type: "account", label: "账号", locator: "MS4wLjExample", metadata: {} });
  assert.match(calls[0].args.join(" "), /--operation account/);
  assert.equal(result.posts[0].externalId, "A1");
  assert.equal(result.posts[0].collects, 3);
  assert.equal(result.snapshot.followers, 99);
  assert.equal(result.snapshot.totalLikes, 1_234);
  assert.equal(result.qualityStatus, "validated");
});

test("Douyin account collection flags missing cumulative likes for automatic retry", async () => {
  const execFileImpl = (_file, _args, _options, callback) => callback(null, JSON.stringify({ ok: true, data: {
    profile: { user: { sec_uid: "SEC-1", nickname: "作者", follower_count: 99, aweme_count: 1 } },
    works: { aweme_list: [{ aweme_id: "A1", desc: "作品", author: { sec_uid: "SEC-1" }, statistics: { digg_count: 10 } }] },
  } }), "");
  const result = await new PublicWebProvider({}, { execFileImpl }).collect({ id: 1, type: "account", label: "账号", locator: "MS4wLjExample", metadata: {} });
  assert.equal(result.snapshot.totalLikes, null);
  assert.equal(result.qualityStatus, "warning");
  assert.match(result.warnings.join("；"), /抖音公开主页响应未包含账号获赞总数/);
});

test("Douyin collection rejects a profile identity mismatch before any data is stored", async () => {
  const execFileImpl = (_file, _args, _options, callback) => callback(null, JSON.stringify({ ok: true, data: {
    profile: { user: { sec_uid: OTHER_SEC_UID, nickname: "错误作者", follower_count: 99, total_favorited: 100 } },
    works: { aweme_list: [] },
  } }), "");
  await assert.rejects(
    new PublicWebProvider({}, { execFileImpl }).collect({
      id: 1,
      type: "account",
      label: "目标作者",
      locator: STRICT_SEC_UID,
      metadata: { platform: "douyin" },
    }),
    /账号 ID 与提交目标不一致/,
  );
});

test("public-web provider routes Bilibili targets through zero-key public endpoints", async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, JSON.stringify({ ok: true, data: {
      capturedAt: "2026-09-01T12:00:00Z",
      profile: { user: { uid: "1809444890", nickname: "三角洲-安澜", follower_count: 1_944_430, aweme_count: 208 } },
      works: { aweme_list: [{ aweme_id: "BV1fi416bEpi", desc: "公开视频", create_time: 1788054300, author: { uid: "1809444890", nickname: "三角洲-安澜" }, statistics: { digg_count: 99, play_count: 1000 }, share_url: "https://www.bilibili.com/video/BV1fi416bEpi" }] },
      warnings: [],
    } }), "");
  };
  const provider = new PublicWebProvider({ publicPostsPerAccount: "3" }, { execFileImpl });
  const result = await provider.collect({ id: 2, type: "account", label: "安澜", locator: "1809444890", metadata: { platform: "bilibili" } });
  assert.match(calls[0].args.join(" "), /--operation bilibili-account/);
  assert.equal(result.snapshot.followers, 1_944_430);
  assert.equal(result.posts[0].externalId, "BV1fi416bEpi");
  assert.equal(result.posts[0].plays, 1000);
  assert.equal(result.posts[0].url, "https://www.bilibili.com/video/BV1fi416bEpi");
});

test("public-web source probe checks Bilibili's anonymous card endpoint without collecting works", async () => {
  const calls = [];
  const provider = new PublicWebProvider({}, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { card: { mid: "1809444890", name: "三角洲-安澜" } } }),
      };
    },
  });
  const result = await provider.testConnectionForPlatform("bilibili", {
    locator: "https://space.bilibili.com/1809444890",
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.bilibili\.com\/x\/web-interface\/card\?mid=1809444890/);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(result.profileEndpoint, true);
  assert.equal(result.postsEndpoint, null);
  assert.equal(result.paidAPI, false);
});

test("public-web provider reads Xiaohongshu official profile state without a key or login", async () => {
  const userId = "619e0b66000000001000e923";
  const html = `<script>window.__INITIAL_STATE__={"global":{"missing":undefined},"user":{"userPageData":{"basicInfo":{"nickname":"作者红"},"interactions":[{"type":"fans","count":"12345"},{"type":"interaction","count":"3.4万"}],"result":{"success":true}},"noteQueries":[{"userId":"${userId}"}],"notes":[[{"id":"68e66fef0000000004023fdb","noteCard":{"displayTitle":"公开笔记","time":1788184800000,"user":{"userId":"${userId}","nickname":"作者红"},"interactInfo":{"likedCount":"123"}}}]]}}</script>`;
  const provider = new PublicWebProvider({ publicPostsPerAccount: "3" }, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }),
    execFileImpl: () => { throw new Error("direct profile read should not invoke OpenCLI"); },
  });
  const result = await provider.collect({
    id: 3,
    type: "account",
    label: "作者红",
    locator: `https://www.xiaohongshu.com/user/profile/${userId}`,
    metadata: { platform: "xiaohongshu" },
  });
  assert.equal(result.snapshot.followers, 12_345);
  assert.equal(result.snapshot.totalLikes, null);
  assert.equal(result.raw.publicObservations.accountInteractions[1].count, "3.4万");
  assert.equal(result.raw.publicObservations.accountInteractions[1].metric, "likes-and-collects");
  assert.equal(result.worksCoverage, "limited");
  assert.equal(result.snapshot.totalPosts, null);
  assert.equal(result.posts[0].externalId, "68e66fef0000000004023fdb");
  assert.equal(result.posts[0].likes, 123);
  assert.equal(result.raw.provenance.authenticated, false);
  assert.equal(result.raw.provenance.paidAPI, false);
});

test("public-web source probe checks Xiaohongshu public initial state without a browser", async () => {
  const userId = "619e0b66000000001000e923";
  const html = `<script>window.__INITIAL_STATE__={"user":{"userPageData":{"basicInfo":{"nickname":"作者红"}},"notes":[]}}</script>`;
  const calls = [];
  const provider = new PublicWebProvider({}, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => html };
    },
  });
  const result = await provider.testConnectionForPlatform("xiaohongshu", {
    locator: `https://www.xiaohongshu.com/user/profile/${userId}`,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(result.profileEndpoint, true);
  assert.equal(result.postsEndpoint, true);
  assert.equal(result.runtimeAI, false);
});

test("Xiaohongshu profile login walls remain actionable instead of a generic warning", async () => {
  const userId = "619e0b66000000001000e923";
  const provider = new PublicWebProvider({}, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => `<script>window.__INITIAL_STATE__={"user":{"userPageData":{},"notes":[]}}</script>`,
    }),
  });
  await assert.rejects(
    provider.collect({
      id: 3,
      type: "account",
      label: "作者红",
      locator: `https://www.xiaohongshu.com/user/profile/${userId}`,
      metadata: { platform: "xiaohongshu" },
    }),
    /匿名登录墙或 IP 冷却.*提交仍可公开核验的官方笔记链接.*未使用个人登录态/,
  );
});

test("Xiaohongshu failure never falls back to a personal or persistent browser session", async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, "", "");
  };
  const provider = new PublicWebProvider({ publicPostsPerAccount: "3" }, {
    execFileImpl,
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }),
  });
  await assert.rejects(
    provider.collect({
      id: 3,
      type: "account",
      label: "作者红",
      locator: "https://www.xiaohongshu.com/user/profile/5d8f88dc0000000001005d3a",
      metadata: { platform: "xiaohongshu" },
    }),
    /未使用个人登录态或持久浏览器会话/,
  );
  assert.equal(calls.length, 0);
});

test("public-web author resolver verifies a Bilibili BV owner through the official anonymous view endpoint", async () => {
  const bvid = "BV1fi416bEpi";
  const calls = [];
  const provider = new PublicWebProvider({}, {
    execFileImpl: () => { throw new Error("Bilibili author resolution must not invoke the Douyin helpers"); },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: {
            bvid,
            owner: { mid: 1_809_444_890, name: "三角洲-安澜" },
          },
        }),
      };
    },
  });
  const result = await provider.resolveAuthors([{
    key: `bilibili:video:${bvid}`,
    platform: "bilibili",
    videoIds: [bvid],
  }]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(result.items[0].errors, []);
  assert.deepEqual(result.items[0].candidates[0], {
    platform: "bilibili",
    canonicalId: "1809444890",
    canonicalUrl: "https://space.bilibili.com/1809444890",
    nickname: "三角洲-安澜",
    videoId: bvid,
    sourceEvidenceUrl: `https://www.bilibili.com/video/${bvid}`,
    evidenceUrl: `https://www.bilibili.com/video/${bvid}`,
    endpoint: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    provenance: "bilibili-official-anonymous-view",
  });
  assert.equal(result.provenance.anonymousSessionOnly, true);
  assert.equal(result.provenance.paidAPI, false);
});

test("public-web author resolver keeps Bilibili evidence out of a mixed Douyin helper batch", async () => {
  const bvid = "BV1fi416bEpi";
  const helperInputs = [];
  const execFileImpl = (_file, _args, _options, callback) => ({
    stdin: {
      end(input) {
        const payload = JSON.parse(String(input));
        helperInputs.push(payload);
        callback(null, JSON.stringify({ ok: true, data: {
          items: payload.items.map((item) => ({
            key: item.key,
            candidates: [{ secUid: STRICT_SEC_UID, uniqueId: "douyin-test" }],
            errors: [],
          })),
        } }), "");
      },
    },
  });
  const provider = new PublicWebProvider({}, {
    execFileImpl,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { bvid, owner: { mid: "1809444890", name: "B站作者" } } }),
    }),
  });
  const result = await provider.resolveAuthors([
    { key: `bilibili:video:${bvid}`, platform: "bilibili", videoIds: [bvid] },
    { key: "douyin:test", platform: "douyin", videoIds: ["7679097628281376036"] },
  ]);

  assert.equal(helperInputs.length, 1);
  assert.deepEqual(helperInputs[0].items.map((item) => item.key), ["douyin:test"]);
  assert.doesNotMatch(JSON.stringify(helperInputs[0]), /BV1fi416bEpi/);
  assert.equal(result.items[0].candidates[0].platform, "bilibili");
  assert.equal(result.items[1].candidates[0].uniqueId, "douyin-test");
  assert.equal(result.provenance.mode, "platform-routed-public-evidence");
});

test("public-web author resolver rejects a Bilibili view response for a different BVID", async () => {
  const provider = new PublicWebProvider({}, {
    execFileImpl: () => { throw new Error("Bilibili author resolution must not invoke the Douyin helpers"); },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: { bvid: "BV1xx411c7mD", owner: { mid: "1809444890", name: "错误作品作者" } },
      }),
    }),
  });
  const result = await provider.resolveAuthors([{
    key: "bilibili:video:BV1fi416bEpi",
    platform: "bilibili",
    videoIds: ["BV1fi416bEpi"],
  }]);

  assert.equal(result.items[0].candidates.length, 0);
  assert.match(result.items[0].errors[0].error, /回显 BVID 与请求不一致/);
});

test("public-web author resolver rejects Bilibili evidence without a numeric 2-20 digit owner.mid", async () => {
  const provider = new PublicWebProvider({}, {
    execFileImpl: () => { throw new Error("Bilibili author resolution must not invoke the Douyin helpers"); },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: { bvid: "BV1fi416bEpi", owner: { mid: "invalid-mid", name: "无法核验" } },
      }),
    }),
  });
  const result = await provider.resolveAuthors([{
    key: "bilibili:video:BV1fi416bEpi",
    platform: "bilibili",
    videoIds: ["BV1fi416bEpi"],
  }]);

  assert.equal(result.items[0].candidates.length, 0);
  assert.match(result.items[0].errors[0].error, /2-20 位数字 owner\.mid/);
});

test("public-web author resolver preserves an HTTPS b23 source while proving its canonical Bilibili video", async () => {
  const bvid = "BV1fi416bEpi";
  const sourceEvidenceUrl = "https://b23.tv/safe123";
  const calls = [];
  const provider = new PublicWebProvider({}, {
    execFileImpl: () => { throw new Error("Bilibili author resolution must not invoke the Douyin helpers"); },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === sourceEvidenceUrl) {
        return {
          ok: false,
          status: 302,
          headers: { get: (name) => name.toLowerCase() === "location" ? `https://www.bilibili.com/video/${bvid}?share_source=copy_web` : null },
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { bvid, owner: { mid: "1809444890", name: "安澜" } } }),
      };
    },
  });
  const result = await provider.resolveAuthors([{
    key: `bilibili:share:${sourceEvidenceUrl}`,
    platform: "bilibili",
    shareUrls: [sourceEvidenceUrl],
  }]);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(result.items[0].candidates[0].sourceEvidenceUrl, sourceEvidenceUrl);
  assert.equal(result.items[0].candidates[0].evidenceUrl, `https://www.bilibili.com/video/${bvid}`);
  assert.equal(result.items[0].candidates[0].videoId, bvid);
});

test("public-web author resolver refuses b23 redirects outside trusted Bilibili video hosts", async () => {
  let calls = 0;
  const provider = new PublicWebProvider({}, {
    execFileImpl: () => { throw new Error("Bilibili author resolution must not invoke the Douyin helpers"); },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 302,
        headers: { get: () => "https://example.com/video/BV1fi416bEpi" },
      };
    },
  });
  const result = await provider.resolveAuthors([{
    key: "bilibili:share:unsafe",
    platform: "bilibili",
    shareUrls: ["https://b23.tv/unsafe"],
  }]);

  assert.equal(calls, 1);
  assert.equal(result.items[0].candidates.length, 0);
  assert.match(result.items[0].errors[0].error, /非 bilibili\.com 域名/);
});

test("public-web author resolver sends a bounded batch through the zero-key helper", async () => {
  let capturedInput = null;
  const execFileImpl = (file, args, options, callback) => ({
    stdin: {
      end(input) {
        capturedInput = String(input);
        callback(null, JSON.stringify({ ok: true, data: { items: [{ key: "douyin:test", candidates: [], errors: [] }], provenance: { paidAPI: false } } }), "");
      },
    },
  });
  const provider = new PublicWebProvider({}, { execFileImpl });
  const result = await provider.resolveAuthors([{ key: "douyin:test", name: "测试", douyinId: "test", videoIds: ["7679097628281376036"] }]);
  assert.match(capturedInput, /7679097628281376036/);
  assert.equal(result.items[0].key, "douyin:test");
  assert.equal(result.provenance.paidAPI, false);
});

test("public-web author resolver retries empty browser items through the signed anonymous helper", async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => ({
    stdin: {
      end(input) {
        calls.push({ file, args, input: JSON.parse(String(input)) });
        const isBrowser = file === process.execPath;
        const data = isBrowser
          ? { items: [{ key: "douyin:test", candidates: [], errors: [{ error: "HTTP 200" }] }] }
          : { items: [{ key: "douyin:test", candidates: [{ secUid: "MS4wLjABAAAA_TEST_PUBLIC_FALLBACK", uniqueId: "test" }], errors: [] }] };
        callback(null, JSON.stringify({ ok: true, data }), "");
      },
    },
  });
  const provider = new PublicWebProvider({}, { execFileImpl, authorResolverMode: "browser-first" });
  const result = await provider.resolveAuthors([{ key: "douyin:test", name: "测试", douyinId: "test", videoIds: ["7679097628281376036"] }]);
  assert.equal(calls.length, 2);
  assert.match(calls[1].args.join(" "), /--operation resolve-authors/);
  assert.equal(result.items[0].candidates[0].uniqueId, "test");
  assert.equal(result.provenance.perItemFallback, true);
});

test("public-web author resolution defaults to signed anonymous HTTP without opening a browser", async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => ({
    stdin: {
      end(input) {
        calls.push({ file, args, input: JSON.parse(String(input)) });
        callback(null, JSON.stringify({ ok: true, data: {
          items: [{ key: "douyin:test", candidates: [{ secUid: "MS4wLjABAAAA_SIGNED_DEFAULT", uniqueId: "test" }], errors: [] }],
        } }), "");
      },
    },
  });
  const provider = new PublicWebProvider({}, { execFileImpl });
  const result = await provider.resolveAuthors([{ key: "douyin:test", name: "测试", videoIds: ["7679097628281376036"] }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/python3");
  assert.match(calls[0].args.join(" "), /--operation resolve-authors/);
  assert.equal(result.provenance.mode, "signed-anonymous-public-detail");
});

test("public-web author resolver supports the GitHub-derived signed-only batch route", async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => ({
    stdin: {
      end(input) {
        calls.push({ file, args, input: JSON.parse(String(input)) });
        callback(null, JSON.stringify({ ok: true, data: {
          items: [{ key: "douyin:test", candidates: [{ secUid: "MS4wLjABAAAA_SIGNED_ONLY_TEST", uniqueId: "test" }], errors: [] }],
        } }), "");
      },
    },
  });
  const provider = new PublicWebProvider({}, { execFileImpl, authorResolverMode: "signed-only" });
  const result = await provider.resolveAuthors([{ key: "douyin:test", name: "测试", douyinId: "test", videoIds: ["7679097628281376036"] }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.join(" "), /--operation resolve-authors/);
  assert.equal(result.items[0].candidates[0].uniqueId, "test");
  assert.equal(result.provenance.mode, "signed-anonymous-public-detail");
});

test("public-web hashtag provider is explicitly scoped to monitored account posts", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-pool-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const account = database.createTarget({ type: "account", label: "账号", locator: "MS4wLjX", provider: "manual", metadata: {} });
  const runId = database.beginRun("test", account.id, 1);
  database.saveCollection(account, runId, {
    capturedAt: "2026-08-31T12:00:00Z",
    snapshot: {}, warnings: [], qualityStatus: "validated", raw: {},
    posts: [{ externalId: "P1", authorId: "U1", authorName: "作者", caption: "#三角洲行动 内容", publishedAt: "2026-08-31T11:00:00Z", likes: 12, raw: { text_extra: [{ hashtag_name: "三角洲行动" }] } }],
  });
  database.updateTarget(account.id, { enabled: true });
  const operations = [];
  const provider = new PublicWebProvider({}, { database,
    execFileImpl: () => assert.fail("this account-pool fixture must never launch a real collector"),
  });
  // This fixture proves the local fallback, not live topic search. The former
  // unstubbed call could launch a real helper before falling back to the pool.
  provider.run = async operation => { operations.push(operation); throw new Error("fixture: official search unavailable"); };
  return provider.collect({ id: 2, type: "hashtag", label: "话题", locator: "三角洲行动", metadata: {} }).then((result) => {
    assert.deepEqual(operations, ["hashtag-search"]);
    assert.equal(result.posts.length, 1);
    assert.equal(result.snapshot.totalLikes, null);
    assert.equal(result.qualityStatus, "warning");
    assert.match(result.warnings[0], /已监控账号池/);
  });
});

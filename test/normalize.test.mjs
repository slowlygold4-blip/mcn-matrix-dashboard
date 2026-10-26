import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCollection, normalizeManualCollection, normalizePost, unwrapMcpToolResult } from "../lib/providers/normalize.mjs";

const account = { id: 1, type: "account", label: "测试账号", locator: "demo" };

test("normalizes common Douyin profile and aweme fields", () => {
  const collection = normalizeCollection(account, {
    profile: { data: { user: { follower_count: 1200, total_favorited: 8800, aweme_count: 42 } } },
    works: {
      aweme_list: [{
        aweme_id: "123456",
        desc: "真实标题",
        create_time: 1788184800,
        author: { sec_uid: "sec-a", nickname: "作者A" },
        statistics: { digg_count: 321, comment_count: 22, share_count: 5, collect_count: 11, play_count: 9000 },
      }],
    },
  }, { capturedAt: "2026-08-31T12:00:00.000Z" });
  assert.equal(collection.posts.length, 1);
  assert.equal(collection.posts[0].externalId, "123456");
  assert.equal(collection.posts[0].publishedAt, "2026-08-31T14:00:00.000Z");
  assert.equal(collection.posts[0].likes, 321);
  assert.equal(collection.posts[0].collects, 11);
  assert.equal(collection.snapshot.followers, 1200);
  assert.equal(collection.qualityStatus, "validated");
});

test("missing values remain null and generate warnings instead of zeros", () => {
  const collection = normalizeCollection(account, { works: { aweme_list: [] } });
  assert.equal(collection.snapshot.followers, null);
  assert.equal(collection.posts.length, 0);
  assert.equal(collection.qualityStatus, "warning");
  assert.ok(collection.warnings.length >= 2);
});

test("profile-only account input never fabricates complete works coverage", () => {
  const collection = normalizeManualCollection(account, {
    capturedAt: "2026-08-31T08:30:00+08:00",
    snapshot: { followers: 12, totalLikes: 34 },
  });
  assert.equal(collection.accountStatus, "available");
  assert.equal(collection.worksCoverage, "unknown");
});

test("an explicitly empty works list is complete only when the profile reports zero works", () => {
  const collection = normalizeCollection(account, {
    profile: { user: { follower_count: 12, total_favorited: 34, aweme_count: 0 } },
    works: { aweme_list: [] },
  });
  assert.equal(collection.worksCoverage, "complete");
  assert.equal(collection.qualityStatus, "validated");
});

test("manual import deduplicates later in database but validates structure here", () => {
  const collection = normalizeManualCollection(account, {
    capturedAt: "2026-08-31T08:30:00+08:00",
    snapshot: { followers: 12 },
    posts: [{ id: "x", title: "作品", like_count: 9 }],
  });
  assert.equal(collection.posts[0].externalId, "x");
  assert.equal(collection.posts[0].likes, 9);
});

test("MCP text content is parsed as JSON", () => {
  assert.deepEqual(unwrapMcpToolResult({ result: { content: [{ type: "text", text: "{\"items\":[1]}" }] } }), { items: [1] });
});

test("fallback post id is deterministic when source id is absent", () => {
  const first = normalizePost({ title: "同一作品", published_at: "2026-08-31T10:00:00Z" }, "t");
  const second = normalizePost({ title: "同一作品", published_at: "2026-08-31T10:00:00Z" }, "t");
  assert.equal(first.externalId, second.externalId);
});

test("a nonempty public works sample never substitutes for a missing or invalid account total", () => {
  const works = { aweme_list: [{ aweme_id: "123456", statistics: { digg_count: 8 } }] };
  for (const awemeCount of [undefined, null, "", "unknown", -1]) {
    const raw = { profile: { user: { follower_count: 12, total_favorited: 34, aweme_count: awemeCount } }, works,
      worksCoverage: "latest-public-window" };
    const collection = normalizeCollection(account, raw);
    assert.equal(collection.posts.length, 1);
    assert.equal(collection.snapshot.totalPosts, null);
    assert.equal(collection.worksCoverage, "limited");
    assert.match(collection.warnings.join(" "), /不用作品样本条数替代/);
    assert.equal(raw.profile.user.aweme_count, awemeCount);
  }
});

test("explicit account totals, including zero, remain independent from returned sample size", () => {
  for (const count of [0, 42]) {
    const collection = normalizeCollection(account, {
      profile: { user: { follower_count: 12, total_favorited: 34, aweme_count: count } },
      works: { aweme_list: [{ aweme_id: "123456", statistics: { digg_count: 8 } }] },
      worksCoverage: "limited",
    });
    assert.equal(collection.snapshot.totalPosts, count);
    assert.equal(collection.posts.length, 1);
  }
});

test("hashtag samples never become an account-like cumulative likes metric", () => {
  const collection = normalizeCollection({ id: 8, type: "hashtag", label: "#话题" }, {
    works: { aweme_list: [{ aweme_id: "topic-post", statistics: { digg_count: 88 } }] },
  });
  assert.equal(collection.snapshot.totalLikes, null);
  assert.equal(collection.snapshot.hashtagParticipants, null);
  assert.equal(collection.snapshot.hashtagViews, null);
  assert.equal(collection.posts.length, 1, "局部作品仍保留为来源证据");
});

test("manual works import also requires an explicit cumulative account total", () => {
  for (const totalPosts of [undefined, null, "invalid", 0, 42]) {
    const collection = normalizeManualCollection(account, {
      capturedAt: "2026-09-13T13:00:00Z", snapshot: { followers: 12, totalPosts },
      posts: [{ id: "x", title: "作品", like_count: 9 }],
    });
    assert.equal(collection.snapshot.totalPosts, [0, 42].includes(totalPosts) ? totalPosts : null);
    assert.equal(collection.posts.length, 1);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { checksum } from "../lib/utils.mjs";
import { MonitorDatabase } from "../lib/database.mjs";

const USER = "619e0b66000000001000e923";
const OTHER = "519e0b66000000001000e923";
const NOTE = "68e66fef0000000004023fdb";
const target = { id: 3, type: "account", label: "作者红", locator: `https://www.xiaohongshu.com/user/profile/${USER}`, metadata: { platform: "xiaohongshu" } };

function fixture({ fans = "12345", interaction = "3.4万", likedCount = "123", notes = true, noteId = NOTE, returnedId = USER, extraInteractions = [], profileExtra = {}, htmlTransform = value => value } = {}) {
  const state = { user: { userPageData: { basicInfo: { nickname: "作者红" },
    interactions: [{ type: "fans", name: "粉丝", count: fans }, { type: "interaction", name: "获赞与收藏", count: interaction }, ...extraInteractions],
    ...profileExtra, result: { success: true } }, noteQueries: [{ userId: returnedId }], notes: notes ? [[{ id: noteId,
      noteCard: { displayTitle: "公开笔记", time: 1788184800000, user: { userId: returnedId, nickname: "作者红" }, interactInfo: { likedCount } } }]] : [] } };
  const html = htmlTransform(`<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`);
  const calls = [];
  const provider = new PublicWebProvider({ publicPostsPerAccount: "3" }, {
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, text: async () => html }; },
    execFileImpl: () => { throw new Error("no subprocess or platform request allowed in this fixture"); },
  });
  return { calls, collect: () => provider.collect(target) };
}

test("XHS abbreviated/approximate/fractional/unsafe counters never become precise followers or note likes", async () => {
  for (const value of ["3.4万", "2千", "1亿", "1万+", "约123", "123+", "1.2", 1.2,
    -1, "-1", "1e3", "0x10", "12,34", ",123", "123,", "1,,234", "01,234", "0,001",
    "9,007,199,254,740,992", "9007199254740993", Number.MAX_SAFE_INTEGER + 1, null, "", " ", true, [123], { total_favorited: 123 }]) {
    const result = await fixture({ fans: value, likedCount: value }).collect();
    assert.equal(result.snapshot.followers, null, `fans ${JSON.stringify(value)}`);
    assert.equal(result.posts[0].likes, null, `likes ${JSON.stringify(value)}`);
  }
});

test("XHS complete safe integers, canonical thousands grouping, max-safe and real zero remain exact", async () => {
  for (const [value, expected] of [[0, 0], ["0", 0], ["00012", 12], [" 123 ", 123], ["1,234", 1234], ["12,345,678", 12345678],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], ["9,007,199,254,740,991", Number.MAX_SAFE_INTEGER]]) {
    const result = await fixture({ fans: value, likedCount: value }).collect();
    assert.equal(result.snapshot.followers, expected); assert.equal(result.posts[0].likes, expected);
  }
});

test("XHS likes-and-collects total is not cumulative account likes, even when exact or zero", async () => {
  for (const interaction of ["34000", 34000, "0", 0, "3.4万"]) {
    const result = await fixture({ interaction }).collect();
    assert.equal(result.snapshot.totalLikes, null);
    assert.equal(result.raw.profile.user.total_favorited, null);
    assert.equal(result.snapshot.totalPosts, null);
    assert.equal(result.posts[0].likes, 123);
    assert.match(result.warnings.join("；"), /获赞与收藏.*合计.*未.*累计获赞/);
    assert.equal(result.raw.publicObservations.accountInteractions[1].count, interaction);
    assert.equal(result.raw.publicObservations.accountInteractions[1].metric, "likes-and-collects");
  }
});

test("unknown independent-looking profile counters are not guessed into a new account-likes contract", async () => {
  const result = await fixture({ extraInteractions: [{ type: "likes", count: 555 }],
    profileExtra: { totalLikes: 999, total_favorited: 888, nested: { liked_count: 777 } } }).collect();
  assert.equal(result.snapshot.totalLikes, null);
  assert.equal(result.snapshot.totalPosts, null);
});

test("original observations are retained outside normalization, included in checksum, and never fill missing metrics", async () => {
  const injected = { follower_count: 999, total_favorited: 888, aweme_count: 777,
    aweme_list: [{ aweme_id: "not-a-real-note", statistics: { digg_count: 666 } }] };
  const result = await fixture({ fans: injected, interaction: "3.4万", notes: false }).collect();
  assert.equal(result.snapshot.followers, null);
  assert.equal(result.snapshot.totalLikes, null);
  assert.equal(result.snapshot.totalPosts, null);
  assert.deepEqual(result.posts, []);
  assert.deepEqual(result.raw.publicObservations.accountInteractions[0].count, injected);
  assert.equal(result.sourceChecksum, checksum(result.raw));
  const { publicObservations, ...withoutObservations } = result.raw;
  assert.notEqual(result.sourceChecksum, checksum(withoutObservations));
  assert.equal(publicObservations.observedAt, result.capturedAt);
  assert.equal(result.raw.capturedAt, result.capturedAt);
});

test("note like observation preserves its original abbreviated text while normalized value stays null", async () => {
  const result = await fixture({ fans: "1.2万", likedCount: "2.3万" }).collect();
  assert.equal(result.raw.publicObservations.accountInteractions[0].count, "1.2万");
  assert.equal(result.raw.publicObservations.notes[0].likedCount, "2.3万");
  assert.equal(result.raw.publicObservations.notes[0].noteId, NOTE);
  assert.equal(result.posts[0].likes, null);
  assert.match(result.warnings.join("；"), /笔记.*点赞.*未按精确值/);
});

test("different rejected original observations cannot share a normalized-source fingerprint", async () => {
  const first = await fixture({ fans: "1.2万", interaction: "3.4万", likedCount: "2.3万" }).collect();
  const second = await fixture({ fans: "1.3万", interaction: "3.5万", likedCount: "2.4万" }).collect();
  const sameTime = raw => ({ ...raw, capturedAt: "2026-09-01T12:00:00.000Z", warnings: [],
    publicObservations: { ...raw.publicObservations, observedAt: "2026-09-01T12:00:00.000Z" } });
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.notEqual(checksum(sameTime(first.raw)), checksum(sameTime(second.raw)));
});

test("XHS identity mismatch still rejects before a collection exists; original note time is not rewritten", async () => {
  await assert.rejects(fixture({ returnedId: OTHER }).collect(), /身份校验失败/);
  const f = fixture(); const before = Date.now(); const result = await f.collect(); const after = Date.now();
  assert.ok(Date.parse(result.capturedAt) >= before && Date.parse(result.capturedAt) <= after);
  assert.equal(result.posts[0].publishedAt, new Date(1788184800000).toISOString());
  assert.equal(result.verifiedIdentity.accountId, USER);
  assert.equal(result.raw.provenance.authenticated, false);
  assert.equal(f.calls.length, 1);
});

test("XHS initial-state notes are only a public window, never evidence of complete works", async () => {
  const partial = await fixture().collect();
  assert.equal(partial.raw.worksCoverage, "latest-public-window");
  assert.equal(partial.worksCoverage, "limited");
  const empty = await fixture({ notes: false }).collect();
  assert.equal(empty.raw.worksCoverage, "unavailable");
  assert.equal(empty.worksCoverage, "unavailable");
  assert.equal(empty.snapshot.totalPosts, null);
});

test("XHS missing or invalid stable note identity is skipped, not replaced by a synthetic hash ID", async () => {
  for (const noteId of [null, "", "unknown", "xhs-synthetic", "../../etc/passwd", "g".repeat(24), 1234567890123456]) {
    const result = await fixture({ noteId }).collect();
    assert.deepEqual(result.posts, [], String(noteId));
    assert.equal(result.worksCoverage, "unavailable");
    assert.match(result.warnings.join("；"), /笔记.*ID.*跳过/);
    assert.equal(result.raw.publicObservations.notes[0].noteId, noteId);
  }
  for (const noteId of ["a".repeat(16), "b".repeat(40), NOTE]) {
    const result = await fixture({ noteId }).collect(); assert.equal(result.posts[0].externalId, noteId);
  }
});

test("isolated XHS persistence keeps raw observations/hash and never inserts missing-ID notes", async t => {
  const database = new MonitorDatabase(":memory:"); t.after(() => database.close());
  const account = database.createTarget({ ...target, provider: "public-web" });
  const runId = database.beginRun("test", account.id, 1);
  const result = await fixture({ noteId: null, fans: "1.2万", interaction: "34567" }).collect();
  database.saveCollection(account, runId, result);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM posts").get().count, 0);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM post_metrics").get().count, 0);
  const saved = database.db.prepare("SELECT followers,total_likes,total_posts,works_coverage,source_checksum,raw_json FROM snapshots").get();
  assert.equal(saved.followers, null); assert.equal(saved.total_likes, null); assert.equal(saved.total_posts, null);
  assert.equal(saved.works_coverage, "unavailable");
  const raw = JSON.parse(saved.raw_json);
  assert.equal(raw.publicObservations.accountInteractions[0].count, "1.2万");
  assert.equal(raw.publicObservations.accountInteractions[1].count, "34567");
  assert.equal(saved.source_checksum, checksum(raw));
});

test("a later imprecise XHS observation adds null metrics without erasing exact stored note likes or prior history", async t => {
  const database = new MonitorDatabase(":memory:"); t.after(() => database.close());
  const account = database.createTarget({ ...target, provider: "public-web" });
  const stamp = (result, at) => {
    result.capturedAt = at; result.raw.capturedAt = at; result.raw.publicObservations.observedAt = at;
    result.sourceChecksum = checksum(result.raw); return result;
  };
  const first = stamp(await fixture({ fans: "12345", likedCount: "123" }).collect(), "2026-09-01T12:00:00.000Z");
  database.saveCollection(account, database.beginRun("test", account.id, 1), first);
  const firstRow = { ...database.db.prepare("SELECT * FROM snapshots ORDER BY id LIMIT 1").get() };
  const second = stamp(await fixture({ fans: "1.3万", likedCount: "2.3万" }).collect(), "2026-09-02T12:00:00.000Z");
  database.saveCollection(account, database.beginRun("test", account.id, 1), second);
  assert.deepEqual({ ...database.db.prepare("SELECT * FROM snapshots ORDER BY id LIMIT 1").get() }, firstRow);
  assert.equal(database.db.prepare("SELECT likes FROM posts").get().likes, 123);
  const metrics = database.db.prepare("SELECT likes FROM post_metrics ORDER BY captured_at").all();
  assert.deepEqual(metrics.map(row => row.likes), [123, null]);
  const latest = database.db.prepare("SELECT followers,total_likes,works_coverage FROM snapshots ORDER BY id DESC LIMIT 1").get();
  assert.equal(latest.followers, null); assert.equal(latest.total_likes, null); assert.equal(latest.works_coverage, "limited");
});

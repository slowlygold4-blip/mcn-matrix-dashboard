import assert from "node:assert/strict";
import test from "node:test";
import { MonitorDatabase } from "../lib/database.mjs";
import { getAccountInsight, getProductInsights } from "../lib/product-insights.mjs";
import { normalizeCollection } from "../lib/providers/normalize.mjs";
import { checksum } from "../lib/utils.mjs";

const at = (date, hour = 12) => new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`).toISOString();
const reference = new Date(at("2026-09-13", 18));
const optionsThrough = (endDate) => ({ period: "custom", startDate: "2026-09-01", endDate, reference });

function fixture(t) {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const account = (name, metadata = {}) => {
    const target = database.createTarget({
      type: "account", label: name, locator: `MS4wLjABAAAA${name}KnownIdentity12345`, provider: "public-web",
      metadata: { platform: "douyin", douyinId: "00012345", submittedName: `原始${name}`, ...metadata },
      boards: ["测试板块"],
    });
    database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", target.id);
    database.db.prepare("UPDATE target_boards SET created_at=? WHERE target_id=?").run("2020-01-01T00:00:00.000Z", target.id);
    return target;
  };
  const sample = (target, date, { publicId = "00012345", values = [100, 200, 3], hour = 12, verified = false } = {}) => {
    const capturedAt = at(date, hour);
    const raw = {
      capturedAt,
      profile: { user: { sec_uid: target.locator, uid: "222523170759696", nickname: target.label,
        ...(publicId === null ? {} : { unique_id: publicId }),
        follower_count: values[0], total_favorited: values[1], aweme_count: values[2] } },
      works: { aweme_list: [] },
      provenance: { mode: "guest-ttwid-unsigned-profile-a-bogus-posts", accountLocator: "sec_uid",
        cookiePersisted: false, runtimeAI: false, paidAPI: false },
    };
    const collection = normalizeCollection(target, raw, { capturedAt });
    if (verified) collection.verifiedIdentity = { platform: "douyin", accountId: target.locator, mode: "official-public-profile-identity" };
    database.saveCollection(target, null, collection);
    return raw;
  };
  const deleted = (target, observedAt) => {
    const raw = { capturedAt: observedAt, profile: { user: { uid: "222523170759696", user_deleted: true,
      special_state_info: { title: "账号已经注销", content: "用户已将自己账号注销，所属内容已无法查看", special_state: 1 } } } };
    database.recordAccountLifecycle(target, null, {
      state: "deleted", requestedAccountId: target.locator, source: "official-public-profile",
      observedAt, sourceChecksum: checksum(raw), reason: "官方主页显示账号已注销",
    }, raw);
  };
  const alias = (target, observedAt, newId = "New_Public_ID") => {
    const raw = { capturedAt: observedAt, profile: { user: { sec_uid: target.locator, uid: "222523170759696", unique_id: newId } } };
    const event = { type: "douyin-account-alias-change", version: 1, targetId: target.id,
      submittedAccountId: target.metadata.douyinId, previousPublicAccountId: target.metadata.douyinId,
      currentPublicAccountId: newId, canonicalAccountId: target.locator, uid: "222523170759696",
      currentRawSha256: checksum(raw), observedAt, verifiedAt: observedAt };
    database.storeAccountEvent(target, null, "alias", `${observedAt}:${newId}`, event, raw);
  };
  return { database, account, sample, deleted, alias };
}

function listAndDetail(database, target, options = { reference }) {
  const result = getProductInsights(database, options);
  const list = result.accounts.find((value) => value.id === target.id);
  const detail = getAccountInsight(database, target.id, options).account;
  for (const key of ["id", "label", "publicId", "submittedName", "submittedAccountId", "enabled", "lifecycle", "identityAliases"]) {
    assert.deepEqual(list[key], detail[key], `list/detail must agree on ${key}`);
  }
  for (const key of ["key", "label", "stale", "lastAttemptAt", "lastSuccessAt"]) {
    assert.deepEqual(list.status[key], detail.status[key], `list/detail status must agree on ${key}`);
  }
  for (const metric of ["followers", "likes", "posts", "estimatedPlays"]) {
    assert.equal(list.metrics[metric].value, detail.metrics[metric].value);
  }
  return { result, list, detail };
}

test("historical date ranges never reveal later lifecycle, alias or public-ID observations", (t) => {
  const { database, account, sample, deleted, alias } = fixture(t);
  const target = account("date-cutoff", { resolution: { publicDouyinId: "Future_Public_ID" } });
  sample(target, "2026-09-01");
  alias(target, at("2026-09-07"), "Future_Public_ID");
  sample(target, "2026-09-07", { publicId: "Future_Public_ID", values: [150, 500, 4] });
  deleted(target, at("2026-09-08"));
  const { detail, result } = listAndDetail(database, target, optionsThrough("2026-09-05"));
  assert.equal(detail.publicId, "00012345");
  assert.equal(detail.lifecycle, null);
  assert.deepEqual(detail.identityAliases, []);
  assert.equal(detail.metrics.followers.value, 100);
  assert.equal(result.summary.inactiveCount, 0);
  const current = listAndDetail(database, target).detail;
  assert.equal(current.lifecycle.state, "deleted");
  assert.equal(current.identityAliases.length, 1);
  assert.equal(current.publicId, "Future_Public_ID");
});

test("missing historical public-ID observations never fall back to undated future resolution metadata", (t) => {
  const { database, account, sample } = fixture(t);
  const target = account("missing-old-id", { resolution: { publicDouyinId: "Future_Metadata_ID", publicAccountId: "Other_Future_ID" } });
  sample(target, "2026-09-01", { publicId: null });
  sample(target, "2026-09-07", { publicId: "Future_Public_ID" });
  const { detail } = listAndDetail(database, target, optionsThrough("2026-09-05"));
  assert.equal(detail.publicId, "00012345");
  assert.equal(detail.submittedAccountId, "00012345");
});

test("mutable metadata cannot manufacture a deleted lifecycle or accepted alias history", (t) => {
  const { database, account, sample } = fixture(t);
  const fakeAlias = { currentPublicAccountId: "Forged", observedAt: at("2026-09-01") };
  const target = account("metadata-forgery", {
    lifecycle: { state: "deleted" }, accountLifecycle: { state: "deleted" },
    identityAliases: [fakeAlias], identityAliasEvents: [fakeAlias], currentPublicAccountId: "Forged",
  });
  sample(target, "2026-09-13");
  const { detail, result } = listAndDetail(database, target);
  assert.equal(detail.lifecycle, null);
  assert.deepEqual(detail.identityAliases, []);
  assert.equal(detail.publicId, "00012345");
  assert.equal(detail.status.key, "updated");
  assert.equal(result.summary.inactiveCount, 0);
});

test("deleted enabled accounts retain genuine old metrics without zero fill and are separate from stale totals", (t) => {
  const { database, account, sample, deleted } = fixture(t);
  const target = account("deleted-keeps-data");
  sample(target, "2026-09-01", { values: [100, 0, 2] });
  const previous = database.db.prepare("SELECT * FROM snapshots WHERE target_id=?").get(target.id);
  deleted(target, at("2026-09-08"));
  const changes = database.db.prepare("SELECT total_changes() AS n").get().n;
  const { detail, result } = listAndDetail(database, target);
  assert.equal(detail.enabled, true);
  assert.equal(detail.status.key, "deleted");
  assert.equal(detail.metrics.followers.value, 100);
  assert.equal(detail.metrics.likes.value, 0);
  assert.equal(detail.metrics.estimatedPlays.value, 0);
  assert.equal(detail.metrics.posts.value, 2);
  assert.equal(detail.metrics.followers.currentAt, at("2026-09-01"));
  assert.equal(detail.trend.at(-1).followers, null);
  assert.equal(result.summary.inactiveCount, 1);
  assert.equal(result.summary.staleCount, 0);
  assert.equal(result.summary.metrics.followers.value, 100);
  assert.equal(result.boards.find((value) => value.name === "测试板块").inactiveCount, 1);
  assert.deepEqual(database.db.prepare("SELECT * FROM snapshots WHERE target_id=?").get(target.id), previous);
  assert.equal(database.db.prepare("SELECT total_changes() AS n").get().n, changes);
});

test("pause and deletion are independent while aggregate metrics include enabled members only", (t) => {
  const { database, account, sample, deleted } = fixture(t);
  const enabled = account("enabled-deleted");
  const paused = account("paused-deleted");
  sample(enabled, "2026-09-01", { values: [100, 200, 3] });
  sample(paused, "2026-09-01", { values: [900, 800, 7] });
  deleted(enabled, at("2026-09-08"));
  deleted(paused, at("2026-09-08"));
  const pausedAt = at("2026-09-10", 12);
  database.db.prepare("UPDATE targets SET enabled=0,updated_at=? WHERE id=?").run(pausedAt, paused.id);
  const beforePause = listAndDetail(database, paused, {
    period: "day", reference: new Date(Date.parse(pausedAt) - 1),
  });
  assert.equal(beforePause.detail.enabled, true, "a later pause must not remove the historical enabled member");
  assert.equal(beforePause.detail.lifecycle.state, "deleted", "deletion remains independent of pause timing");
  assert.equal(beforePause.result.summary.enabledCount, 2);
  assert.equal(beforePause.result.summary.metrics.followers.value, 1000);
  const atPause = listAndDetail(database, paused, { period: "day", reference: new Date(pausedAt) });
  assert.equal(atPause.detail.enabled, false, "the pause takes effect at its exact recorded update time");
  assert.equal(atPause.result.summary.enabledCount, 1);
  assert.equal(atPause.result.summary.metrics.followers.value, 100);
  const { detail, result } = listAndDetail(database, paused);
  assert.equal(detail.enabled, false);
  assert.equal(detail.lifecycle.state, "deleted");
  assert.equal(detail.metrics.followers.value, 900);
  assert.equal(result.summary.accountCount, 2);
  assert.equal(result.summary.enabledCount, 1);
  assert.equal(result.summary.pausedCount, 1);
  assert.equal(result.summary.inactiveCount, 1);
  assert.equal(result.summary.staleCount, 0);
  assert.equal(result.summary.metrics.followers.value, 100);
});

test("verified fresh recovery supersedes deletion only after its observed time and keeps earlier evidence", (t) => {
  const { database, account, sample, deleted } = fixture(t);
  const target = account("recovered");
  sample(target, "2026-09-01", { values: [100, 200, 3] });
  deleted(target, at("2026-09-08"));
  sample(target, "2026-09-13", { publicId: "Recovered_ID", values: [125, 300, 4], verified: true });
  const historical = listAndDetail(database, target, optionsThrough("2026-09-09")).detail;
  assert.equal(historical.lifecycle.state, "deleted");
  assert.equal(historical.metrics.followers.value, 100);
  assert.equal(historical.publicId, "00012345");
  const { detail, result } = listAndDetail(database, target);
  assert.equal(detail.lifecycle.state, "active");
  assert.equal(detail.status.key, "updated");
  assert.equal(detail.metrics.followers.value, 125);
  assert.equal(result.summary.inactiveCount, 0);
  assert.equal(result.summary.updatedCount, 1);
  assert.equal(database.db.prepare("SELECT COUNT(*) n FROM snapshots WHERE target_id=?").get(target.id).n, 2);
  assert.equal(database.db.prepare("SELECT COUNT(*) n FROM account_events WHERE target_id=? AND event_type='lifecycle'").get(target.id).n, 2);
});

test("precise reference cutoff includes same-time events and excludes even one-millisecond-later aliases", (t) => {
  const { database, account, sample, deleted, alias } = fixture(t);
  const target = account("exact-cutoff");
  sample(target, "2026-09-12");
  const cutoff = at("2026-09-13", 10);
  deleted(target, cutoff);
  alias(target, new Date(Date.parse(cutoff) + 1).toISOString(), "One_Millisecond_Future");
  const { detail } = listAndDetail(database, target, { period: "day", reference: new Date(cutoff) });
  assert.equal(detail.lifecycle.state, "deleted");
  assert.deepEqual(detail.identityAliases, []);
  assert.equal(detail.publicId, "00012345");
});

test("original submitted leading zeros and name remain intact after a public alias change", (t) => {
  const { database, account, sample, alias } = fixture(t);
  const target = account("leading-zero", { douyinId: "0000012345", submittedName: "原表作者名" });
  sample(target, "2026-09-01", { publicId: "0000012345" });
  alias(target, at("2026-09-12"), "New_Name_123");
  sample(target, "2026-09-13", { publicId: "New_Name_123" });
  const { detail } = listAndDetail(database, target);
  assert.equal(detail.submittedAccountId, "0000012345");
  assert.equal(typeof detail.submittedAccountId, "string");
  assert.equal(detail.submittedName, "原表作者名");
  assert.equal(detail.identityAliases[0].submittedAccountId, "0000012345");
  assert.equal(detail.publicId, "New_Name_123");
});

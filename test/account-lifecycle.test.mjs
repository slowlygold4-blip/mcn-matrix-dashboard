import test from "node:test";
import assert from "node:assert/strict";
import { getDouyinLifecycleEvidence } from "../lib/account-lifecycle.mjs";
import { checksum } from "../lib/utils.mjs";

const secUid = "MS4wLjABAAAAhzyETsDJmdmaouNNJSRu8wXsZ1--d1_rOW_A8PCS00CiV7wqMSDoitsAgba8ZuXD";
const otherSecUid = "MS4wLjABAAAAGOutjbYQGhvbNHkv6oDA_2RvlfQQZofr-4ZfESy2v042SJB2X0b7C_s6PaeD2nWS";
const observedAt = "2026-09-13T13:01:00.000Z";

function fixture() {
  return {
    target: { id: 748, type: "account", provider: "public-web", locator: secUid, enabled: true, metadata: { platform: "douyin" } },
    raw: {
      capturedAt: "2026-09-13T13:00:59Z",
      accountStatus: "unavailable",
      worksCoverage: "not-applicable",
      profile: { user: { uid: "1804730793743083", nickname: "" } },
      profileResponse: {
        status_code: 0,
        user: {
          uid: "1804730793743083",
          nickname: "",
          user_deleted: true,
          special_state_info: {
            content: "用户已将自己账号注销，所属内容已无法查看",
            special_state: 1,
            title: "账号已经注销",
          },
        },
      },
      provenance: {
        mode: "guest-ttwid-unsigned-profile-lifecycle",
        profileMode: "guest-ttwid-unsigned-profile",
        profileEndpoint: "https://www.douyin.com/aweme/v1/web/user/profile/other/",
        accountLocator: "sec_uid",
        runtimeAI: false,
        paidAPI: false,
        cookiePersisted: false,
      },
    },
    transport: { provider: "public-web", operation: "account", requestedAccountId: secUid, observedAt },
  };
}

function result({ target, raw, transport }) {
  return getDouyinLifecycleEvidence(target, raw, transport);
}

test("explicit official deletion without sec_uid only attests the requested profile, with exact retained JSON hashes", () => {
  const input = fixture();
  const original = structuredClone(input);
  const evidence = result(input);
  assert.equal(evidence.state, "deleted");
  assert.equal(evidence.platform, "douyin");
  assert.equal(evidence.requestedAccountId, secUid);
  assert.equal(evidence.reportedUid, "1804730793743083");
  assert.equal(evidence.observedAt, observedAt);
  assert.equal(evidence.sourceChecksum, checksum(input.raw));
  assert.equal(evidence.profileResponseChecksum, checksum(input.raw.profileResponse));
  assert.equal(evidence.checksumScope, "collector-envelope-json");
  assert.equal(evidence.source, "official-public-profile");
  assert.equal(evidence.scope, "requested-public-profile");
  assert.equal(evidence.identityVerified, false);
  assert.equal(evidence.evidenceFields.secUidEchoed, false);
  assert.equal(evidence.evidenceFields.secUidMatchesRequest, null);
  assert.match(evidence.reason, /未回显 sec_uid/);
  assert.deepEqual(input, original, "read-only helper does not change input, enablement or metrics");
  assert.equal("snapshot" in evidence, false);
  assert.equal("enabled" in evidence, false);
  assert.equal("verifiedIdentity" in evidence, false);
  input.raw.profileResponse.user.special_state_info.title = "changed later";
  assert.equal(evidence.evidenceFields.title, "账号已经注销", "evidence does not retain mutable raw object references");
});

test("matching sec_uid is stated separately from identity verification", () => {
  const input = fixture();
  input.raw.profileResponse.user.sec_uid = secUid;
  input.raw.profile.user.sec_uid = secUid;
  const evidence = result(input);
  assert.equal(evidence.evidenceFields.reportedSecUid, secUid);
  assert.equal(evidence.evidenceFields.secUidEchoed, true);
  assert.equal(evidence.evidenceFields.secUidMatchesRequest, true);
  assert.equal(evidence.identityVerified, false);
});

test("signed compatibility profile and explicit user_info response are supported", () => {
  const input = fixture();
  input.raw.provenance.profileMode = "guest-ttwid-unsigned-profile-with-x-bogus-fallback";
  input.raw.profileResponse.user_info = input.raw.profileResponse.user;
  delete input.raw.profileResponse.user;
  input.transport.observedAt = "2026-09-13T13:01:00Z";
  const evidence = result(input);
  assert.equal(evidence.state, "deleted");
  assert.equal(evidence.evidenceFields.responseUserField, "user_info");
  assert.equal(evidence.observedAt, observedAt);
});

test("trusted transport must be supplied separately and cannot be self-asserted in raw or metadata", () => {
  const input = fixture();
  input.raw.transport = input.transport;
  input.target.metadata.transport = input.transport;
  assert.equal(getDouyinLifecycleEvidence(input.target, input.raw), null);
  for (const patch of [
    { provider: "manual" }, { operation: "resolve-authors" },
    { requestedAccountId: otherSecUid }, { observedAt: null },
    { observedAt: "invalid" }, { observedAt: "2026-02-30T13:01:00Z" },
    { observedAt: "2026-09-13T13:01:00" },
  ]) {
    assert.equal(result({ ...input, transport: { ...input.transport, ...patch } }), null);
  }
});

test("only public-web Douyin account targets with a bare valid locator qualify, never nickname inference", () => {
  for (const patch of [
    { type: "keyword" }, { provider: "manual" }, { platform: "bilibili" },
    { metadata: { platform: "xiaohongshu" } }, { locator: "" },
    { locator: "已注销用户" }, { locator: "66333928448" },
    { locator: `https://www.douyin.com/user/${secUid}` },
    { locator: ` ${secUid}` }, { locator: `${secUid}\n` },
    { locator: "MS4wLj_short" }, { locator: `MS4wLj${"a".repeat(221)}` },
  ]) {
    const input = fixture();
    input.target = { ...input.target, ...patch };
    input.transport.requestedAccountId = input.target.locator;
    assert.equal(result(input), null, JSON.stringify(patch));
  }
  const inferred = fixture();
  delete inferred.target.metadata.platform;
  assert.equal(result(inferred).state, "deleted", "valid bare sec_uid can identify platform, not author identity");
});

test("all source provenance checks fail closed for missing or different source routes", () => {
  for (const patch of [
    { profileMode: undefined }, { profileMode: "manual" },
    { profileEndpoint: "https://example.com/aweme/v1/web/user/profile/other/" },
    { profileEndpoint: "https://www.douyin.com/aweme/v1/web/user/profile/other/?spoof=true" },
    { accountLocator: "nickname" }, { runtimeAI: true },
    { runtimeAI: undefined }, { paidAPI: true }, { paidAPI: undefined },
  ]) {
    const input = fixture();
    Object.assign(input.raw.provenance, patch);
    assert.equal(result(input), null, JSON.stringify(patch));
  }
});

test("empty, sanitized, private, login-limited or nonzero responses never imply deletion", () => {
  for (const response of [
    null, {}, [], { user: {} }, { status_code: 0, user: {} },
    { status_code: 0, user: { secret: 1, nickname: "私密用户" } },
    { status_code: 0, user: { aweme_count: 0, follower_count: 0 } },
  ]) {
    const input = fixture();
    input.raw.profileResponse = response;
    assert.equal(result(input), null);
  }
  const sanitized = fixture();
  delete sanitized.raw.profileResponse;
  sanitized.raw.profile.user.user_deleted = true;
  assert.equal(result(sanitized), null, "legacy sanitized profile lacks original official status");
  for (const status of [undefined, null, false, "0", 1, 8, 1024]) {
    const input = fixture();
    input.raw.profileResponse.status_code = status;
    assert.equal(result(input), null);
  }
  for (const patch of [
    { need_login: true }, { login_required: 1 }, { captcha_required: true },
    { not_login_module: {} }, { status_msg: "请登录后查看" }, { message: "captcha required" },
  ]) {
    const input = fixture();
    Object.assign(input.raw.profileResponse, patch);
    assert.equal(result(input), null, "contradictory access restriction cannot be promoted to lifecycle evidence");
  }
});

test("user_deleted needs an exact boolean and an independent explicit special-state signal", () => {
  for (const deleted of [undefined, null, false, 0, 1, "true"]) {
    const input = fixture();
    input.raw.profileResponse.user.user_deleted = deleted;
    assert.equal(result(input), null);
  }
  for (const special of [
    undefined, null, {}, { special_state: 1 },
    { special_state: "1", title: "账号已经注销" },
    { special_state: 0, title: "账号已经注销" },
    { special_state: 1, title: "账号已封禁" },
    { special_state: 1, title: "账号未注销", content: "如何注销账号" },
    { special_state: 1, title: "账号已经注销了吗" },
  ]) {
    const input = fixture();
    input.raw.profileResponse.user.special_state_info = special;
    assert.equal(result(input), null);
  }
  const contentOnly = fixture();
  contentOnly.raw.profileResponse.user.special_state_info.title = "";
  assert.equal(result(contentOnly).state, "deleted");
});

test("any conflicting sec_uid rejects lifecycle even if another branch contains a deletion signal", () => {
  for (const mutate of [
    (input) => { input.raw.profileResponse.user.sec_uid = otherSecUid; },
    (input) => { input.raw.profileResponse.user.secUid = otherSecUid; },
    (input) => { input.raw.profile.user.sec_uid = otherSecUid; },
    (input) => { input.raw.profile.user_info = { sec_uid: otherSecUid }; },
    (input) => { input.raw.profileResponse.user.sec_uid = 1; },
    (input) => { input.raw.profileResponse.user_info = { ...input.raw.profileResponse.user }; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(result(input), null);
  }
});

test("UID is optional reported context only and unsafe numeric or malformed values are not asserted", () => {
  for (const uid of [undefined, null, "", "-123", "uid=123", Number.MAX_SAFE_INTEGER + 1]) {
    const input = fixture();
    input.raw.profileResponse.user.uid = uid;
    assert.equal("reportedUid" in result(input), false);
  }
  const numeric = fixture();
  numeric.raw.profileResponse.user.uid = 123456789;
  assert.equal(result(numeric).reportedUid, "123456789");
});

test("lifecycle evidence is independent of enablement and metric values and never changes them", () => {
  const input = fixture();
  input.target.enabled = false;
  input.target.metadata.douyinId = "retained-original-id";
  input.raw.profile.user.follower_count = 0;
  input.raw.profile.user.total_favorited = 0;
  const original = structuredClone(input);
  const evidence = result(input);
  assert.equal(evidence.state, "deleted");
  assert.deepEqual(input, original);
  assert.equal("followers" in evidence, false);
  assert.equal("likes" in evidence, false);
  assert.equal("posts" in evidence, false);
});

test("malformed values fail closed without throwing", () => {
  for (const value of [null, undefined, [], "text", 42]) {
    const input = fixture();
    assert.equal(getDouyinLifecycleEvidence(value, input.raw, input.transport), null);
    assert.equal(getDouyinLifecycleEvidence(input.target, value, input.transport), null);
    assert.equal(getDouyinLifecycleEvidence(input.target, input.raw, value), null);
  }
  const input = fixture();
  input.raw.self = input.raw;
  assert.equal(result(input), null, "non-JSON cycles cannot produce a valid checksum");
});

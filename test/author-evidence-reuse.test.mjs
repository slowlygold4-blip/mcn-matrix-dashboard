import test from "node:test";
import assert from "node:assert/strict";
import { reusableStoredAuthorEvidence } from "../lib/author-evidence-reuse.mjs";

const SEC_UID = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const OTHER_SEC_UID = "MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba";
const VIDEO = "7684617087687331118";
const SHARE = "https://v.douyin.com/Cu0tbcEzFXY/?a=Case";

function fixture() {
  const prior = {
    id: 10, identity_key: `douyin:Public_ID|video:${VIDEO}`, douyin_id: "Public_ID", account_locator: "",
    video_ids_json: JSON.stringify([VIDEO]), share_urls_json: JSON.stringify([SHARE]),
    status: "resolved", resolved_target_id: 20, verification_policy_version: 2, evidence_version: 3,
    updated_at: "2026-09-13T08:00:00.000Z", lease_owner: null, lease_until: null,
    suspended_target_enabled: null,
  };
  const incoming = {
    ...prior, id: 11, identity_key: `douyin:account:${SEC_UID}|video:${VIDEO}`, account_locator: SEC_UID,
    status: "pending", resolved_target_id: null,
  };
  const target = {
    id: 20, type: "account", provider: "public-web", locator: SEC_UID, enabled: 0,
    metadata_json: JSON.stringify({ platform: "douyin", resolution: {
      platform: "douyin", mode: "public-video-detail", publicDouyinId: "public_id", canonicalAccountId: SEC_UID,
    } }),
  };
  return [incoming, prior, target, structuredClone(target)];
}

test("strict stored receipt reuse covers every proof and preserves input/paused state", () => {
  const values = fixture();
  const before = JSON.stringify(values);
  const result = reusableStoredAuthorEvidence(...values);
  assert.equal(result.targetId, 20);
  assert.equal(result.sourceQueueId, 10);
  assert.equal(result.requestedEvidenceCount, 2);
  assert.equal(result.mode, "stored-strict-queue-receipt");
  assert.match(result.sourceEvidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.verifiedAt, "2026-09-13T08:00:00.000Z");
  assert.match(result.reason, /本次未重新请求平台/);
  assert.equal(JSON.stringify(values), before);
  assert.deepEqual(reusableStoredAuthorEvidence(...values), result);
});

test("receipt reuse rejects missing or changed work/share proof and keeps URL path/query case", () => {
  for (const mutate of [
    (v) => { v[0].share_urls_json = JSON.stringify([SHARE.toLowerCase()]); },
    (v) => { v[0].share_urls_json = JSON.stringify([SHARE, "https://v.douyin.com/Second/"]); },
    (v) => { v[0].video_ids_json = JSON.stringify(["7684675001341005096"]); },
    (v) => { v[1].share_urls_json = "[]"; },
    (v) => { v[0].video_ids_json = "[]"; v[0].share_urls_json = "[]"; },
    (v) => { v[0].share_urls_json = JSON.stringify(["http://v.douyin.com/Cu0tbcEzFXY/"]); },
    (v) => { v[0].share_urls_json = JSON.stringify(["https://user:secret@v.douyin.com/Cu0tbcEzFXY/"]); },
    (v) => { v[0].share_urls_json = JSON.stringify(["https://example.com/Cu0tbcEzFXY/"]); },
    (v) => { v[1].video_ids_json = "invalid-json"; },
    (v) => { v[0].video_ids_json = JSON.stringify([7684617087687331118]); },
  ]) {
    const values = fixture(); mutate(values);
    assert.equal(reusableStoredAuthorEvidence(...values), null);
  }
  const subset = fixture(); subset[0].video_ids_json = "[]";
  assert.equal(reusableStoredAuthorEvidence(...subset).requestedEvidenceCount, 1);
});

test("receipt reuse rejects identity mismatch and never treats submitted/source metadata as public proof", () => {
  for (const mutate of [
    (v) => { v[0].douyin_id = "other-id"; },
    (v) => { v[0].account_locator = OTHER_SEC_UID; },
    (v) => { v[0].identity_key = `douyin:account:${OTHER_SEC_UID}|video:${VIDEO}`; },
    (v) => { v[0].account_locator = ""; v[0].identity_key = "douyin:Public_ID"; },
    (v) => { v[1].account_locator = OTHER_SEC_UID; },
    (v) => { v[3].locator = OTHER_SEC_UID; },
    (v) => { v[3].metadata_json = JSON.stringify({ douyinId: "Public_ID", sourceMetadata: { publicDouyinId: "Public_ID" } }); },
    (v) => { const m = JSON.parse(v[2].metadata_json); m.resolution.canonicalAccountId = OTHER_SEC_UID; v[2].metadata_json = JSON.stringify(m); },
    (v) => { const m = JSON.parse(v[3].metadata_json); m.resolution.publicDouyinId = "renamed-id"; v[3].metadata_json = JSON.stringify(m); },
    (v) => { v[3].provider = "manual-json"; },
    (v) => { v[1].resolved_target_id = 99; },
  ]) {
    const values = fixture(); mutate(values);
    assert.equal(reusableStoredAuthorEvidence(...values), null);
  }
});

test("receipt reuse refuses old policy, active leases, suspended claims and non-pending incoming rows", () => {
  for (const mutate of [
    (v) => { v[1].verification_policy_version = 1; },
    (v) => { delete v[1].verification_policy_version; },
    (v) => { v[1].status = "retry"; },
    (v) => { v[0].status = "rejected"; },
    (v) => { v[0].resolved_target_id = 20; },
    (v) => { v[0].lease_owner = "running-worker"; },
    (v) => { v[0].lease_until = "2026-09-13T08:00:00Z"; },
    (v) => { v[0].suspended_target_enabled = 1; },
    (v) => { v[1].suspended_target_enabled = 1; },
    (v) => { v[1].updated_at = "unknown"; },
    (v) => { v[0].id = v[1].id; },
  ]) {
    const values = fixture(); mutate(values);
    assert.equal(reusableStoredAuthorEvidence(...values), null);
  }
});

test("receipt checksum changes when covered stored evidence changes even with the same queue ID", () => {
  const values = fixture();
  const first = reusableStoredAuthorEvidence(...values);
  values[1].video_ids_json = JSON.stringify([VIDEO, "7684675001341005096"]);
  const expanded = reusableStoredAuthorEvidence(...values);
  assert.notEqual(expanded.sourceEvidenceSha256, first.sourceEvidenceSha256);
});

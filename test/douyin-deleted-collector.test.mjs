import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getDouyinLifecycleEvidence } from "../lib/account-lifecycle.mjs";

const collectorPath = fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url));
const locator = "MS4wLjABAAAA0123456789abcdefghijkl";

test("official deletion short-circuits works and retains the complete profile response for trusted lifecycle validation", () => {
  const python = String.raw`
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location("collector", sys.argv[1])
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
response = {"status_code": 0, "user": {
    "uid": "123456789", "user_deleted": True,
    "special_state_info": {"special_state": 1, "title": "账号已经注销", "content": "用户已将自己账号注销，所属内容已无法查看"},
    "follower_count": 0, "total_favorited": 0, "aweme_count": 0,
}, "retained_original_field": {"evidence": "complete response"}}
collector.register_guest = lambda: "temporary guest"
collector.fetch_public_profile = lambda *_args: (response, "guest-ttwid-unsigned-profile")
def forbidden(*_args, **_kwargs):
    raise AssertionError("Deleted account must not request works")
collector.request_json = forbidden
collector.a_bogus_signed_url = forbidden
print(json.dumps(collector.collect_account(sys.argv[2], 30), ensure_ascii=False))
`;
  const child = spawnSync("/usr/bin/python3", ["-B", "-c", python, collectorPath, locator], {
    encoding: "utf8", timeout: 15_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(child.status, 0, child.stderr);
  const raw = JSON.parse(child.stdout);
  assert.deepEqual(raw.profileResponse.retained_original_field, { evidence: "complete response" });
  assert.equal(raw.accountStatus, "unavailable");
  assert.equal(raw.worksCoverage, "not-applicable");
  assert.equal(raw.works.aweme_list.length, 0);
  const lifecycle = getDouyinLifecycleEvidence({ type: "account", provider: "public-web", locator, metadata: { platform: "douyin" } }, raw, {
    provider: "public-web", operation: "account", requestedAccountId: locator, observedAt: new Date().toISOString(),
  });
  assert.equal(lifecycle?.state, "deleted");
  assert.equal(lifecycle.identityVerified, false);
});

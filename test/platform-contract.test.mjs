import test from "node:test";
import assert from "node:assert/strict";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { PLANNED_ACCOUNT_PLATFORMS, SUPPORTED_ACCOUNT_PLATFORMS } from "../lib/platform-contract.mjs";

test("platform contract exposes implemented and planned account adapters", () => {
  assert.deepEqual(SUPPORTED_ACCOUNT_PLATFORMS, ["douyin", "bilibili", "xiaohongshu"]);
  assert.deepEqual(PLANNED_ACCOUNT_PLATFORMS, ["kuaishou"]);
});

test("an explicit future platform never falls through to the Douyin collector", async () => {
  const provider = new PublicWebProvider({}, {
    execFileImpl: () => { throw new Error("Douyin collector must not run for Kuaishou"); },
  });
  await assert.rejects(
    provider.collect({ type: "account", label: "快手作者", locator: "example", metadata: { platform: "kuaishou" } }),
    /快手.*尚未接入.*不会按抖音采集/,
  );
  await assert.rejects(provider.testConnectionForPlatform("kuaishou", { locator: "example" }), /快手.*尚未接入/);
});

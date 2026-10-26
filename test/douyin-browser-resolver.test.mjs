import test from "node:test";
import assert from "node:assert/strict";
import { classifyDouyinDestination } from "../scripts/douyin_browser_resolver.mjs";

const SEC_UID = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";

test("expanded official Douyin destinations are classified without trusting third-party URLs", () => {
  assert.deepEqual(
    classifyDouyinDestination("https://www.douyin.com/video/7679097628281376036?previous_page=web_code_link"),
    { kind: "video", videoId: "7679097628281376036" },
  );
  assert.deepEqual(
    classifyDouyinDestination(`https://www.douyin.com/user/${SEC_UID}`),
    { kind: "profile", secUid: SEC_UID },
  );
  assert.deepEqual(
    classifyDouyinDestination(`https://www.douyin.com/user/${SEC_UID}?modal_id=7679274629319380276`),
    { kind: "video", videoId: "7679274629319380276" },
  );
  assert.equal(classifyDouyinDestination("https://example.com/video/7679097628281376036"), null);
  assert.equal(classifyDouyinDestination("http://www.douyin.com/video/7679097628281376036"), null);
});

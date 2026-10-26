import test from "node:test";
import assert from "node:assert/strict";
import { extractExactChallengeIds, normalizeSearchStatus, normalizeTopicLabel, nonNegativeInteger } from "../scripts/douyin_topic_browser_resolver.mjs";

test("authenticated topic adapter normalizes # labels and only accepts exact challenge names", () => {
  assert.equal(normalizeTopicLabel("##一条小团团ovo"), "一条小团团ovo");
  const payload = {
    data: [
      { challenge_name: "一条小团团ovo", cid: "1617668778418189" },
      { challenge_name: "一条小团团ovo（旧）", cid: "1617668778418190" },
      { challenge_name: "其他话题", cid: "1617668778418191" },
      { challenge_name: "一条小团团ovo", cid: "not-a-cid" },
    ],
  };
  assert.deepEqual(extractExactChallengeIds(payload, "#一条小团团ovo"), ["1617668778418189"]);
  assert.deepEqual(extractExactChallengeIds(payload, "不存在"), []);
});

test("authenticated topic adapter does not treat display-name fragments as a match", () => {
  const payload = { data: [{ name: "一条小团团ovo切片", id: "1617668778418189" }] };
  assert.deepEqual(extractExactChallengeIds(payload, "一条小团团ovo"), []);
});

test("authenticated topic adapter keeps missing official metrics null", () => {
  assert.equal(nonNegativeInteger(null), null);
  assert.equal(nonNegativeInteger(""), null);
  assert.equal(nonNegativeInteger("  "), null);
  assert.equal(nonNegativeInteger(false), null);
  assert.equal(nonNegativeInteger("12,345"), null);
  assert.equal(nonNegativeInteger("12345"), 12345);
  assert.equal(nonNegativeInteger(0), 0);
});

test("authenticated topic adapter requires an explicit zero status from search", () => {
  assert.equal(normalizeSearchStatus({}), null);
  assert.equal(normalizeSearchStatus({ status_code: "" }), null);
  assert.equal(normalizeSearchStatus({ status_code: 0 }), 0);
  assert.equal(normalizeSearchStatus({ status_code: "0" }), 0);
  assert.equal(normalizeSearchStatus({ status_code: 2483 }), 2483);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourcePollKey } from "../lib/source-poller-status.mjs";
import { sourcePollLoopPlan, sourceReadBlockReason } from "../scripts/source-poller.mjs";

const proposal = JSON.parse(readFileSync(new URL("./fixtures/source-registry-nzk-lad-proposal.json", import.meta.url), "utf8"));
const live = JSON.parse(readFileSync(new URL("../data/source-poll/registry.json", import.meta.url), "utf8"));

test("Nzk and LAD remain isolated proposals, never silently registered", () => {
  assert.equal(proposal.mode, "proposal-only-not-loadable-by-source-poller");
  assert.equal(proposal.sources, undefined, "a proposal must not match the live registry schema");
  assert.equal(proposal.entries.length, 2);
  const liveUrls = new Set(live.sources.map((source) => source.sourceUrl));
  for (const { source } of proposal.entries) {
    assert.ok(!liveUrls.has(source.sourceUrl), `${source.sourceTitle} must not be active`);
    assert.match(source.sourceUrl, /^https:\/\//);
    assert.equal(sourceReadBlockReason(source), null);
  }
});

test("promoting Nzk would trigger immediate author import, so activation requires a gate", () => {
  const source = proposal.entries[0].source;
  assert.equal(source.sourceType, "lark-bitable");
  assert.equal(source.kind, "author-roster");
  assert.equal(source.baseToken, "EVkPbUqX8aFBlcs7KEJc5CX6nLf");
  assert.equal(source.tableId, "tbldHq5cIDTm97XZ");
  assert.notEqual(source.defaultBoard, "");
  const plan = sourcePollLoopPlan({ lastFinishedAt: "2026-10-23T16:00:00Z", sources: {} }, {
    now: new Date("2026-10-24T05:00:00Z"), registry: [source],
  });
  assert.equal(plan.mode, "unchecked");
  assert.deepEqual(plan.uncheckedKeys, [sourcePollKey(source)]);
});

test("LAD can only be a metadata watch in the current source poller", () => {
  const source = proposal.entries[1].source;
  assert.equal(source.sourceType, "lark-sheet");
  assert.equal(source.kind, "content-statistics");
  assert.equal(source.monitorOnly, true);
  assert.equal(source.defaultBoard, "");
  assert.match(proposal.entries[1].note, /does not import/);
  assert.deepEqual(new URL(source.sourceUrl).searchParams.get("sheet"), "097adb");
});

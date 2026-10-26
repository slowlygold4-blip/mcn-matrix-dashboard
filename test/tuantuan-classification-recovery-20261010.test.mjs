import test from "node:test";
import assert from "node:assert/strict";
import { classifyAuthor } from "../lib/author-classification.mjs";
import { mergeRosterClassification } from "../lib/roster-classification.mjs";

const keys = (classification) => classification.labels.map((label) => label.key);

test("exact Tuantuan slice-matrix evidence stays primary while AI remains a secondary label", () => {
  const result = classifyAuthor({
    category: "AI二创",
    boards: ["一条小团团切片矩阵"],
  });

  assert.equal(result.theme.key, "tuantuan");
  assert.equal(result.theme.confirmed, true);
  assert.equal(result.primaryKey, "slice");
  assert.equal(result.labels[0].key, "slice");
  assert.ok(keys(result).includes("ai-remix"));
});

test("current exact slice board outranks a roster label order of AI then slice", () => {
  const current = classifyAuthor({ boards: ["一条小团团切片矩阵"] });
  const result = mergeRosterClassification(current, {
    theme: { key: "tuantuan", label: "团团" },
    classifications: [
      { key: "ai-remix", label: "AI二创" },
      { key: "slice", label: "切片" },
    ],
  });

  assert.equal(result.theme.key, "tuantuan");
  assert.equal(result.primaryKey, "slice");
  assert.equal(result.labels[0].key, "slice");
  assert.ok(keys(result).includes("ai-remix"));
});

test("a raw AI-plan board stays AI until the confirmed Tuantuan roster supplies the matrix primary", () => {
  const aiPlan = classifyAuthor({ boards: ["一条小团团AI二创计划"] });
  assert.equal(aiPlan.theme.key, "tuantuan");
  assert.equal(aiPlan.primaryKey, "ai-remix");
  assert.ok(!keys(aiPlan).includes("slice"));

  const ownershipOnly = mergeRosterClassification(classifyAuthor({}), {
    theme: { key: "tuantuan", label: "团团" },
    classifications: [{ key: "ai-remix", label: "AI二创" }],
  });
  assert.equal(ownershipOnly.theme.key, "tuantuan");
  assert.equal(ownershipOnly.primaryKey, "slice");
  assert.equal(ownershipOnly.labels[0].key, "slice");
  assert.ok(keys(ownershipOnly).includes("ai-remix"));
});

test("a non-Tuantuan named slice matrix still gets the generic slice primary", () => {
  const result = classifyAuthor({ boards: ["玉麒麟切片矩阵"] });

  assert.equal(result.theme.key, "yuqilin");
  assert.equal(result.primaryKey, "slice");
  assert.equal(result.labels[0].key, "slice");
});

test("a stale roster theme cannot replace a different current source-confirmed matrix", () => {
  const result = mergeRosterClassification(classifyAuthor({ boards: ["玉麒麟切片矩阵"] }), {
    theme: { key: "tuantuan", label: "团团" },
    classifications: [{ key: "ai-remix", label: "AI二创" }],
  });

  assert.equal(result.theme.key, "yuqilin");
  assert.equal(result.primaryKey, "slice");
  assert.ok(keys(result).includes("ai-remix"));
});

test("an explicit Tuantuan roster source outranks only the generic streamer intake bucket", () => {
  const result = mergeRosterClassification(classifyAuthor({ boards: ["抖音主播板块"] }), {
    theme: { key: "tuantuan", label: "团团" },
    boards: [{ name: "一条小团团切片矩阵" }],
    classifications: [{ key: "slice", label: "切片" }],
  });

  assert.equal(result.theme.key, "tuantuan");
  assert.equal(result.primaryKey, "slice");
});

test("free-form source text stays inspectable without becoming a top-level label", () => {
  const rawSourceText = "3D搞笑剧情／字幕特效";
  const result = mergeRosterClassification(
    classifyAuthor({ boards: ["一条小团团切片矩阵"] }),
    {
      theme: { key: "tuantuan", label: "团团" },
      classifications: [{ key: `custom:${rawSourceText.toLowerCase()}`, label: rawSourceText }],
    },
  );

  assert.ok(!result.labels.some((label) => label.key.startsWith("custom:")));
  assert.ok(Array.isArray(result.sourceDescriptions));
  assert.ok(result.sourceDescriptions.includes(rawSourceText));
});

import test from "node:test";
import assert from "node:assert/strict";
import { classifyAuthor, classifyAuthorTheme, classificationCatalog, summarizeClassifications, summarizeThemes } from "../lib/author-classification.mjs";

test("explicit slice matrix stays primary and preserves spreadsheet content labels", () => {
  const result = classifyAuthor({
    label: "团团AI作者",
    category: "原创授权 / AI二创",
    boards: [{ name: "一条小团团切片矩阵", category: "原创授权" }],
  });
  assert.equal(result.mode, "explicit");
  assert.equal(result.primaryLabel, "切片");
  assert.equal(result.labels[0].key, "slice");
  assert.deepEqual(result.labels.map((item) => item.label).sort(), ["AI二创", "原创", "切片"].sort());
  assert.ok(result.evidence.some((item) => item.source === "表格分类"));
});

test("unclassified names are not guessed into a business category", () => {
  const result = classifyAuthor({ label: "小王" });
  assert.equal(result.primaryKey, "unclassified");
  assert.equal(result.mode, "unclassified");
  assert.equal(result.needsReview, true);
});

test("summary counts multi-label authors once per visible label", () => {
  const items = [
    { classification: classifyAuthor({ category: "原创" }) },
    { classification: classifyAuthor({ category: "切片" }) },
    { classification: classifyAuthor({ label: "小王" }) },
  ];
  const summary = summarizeClassifications(items);
  assert.equal(summary.total, 3);
  assert.equal(summary.classified, 2);
  assert.equal(summary.unclassified, 1);
  assert.equal(summary.items.find((item) => item.key === "original").count, 1);
  assert.equal(summary.items.find((item) => item.key === "unclassified").count, 1);
  assert.equal(classificationCatalog().length >= 6, true);
});

test("custom spreadsheet labels remain available as filterable facets", () => {
  const items = [{ classification: classifyAuthor({ category: "剧情故事" }) }];
  const catalog = classificationCatalog(items[0].classification.labels);
  const summary = summarizeClassifications(items, catalog);
  assert.equal(catalog.some((item) => item.key === "custom:剧情故事"), true);
  assert.equal(summary.items.find((item) => item.key === "custom:剧情故事").count, 1);
});

test("ownership, account tiers, placeholders, and future plans are not content categories", () => {
  const result = classifyAuthor({ boards: [
    { name: "抖音主播板块", category: "抖音主播", tier: "超头部" },
    { name: "一条小团团切片矩阵", category: "原创", tier: "中腰部" },
  ] });
  assert.equal(result.theme.key, "tuantuan");
  assert.ok(result.labels.some(item => item.key === "original"));
  assert.ok(result.labels.some(item => item.key === "slice"));
  for (const label of ["抖音主播", "超头部", "中腰部", "未细分", "未来可能AI", "后续可能AI"]) {
    assert.ok(!result.labels.some(item => item.label === label), `${label} is not a content type`);
  }
  assert.equal(classifyAuthor({ category: "未细分" }).primaryKey, "unclassified");
});

test("confirmed Tuantuan sources share one major theme while retaining content labels", () => {
  const cases = [
    { memberships: [{ board_name: "一条小团团切片矩阵", category: "原创授权" }] },
    { metadata: { importSource: { fileName: "一条小团团OvO9月即梦AI二创大赛激励计划.xlsx" } } },
    { metadata: { sourceMetadata: { sourceName: "团团后续补充名单" } }, category: "直播切片" },
    { boards: [{ name: "未分板块", source: { fileName: "一条小团团名单核对快照-修订2835.xlsx" } }] },
  ];
  for (const input of cases) {
    const result = classifyAuthor(input);
    assert.equal(result.theme.key, "tuantuan");
    assert.equal(result.theme.label, "团团");
    assert.equal(result.theme.confirmed, true);
    assert.ok(result.theme.evidence.length > 0);
  }
  const first = classifyAuthor(cases[0]);
  assert.ok(first.labels.some((label) => label.key === "original"));
  assert.ok(first.labels.some((label) => label.key === "slice"));
  assert.equal(first.theme.evidence[0].value, "一条小团团切片矩阵");
});

test("major theme never relies on nicknames or excluded source membership", () => {
  assert.equal(classifyAuthorTheme({ label: "团团家的粉丝日记" }).key, "unassigned");
  assert.equal(classifyAuthorTheme({ metadata: { submittedName: "小团团" } }).key, "unassigned");
  assert.equal(classifyAuthorTheme({ category: "非一条小团团矩阵" }).key, "unassigned");
  assert.equal(classifyAuthorTheme({ category: "不是团团的账号" }).key, "unassigned");
  assert.equal(classifyAuthorTheme({ boards: [{ name: "7jiab" }] }).key, "unassigned");
});

test("other major themes remain distinct and generic roster does not override IP", () => {
  assert.equal(classifyAuthorTheme({ memberships: [{ board_name: "玉麒麟主播" }] }).key, "yuqilin");
  assert.equal(classifyAuthorTheme({ memberships: [{ board_name: "玉麒麟切片矩阵" }] }).key, "yuqilin");
  const result = classifyAuthorTheme({ boards: ["抖音主播板块", "一条小团团切片矩阵"] });
  assert.equal(result.key, "tuantuan");
  assert.deepEqual(result.labels.map((label) => label.key), ["tuantuan"]);
});

test("explicit negative theme evidence cannot be overridden by weaker filenames", () => {
  const excluded = classifyAuthorTheme({ memberships: [{ board_name: "不是团团的账号", source_file_name: "团团筛选名单.xlsx" }] });
  assert.equal(excluded.key, "unassigned");
  assert.equal(excluded.confirmed, false);
  assert.ok(excluded.evidence.some((item) => item.excluded && item.source === "所属板块"));
  assert.equal(classifyAuthorTheme({ category: "不属于团团", metadata: { importSource: { fileName: "团团待筛选名单.xlsx" } } }).key, "unassigned");
  assert.equal(classifyAuthorTheme({ boards: ["一条小团团切片矩阵"], metadata: { importSource: { fileName: "非团团备用模板.xlsx" } } }).key, "tuantuan");
  assert.equal(classifyAuthorTheme({ boards: ["团团矩阵", "非团团账号"] }).confirmed, false);
});

test("major theme summary is exclusive and does not double count content labels", () => {
  const items = [
    { classification: classifyAuthor({ category: "团团原创 / AI二创" }) },
    { classification: classifyAuthor({ boards: ["一条小团团切片矩阵"] }) },
    { classification: classifyAuthor({ boards: ["玉麒麟切片矩阵", "玉麒麟主播"] }) },
    { classification: classifyAuthor({ label: "团团作者" }) },
  ];
  const result = summarizeThemes(items);
  assert.equal(result.total, 4);
  assert.equal(result.assigned, 3);
  assert.equal(result.unassigned, 1);
  assert.equal(result.items.find((item) => item.key === "tuantuan").count, 2);
  assert.equal(result.items.filter((item) => item.key !== "all").reduce((sum, item) => sum + item.count, 0), 4);
});

test("ordinary remix requires source evidence and never implies AI production", () => {
  for (const category of ["二创", "切片二创", "直播二创", "二次创作", "二创,搞笑,抽象"]) {
    const result = classifyAuthor({ category });
    assert.ok(result.labels.some(label => label.key === "remix"), category);
    assert.ok(!result.labels.some(label => label.key === "ai-remix"), category);
    assert.ok(result.evidence.some(e => e.label === "二创" && e.value === category && e.source === "表格分类"));
  }
  assert.equal(classificationCatalog().find(item => item.key === "remix").label, "二创");
});

test("explicit AI remix is not duplicated as ordinary remix", () => {
  for (const category of ["AI二创", "AI 二创", "ＡＩ二创", "AIGC 二创", "小团团即梦二创", "AI作者"]) {
    const result = classifyAuthor({ category });
    assert.ok(result.labels.some(label => label.key === "ai-remix"), category);
    assert.ok(!result.labels.some(label => label.key === "remix"), category);
    assert.equal(result.labels.filter(label => label.key === "ai-remix").length, 1);
  }
  assert.ok(classifyAuthor({ metadata: { importSource: { fileName: "即梦二创大赛.xlsx" } } }).labels.some(label => label.key === "ai-remix"));
});

test("separate ordinary and AI content declarations retain both labels and their original evidence", () => {
  const category = "切片二创、ai二创";
  const input = { boards: [{ name: "一条小团团切片矩阵", category }] };
  const before = structuredClone(input);
  const result = classifyAuthor(input);
  assert.equal(result.theme.key, "tuantuan");
  assert.ok(result.labels.some(label => label.key === "remix"));
  assert.ok(result.labels.some(label => label.key === "ai-remix"));
  for (const label of ["二创", "AI二创"]) assert.ok(result.evidence.some(e => e.label === label && e.value === category));
  assert.deepEqual(input, before, "classification must not rewrite source labels or membership");
});

test("AI substrings in unrelated English text or email addresses are not AI evidence", () => {
  for (const category of ["daily", "daily@example.com", "email", "plainemailcontainsai", "chair", "notai", "aigcware"]) {
    assert.ok(!classifyAuthor({ category }).labels.some(label => label.key === "ai-remix"), category);
  }
  for (const category of ["AI", "ai 制作", "切片AI动画", "AIGC", "即梦"]) {
    assert.ok(classifyAuthor({ category }).labels.some(label => label.key === "ai-remix"), category);
  }
});

test("nicknames cannot prove AI, ordinary remix, or Tuantuan ownership", () => {
  for (const label of ["团团AI作者", "团团二创", "即梦AI", "DailyAI"]) {
    const result = classifyAuthor({ label });
    assert.ok(!result.labels.some(item => ["ai-remix", "remix"].includes(item.key)), label);
    assert.equal(result.theme.key, "unassigned");
  }
  const sourceConfirmed = classifyAuthor({ label: "其他昵称", category: "AI二创", boards: ["团团切片矩阵"] });
  assert.equal(sourceConfirmed.theme.key, "tuantuan");
  assert.ok(sourceConfirmed.labels.some(item => item.key === "ai-remix"));
});

test("future AI intentions and explicitly negative AI clauses are not current production evidence", () => {
  for (const category of [
    "音乐,游戏搞笑,未来有做AI的打算,PK切片",
    "目前直播二创和故事向/未来可能进AI",
    "主切片,二创,后续可能ai",
    "非AI二创", "不是AI", "不使用AI", "暂无AI作品", "准备尝试AIGC",
  ]) assert.ok(!classifyAuthor({ category }).labels.some(label => label.key === "ai-remix"), category);
  const result = classifyAuthor({ category: "目前AI二创,未来准备原创" });
  assert.ok(result.labels.some(label => label.key === "ai-remix"));
  assert.ok(classifyAuthor({ category: "AI创作激励计划" }).labels.some(label => label.key === "ai-remix"));
});

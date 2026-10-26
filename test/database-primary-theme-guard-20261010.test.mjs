import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { classifyAuthor } from "../lib/author-classification.mjs";

function fixture(t, prefix) {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  return database;
}

function authorInput(locator, boards, fileName = "团团名单.xlsx", sheetName = "作者名单") {
  return {
    label: "测试作者",
    locator,
    boards,
    metadata: {
      platform: "douyin",
      importSource: { type: "author-spreadsheet", fileName, sheetName, sourceRow: 2 },
    },
  };
}

test("automatic import keeps an existing explicit IP and records rejected cross-IP evidence", (t) => {
  const database = fixture(t, "douyin-primary-theme-guard-");
  const locator = "MS4wLjABAAAAprimaryThemeGuard123456";
  const first = database.importAuthorTargets([
    authorInput(locator, [{ name: "一条小团团切片矩阵", category: "切片" }]),
  ]);
  const targetId = first.created[0].id;

  const rejected = database.importAuthorTargets([
    authorInput(locator, [{ name: "玉麒麟切片矩阵", category: "切片" }], "误归类名单.xlsx"),
  ]);
  const repeated = database.importAuthorTargets([
    authorInput(locator, [{ name: "玉麒麟切片矩阵", category: "切片" }], "误归类名单.xlsx"),
  ]);

  const target = database.getTarget(targetId);
  assert.deepEqual(target.boards.map((board) => board.name), ["一条小团团切片矩阵"]);
  assert.equal(classifyAuthor({ boards: target.boards }).theme.key, "tuantuan");
  assert.equal(database.listBoards().some((board) => board.name === "玉麒麟切片矩阵"), false,
    "a rejected relationship must not create an empty board catalog entry");
  assert.equal(rejected.boardMembershipsAdded, 0);
  assert.equal(rejected.boardFieldConflicts.length, 1);
  assert.equal(rejected.boardFieldConflicts[0].field, "primaryTheme");
  assert.equal(rejected.boardFieldConflicts[0].relationshipBlocked, true);
  assert.match(rejected.boardFieldConflicts[0].storedValue, /^团团\|/);
  assert.match(rejected.boardFieldConflicts[0].incomingValue, /^玉麒麟\|/);
  assert.equal(repeated.boardMembershipsAdded, 0);
  assert.equal(repeated.boardFieldConflicts.length, 1, "each rejected attempt remains visible to its import audit");

  const stored = database.getTarget(targetId).boards[0].conflicts;
  assert.equal(stored.length, 1, "repeated imports must not duplicate durable conflict evidence");
  assert.deepEqual(stored[0], {
    field: "primaryTheme",
    storedValue: "团团|一条小团团切片矩阵",
    incomingValue: "玉麒麟|玉麒麟切片矩阵",
    recordedAt: stored[0].recordedAt,
    storedSource: {
      type: "author-spreadsheet",
      fileName: "团团名单.xlsx",
      sheetName: "作者名单",
      sourceRow: 2,
    },
    incomingSource: {
      type: "author-spreadsheet",
      fileName: "误归类名单.xlsx",
      sheetName: "作者名单",
      sourceRow: 2,
    },
    relationshipBlocked: true,
  });
});

test("same-IP secondary categories and the generic streamer board remain attachable", (t) => {
  const database = fixture(t, "douyin-primary-theme-secondary-");
  const locator = "MS4wLjABAAAAsameIpSecondary123456";
  const created = database.importAuthorTargets([
    authorInput(locator, [{ name: "一条小团团切片矩阵", category: "切片" }]),
  ]);
  const targetId = created.created[0].id;

  const updated = database.importAuthorTargets([
    authorInput(locator, [{ name: "一条小团团AI二创计划", category: "AI二创" }], "AI作者.xlsx"),
    authorInput(locator, ["抖音主播板块"], "主播总表.xlsx"),
  ]);
  const target = database.getTarget(targetId);
  const classification = classifyAuthor({ boards: target.boards });

  assert.equal(updated.boardMembershipsAdded, 2);
  assert.deepEqual(target.boards.map((board) => board.name), ["一条小团团AI二创计划", "一条小团团切片矩阵", "抖音主播板块"]);
  assert.equal(classification.theme.key, "tuantuan");
  assert.deepEqual(new Set(classification.labels.map((label) => label.key)), new Set(["slice", "ai-remix"]));
  assert.equal(classification.primaryKey, "slice");
});

test("a generic streamer membership does not block the first explicit IP theme", (t) => {
  const database = fixture(t, "douyin-primary-theme-generic-");
  const locator = "MS4wLjABAAAAgenericThenExplicit123456";
  const created = database.importAuthorTargets([authorInput(locator, ["抖音主播板块"], "主播总表.xlsx")]);
  const targetId = created.created[0].id;

  const updated = database.importAuthorTargets([
    authorInput(locator, [{ name: "一条小团团切片矩阵", category: "切片" }]),
  ]);
  const target = database.getTarget(targetId);

  assert.equal(updated.boardMembershipsAdded, 1);
  assert.deepEqual(target.boards.map((board) => board.name), ["一条小团团切片矩阵", "抖音主播板块"]);
  assert.equal(classifyAuthor({ boards: target.boards }).theme.key, "tuantuan");
});

test("generic board provenance and metadata cannot freeze an IP theme", (t) => {
  const database = fixture(t, "douyin-primary-theme-provenance-guard-");
  const locator = "MS4wLjABAAAAprovenanceMustNotFreeze123456";
  const created = database.importAuthorTargets([
    authorInput(locator, [{ name: "抖音主播板块", category: "玉麒麟", tier: "玉麒麟来源分层" }],
      "玉麒麟作者名单.xlsx", "玉麒麟来源工作表"),
  ]);
  const targetId = created.created[0].id;

  const updated = database.importAuthorTargets([
    authorInput(locator, [{ name: "一条小团团切片矩阵", category: "切片" }], "团团复核名单.xlsx"),
  ]);
  const target = database.getTarget(targetId);

  assert.equal(updated.boardMembershipsAdded, 1);
  assert.equal(updated.boardFieldConflicts.length, 0);
  assert.deepEqual(target.boards.map((board) => board.name), ["一条小团团切片矩阵", "抖音主播板块"]);
  assert.equal(classifyAuthor({ boards: target.boards }).theme.key, "tuantuan");
  assert.equal(target.boards.find((board) => board.name === "抖音主播板块").source.fileName, "玉麒麟作者名单.xlsx",
    "provenance remains visible but is not an IP authority for the guard");
});

test("one automatic batch with conflicting explicit IPs keeps generic boards and blocks every guess", (t) => {
  const database = fixture(t, "douyin-primary-theme-same-batch-conflict-");
  const permutations = [
    ["一条小团团切片矩阵", "抖音主播板块", "玉麒麟切片矩阵"],
    ["玉麒麟切片矩阵", "抖音主播板块", "一条小团团切片矩阵"],
  ];

  permutations.forEach((boards, index) => {
    const locator = `MS4wLjABAAAAsameBatchConflict${index}123456`;
    const result = database.importAuthorTargets([
      authorInput(locator, boards, "同批双主题名单.xlsx"),
    ]);
    const target = result.created[0];

    assert.equal(result.boardMembershipsAdded, 1, "only the generic relationship may be persisted");
    assert.deepEqual(target.boards.map((board) => board.name), ["抖音主播板块"]);
    assert.equal(classifyAuthor({ boards: target.boards }).theme.key, "douyin-streamers");
    assert.equal(result.boardFieldConflicts.length, 2);
    assert.deepEqual(result.boardFieldConflicts.map((conflict) => conflict.incomingValue).sort(),
      ["团团|一条小团团切片矩阵", "玉麒麟|玉麒麟切片矩阵"].sort());
    assert.ok(result.boardFieldConflicts.every((conflict) => conflict.field === "primaryTheme"
      && conflict.relationshipBlocked === true
      && conflict.storedValue === "待归属|同批冲突主题:团团、玉麒麟"));
    const durableConflicts = target.boards[0].conflicts;
    assert.equal(durableConflicts.length, 2, "the retained generic relationship carries durable conflict evidence");
    assert.deepEqual(durableConflicts.map((conflict) => conflict.incomingValue).sort(),
      ["团团|一条小团团切片矩阵", "玉麒麟|玉麒麟切片矩阵"].sort());
  });

  assert.deepEqual(database.listBoards().map((board) => board.name), ["抖音主播板块"],
    "blocked explicit relationships must not create empty catalog boards");
});

test("one author split across input rows cannot receive a theme according to row order", (t) => {
  const database = fixture(t, "douyin-primary-theme-split-row-conflict-");
  for (const [index, names] of [
    ["一条小团团切片矩阵", "玉麒麟切片矩阵"],
    ["玉麒麟切片矩阵", "一条小团团切片矩阵"],
  ].entries()) {
    const locator = `MS4wLjABAAAAsplitRows${index}123456789`;
    const result = database.importAuthorTargets([
      authorInput(locator, ["抖音主播板块"], "通用表.xlsx"),
      ...names.map((name, rowIndex) => authorInput(locator, [name], `来源${rowIndex}.xlsx`)),
    ]);
    const target = database.getTarget(result.created[0].id);
    assert.deepEqual(target.boards.map((board) => board.name), ["抖音主播板块"]);
    assert.equal(result.boardFieldConflicts.filter((item) => item.field === "primaryTheme").length, 2);
    assert.equal(classifyAuthor({ boards: target.boards }).theme.key, "douyin-streamers");
  }
});

test("an existing explicit theme deterministically wins a mixed automatic batch", (t) => {
  const database = fixture(t, "douyin-primary-theme-existing-wins-batch-");
  const locator = "MS4wLjABAAAAexistingWinsMixedBatch123456";
  const created = database.importAuthorTargets([
    authorInput(locator, [{ name: "一条小团团切片矩阵", category: "切片" }]),
  ]);
  const targetId = created.created[0].id;

  const updated = database.importAuthorTargets([
    authorInput(locator, [
      { name: "玉麒麟切片矩阵", category: "切片" },
      { name: "一条小团团AI二创计划", category: "AI二创" },
      "抖音主播板块",
    ], "混合主题复核.xlsx"),
  ]);
  const target = database.getTarget(targetId);

  assert.equal(updated.boardMembershipsAdded, 2);
  assert.equal(updated.boardFieldConflicts.length, 1);
  assert.match(updated.boardFieldConflicts[0].incomingValue, /^玉麒麟\|/);
  assert.deepEqual(target.boards.map((board) => board.name), ["一条小团团AI二创计划", "一条小团团切片矩阵", "抖音主播板块"]);
  assert.equal(classifyAuthor({ boards: target.boards }).theme.key, "tuantuan");
  assert.equal(database.listBoards().some((board) => board.name === "玉麒麟切片矩阵"), false);
});

test("an explicit user assignment remains the authority boundary for cross-IP membership", (t) => {
  const database = fixture(t, "douyin-primary-theme-user-");
  const locator = "MS4wLjABAAAAuserAssignment123456";
  const created = database.importAuthorTargets([
    authorInput(locator, [{ name: "一条小团团切片矩阵", category: "切片" }]),
  ]);
  const targetId = created.created[0].id;

  const result = database.assignTargetsToBoard([targetId], "玉麒麟切片矩阵", { sourceType: "user-assignment" });
  const target = database.getTarget(targetId);

  assert.equal(result.added, 1);
  assert.deepEqual(target.boards.map((board) => board.name), ["一条小团团切片矩阵", "玉麒麟切片矩阵"]);
  assert.equal(classifyAuthor({ boards: target.boards }).theme.key, "unassigned",
    "manual cross-IP intent is retained but remains visibly unresolved by classification");
});

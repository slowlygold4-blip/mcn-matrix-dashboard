import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { escapeHtml } from "../public/ui-safety.js";
import {
  BOARD_ALL,
  BOARD_UNASSIGNED,
  boardCounts,
  createBoardCatalog,
  filterTargetsByBoard,
  normalizeBoardSelection,
  rowsWithDefaultBoard,
  scopeReportToBoard,
  targetBoardLabels,
} from "../public/board-scope.js";

const targets = [
  { id: 1, label: "甲", boards: ["FPS", "重点作者"], enabled: true },
  { id: 2, label: "乙", boards: [{ id: "fps", name: "FPS赛道" }], enabled: true },
  { id: 3, label: "丙", enabled: true },
];

test("board compatibility adapter supports multiple boards and legacy unassigned targets", () => {
  const catalog = createBoardCatalog([{ key: "fps", name: "FPS" }, "重点作者"], targets);
  assert.deepEqual(filterTargetsByBoard(targets, "fps", catalog).map((target) => target.id), [1, 2]);
  assert.deepEqual(filterTargetsByBoard(targets, BOARD_UNASSIGNED, catalog).map((target) => target.id), [3]);
  assert.deepEqual(targetBoardLabels(targets[0], catalog), ["FPS", "重点作者"]);
  assert.deepEqual(targetBoardLabels(targets[2], catalog), ["未分板块"]);
  assert.equal(boardCounts(targets, catalog).get("fps"), 2);
  assert.equal(boardCounts(targets, catalog).get(BOARD_UNASSIGNED), 1);
});

test("boards and counts ignore disabled-only memberships", () => {
  const mixedTargets = [
    ...targets,
    { id: 4, label: "已停用", boards: ["停用板块"], enabled: false },
  ];
  const catalog = createBoardCatalog([], mixedTargets);
  assert.equal(catalog.some((board) => board.label === "停用板块"), false);
  const counts = boardCounts(mixedTargets, catalog);
  assert.equal(counts.get(BOARD_UNASSIGNED), 1);
  assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), 4, "多板块启用作者按每项归属计数，停用作者不计入");
});

test("independent hashtag targets never enter account board counts or filters", () => {
  const mixedTargets = [
    { id: 10, type: "account", label: "账号", boards: ["主播板块"], enabled: true },
    { id: 11, type: "hashtag", label: "#话题", boards: ["主播板块"], enabled: true },
  ];
  const catalog = createBoardCatalog([], mixedTargets);
  assert.deepEqual(filterTargetsByBoard(mixedTargets, BOARD_ALL, catalog).map((target) => target.id), [10]);
  assert.deepEqual(filterTargetsByBoard(mixedTargets, "主播板块", catalog).map((target) => target.id), [10]);
  assert.equal(catalog.some((board) => board.label === "主播板块"), true);
  assert.equal(boardCounts(mixedTargets, catalog).get("主播板块"), 1);
});

test("board report sums only matching authors and preserves unknown evidence as null", () => {
  const catalog = createBoardCatalog(["FPS", "重点作者"], targets);
  const report = {
    summary: { viralThreshold: 100 },
    contributors: [
      { targetId: 1, followersDelta: 12, accountLikesDelta: 5, followersCurrent: 100, accountLikesCurrent: 80 },
      { targetId: 2, followersDelta: null, accountLikesDelta: 3, followersCurrent: 50, accountLikesCurrent: 20 },
      { targetId: 3, followersDelta: 99, accountLikesDelta: 99 },
    ],
    posts: [
      { target_id: 1, id: "a", likes: 120 },
      { target_id: 2, id: "b", likes: 20 },
      { target_id: 3, id: "c", likes: 999 },
    ],
    viral: [],
  };
  const scoped = scopeReportToBoard(report, targets, catalog, "fps", { complete: true, viralLikeThreshold: 100 });
  assert.equal(scoped.summary.targetCount, 2);
  assert.equal(scoped.summary.followersDelta, 12);
  assert.equal(scoped.summary.accountLikesDelta, 8);
  assert.equal(scoped.summary.postCount, 2);
  assert.deepEqual(scoped.posts.map((post) => post.id), ["a", "b"]);
  assert.deepEqual(scoped.viral.map((post) => post.id), ["a"]);
  assert.equal(scoped.summary.snapshotCount, null);
  assert.equal(scoped.summary.likesDelta, null);
  const pending = scopeReportToBoard(report, targets, catalog, "fps", { complete: false });
  assert.equal(pending.summary.postCount, null);
  assert.equal(pending.summary.profileObservedTargetCount, null);
  assert.equal(pending.summary.followersDelta, 12, "compact contributor deltas remain usable while post evidence loads");
});

test("board coverage counts a complete public works snapshot as validated", () => {
  const catalog = createBoardCatalog(["FPS"], targets);
  const evidenceTargets = targets.slice(0, 2).map((target, index) => index === 0
    ? { ...target, boards: ["FPS"], worksCoverage: "complete", accountStatus: "available", last_status: "warning" }
    : { ...target, boards: ["FPS"], worksCoverage: "limited", accountStatus: "available", last_status: "warning" });
  const scoped = scopeReportToBoard({ summary: {}, contributors: [], posts: [], viral: [] }, evidenceTargets, catalog, "FPS", { complete: false });
  assert.equal(scoped.summary.validatedTargetCount, 1);
  assert.equal(scoped.summary.limitedTargetCount, 1);
  assert.equal(scoped.summary.worksCompleteRate, 50);
  assert.equal(scoped.summary.worksUsableRate, 100);
  assert.equal(scoped.summary.worksSuccessRate, 100);
});

test("board report never turns missing post likes into zero", () => {
  const catalog = createBoardCatalog(["FPS"], targets);
  const report = {
    summary: { viralThreshold: 100 },
    contributors: [],
    posts: [{ target_id: 1, id: "missing-like", likes: null }],
    viral: [],
  };
  const scoped = scopeReportToBoard(report, targets, catalog, "FPS", { complete: true });
  assert.equal(scoped.summary.postCount, 1);
  assert.equal(scoped.summary.likesCurrent, null);
  assert.equal(scoped.summary.medianLikes, null);
  assert.equal(scoped.summary.likesObservedPostCount, 0);
  assert.equal(scoped.summary.likesMissingPostCount, 1);
});

test("missing likes never become viral when the valid threshold is zero", () => {
  const catalog = createBoardCatalog(["FPS"], targets);
  const report = {
    summary: { viralThreshold: 0 },
    contributors: [],
    posts: [
      { target_id: 1, id: "missing-like", likes: null },
      { target_id: 1, id: "known-zero", likes: 0 },
    ],
    viral: [],
  };
  const scoped = scopeReportToBoard(report, targets, catalog, "FPS", { complete: true, viralLikeThreshold: 0 });
  assert.deepEqual(scoped.viral.map((post) => post.id), ["known-zero"]);
  assert.equal(scoped.summary.viralCount, 1);
  assert.equal(scoped.summary.likesObservedPostCount, 1);
  assert.equal(scoped.summary.likesMissingPostCount, 1);
});

test("client fallback uses the same relative viral threshold for unassigned data", () => {
  const catalog = createBoardCatalog([], targets);
  const report = {
    summary: { viralThreshold: 100 },
    contributors: [],
    posts: [100, 200, 300, 400, 2_000].map((likes, index) => ({ target_id: 3, id: `post-${index}`, likes })),
    viral: [],
  };
  const scoped = scopeReportToBoard(report, targets, catalog, BOARD_UNASSIGNED, {
    complete: true,
    viralLikeThreshold: 100,
    viralRelativeMultiplier: 3,
  });
  assert.equal(scoped.summary.viralThreshold, 1_020);
  assert.deepEqual(scoped.viral.map((post) => post.likes), [2_000]);
});

test("one shared board selector scopes product pages while preserving safe import and catalog semantics", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const safety = await readFile(new URL("../public/ui-safety.js", import.meta.url), "utf8");
  const product = await readFile(new URL("../public/product-dashboard.js", import.meta.url), "utf8");
  assert.equal((html.match(/data-board-select/g) || []).length, 1, "所有业务页面使用同一板块选择，避免多个选择器显示不同范围");
  assert.match(html, /id="productScope"[\s\S]*data-board-select aria-label="选择数据板块"/);
  assert.match(product, /params\.set\('board', state\.board\)/);
  assert.match(product, /独立查看每个板块；全部板块按账号去重汇总/);
  assert.match(html, /所属板块/);
  assert.match(html, /留空会归入“未分板块”.*不会把缺失数据当作 0/);
  assert.match(html, /https:\/\/my\.feishu\.cn\/sheets\/Hhzlstc6WhcIs3tYsoVcoWZenKd\?sheet=6fa497/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /板块目录独立保存，暂无作者也可切换查看/);
  assert.doesNotMatch(html, /至少 1 位作者成功核验、归属该板块且处于启用状态后/);
  assert.match(product, /const rows = \[\.\.\.boards\]/, "板块列表保留整个目录，不因暂时没有作者而过滤");
  assert.match(product, /空板块保留，不混入其他作者/);
  assert.match(product, /没有符合条件的账号/);
  assert.match(html, /id="authorDefaultBoard"/);
  assert.match(html, /id="createBoardForm"/);
  assert.match(app, /defaultBoard: authorDefaultBoardName\(\)/);
  assert.match(app, /boardCatalog: preview\.boardCatalog \|\| \[\]/);
  assert.match(app, /url\.searchParams\.set\("board", state\.boardSelection\)/);
  assert.match(app, /parameters\.set\("board", state\.boardSelection\)/);
  assert.match(app, /&board=\$\{encodeURIComponent\(state\.boardSelection\)\}/);
  assert.match(app, /parameters\.set\("board", state\.boardSelection\)/);
  assert.match(app, /adoptPreferredBoardAfterLoad/);
  assert.match(app, /board\.label === "抖音主播板块"/);
  assert.match(app, /return `\$\{selection\}:\$\{period\}:\$\{reference \|\| "current"\}`/);
  assert.match(app, /likesObservedPostCount/);
  assert.match(app, /条有值/);
  assert.match(app, /function finiteNumberOrNull\(value\)/);
  assert.match(app, /typeof value === "string" && value\.trim\(\) === ""/);
  assert.doesNotMatch(app, /Number\.isFinite\(Number\(summary\.likesObservedPostCount\)\)/);
  assert.match(app, /reviewStatus, warningListText/);
  assert.match(safety, /label: "身份逐项复核"/);
  assert.match(app, /const number = finiteNumberOrNull\(value\);/);
  assert.match(app, /原本关闭的账号仍保持关闭/);
  assert.match(app, /const reportTargetCount = summary\.targetCount \|\| 0/);
  assert.match(app, /return \/作者\|名单\|核验\/\.test\(audit\.message \|\| ""\) \? "批量作者核验" : "系统审查"/);
  assert.match(app, /账号已暂停，后台正在逐项核对全部历史作品证据/);
  assert.match(app, /全部证据确认同一作者后，此前已启用的账号才会自动恢复/);
  assert.match(app, /target\.strictIdentityStatus === "rejected" \? "需补证据" : "复核中"/);
  assert.match(app, /identity_conflict: "身份信息冲突"/);
  assert.match(app, /notes: "备注"/);
  assert.match(app, /row\.notes \?\? row\.note/);
  assert.match(app, /身份冲突将保留审查记录/);
  assert.match(app, /function authorManualReviewLabel\(needsLocatorRows, identityConflictAuthors\)/);
  assert.match(app, /\["待补主页 \/ 账号证据", summary\.needsLocatorRows \|\| 0/);
  assert.match(app, /\(!autoMonitorAuthors && !manualReviewLabel\)/);
  assert.match(app, /正在保存审查：\$\{manualReviewLabel\}/);
  assert.match(app, /只有名称或缺少可唯一确认的主页 \/ 账号证据：仅保存审查，绝不加入监控/);
  assert.match(app, /这些行不会加入监控。请下载完整问题清单/);
  assert.match(app, /不会把证据不足或冲突的行自动写入监控/);
  assert.match(app, /下载完整审查清单/);
  assert.match(app, /最近任务记录（可展开回查）/);
  assert.match(app, /item\.xiaohongshuId/);
});

test("empty catalog boards stay selectable and cannot reveal another board's report", () => {
  const catalog = createBoardCatalog([{ key: "empty", name: "暂无作者的板块" }, { key: "review", name: "安澜切片矩阵", queuedCount: 6 }], targets);
  assert.equal(normalizeBoardSelection("empty", catalog), "empty");
  assert.equal(boardCounts(targets, catalog).get("empty"), 0);
  assert.equal(catalog.find((board) => board.key === "review").queuedCount, 6);
  assert.deepEqual(filterTargetsByBoard(targets, "empty", catalog), []);
  const report = scopeReportToBoard({ summary: {}, contributors: [{ targetId: 1, followersDelta: 999 }], posts: [{ target_id: 1, likes: 100 }] }, targets, catalog, "empty", { complete: true });
  assert.equal(report.summary.targetCount, 0);
  assert.equal(report.summary.followersDelta, null);
  assert.deepEqual(report.contributors, []);
  assert.deepEqual(report.posts, []);
});

test("batch board choice fills blank memberships without changing source rows or explicit boards", () => {
  const rows = [
    { name: "空白", board: "", boards: [] },
    { name: "有板块", board: "老飞宇切片矩阵", boards: [] },
    { name: "多板块", boards: ["安澜切片矩阵", "其他板块"] },
  ];
  const before = JSON.stringify(rows);
  const selected = rowsWithDefaultBoard(rows, "一条小团团切片矩阵");
  assert.deepEqual(selected[0].boards, ["一条小团团切片矩阵"]);
  assert.equal(selected[1], rows[1], "空 boards 数组不能遮盖已有 board 字段");
  assert.equal(selected[2], rows[2]);
  assert.equal(JSON.stringify(rows), before, "原始预览和源数据不得被改写");
  assert.deepEqual(rowsWithDefaultBoard(rows, ""), rows);
  assert.deepEqual(rowsWithDefaultBoard(rows, BOARD_UNASSIGNED), rows);
});

test("all three live board controls synchronize and queued lists are not presented as empty authors", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fragment = app.slice(app.indexOf("function renderBoardControls()"), app.indexOf("function renderMetrics()"));
  const element = () => ({ innerHTML: "", textContent: "", value: "", hidden: false, classList: { toggle(name, value) { this[name] = value; } } });
  const elements = Object.fromEntries(["data-board-select", "data-board-choices", "data-board-current", "data-board-summary", "data-board-empty", "data-board-empty-copy", "data-board-queue"].map((name) => [`[${name}]`, [element(), element(), element()]]));
  const fields = { "#authorDefaultBoard": element(), "#authorDefaultBoardNote": element() };
  const state = { data: { targets, boards: [{ key: "empty", name: "杨齐家切片矩阵" }, { key: "review", name: "安澜切片矩阵", queuedCount: 6 }, { key: "unsafe", name: '<img src=x onerror="alert(1)">' }] }, boardSelection: BOARD_UNASSIGNED, authorDefaultBoard: "" };
  const context = { state, BOARD_ALL, BOARD_UNASSIGNED, createBoardCatalog, normalizeBoardSelection, boardCounts, filterTargetsByBoard, escapeHtml, formatExactNumber: String, $: (selector) => fields[selector], $$: (selector) => elements[selector] || [], boardCatalog: () => createBoardCatalog(state.data.boards, state.data.targets), persistBoardSelection() {}, hydrateBoardReports() {}, async refreshBoardAutomation() {}, syncDailyReportState() {} };
  context.render = () => context.renderBoardControls();
  vm.runInNewContext(fragment, context);
  await context.selectBoard("empty");
  assert.ok(elements["[data-board-select]"].every((control) => control.value === "empty"));
  assert.ok(elements["[data-board-current]"].every((control) => control.textContent === "杨齐家切片矩阵"));
  assert.ok(elements["[data-board-summary]"].every((control) => control.textContent.includes("暂无作者")));
  assert.match(elements["[data-board-choices]"][0].innerHTML, /data-board-choice="empty" aria-pressed="true"/);
  assert.doesNotMatch(elements["[data-board-choices]"][0].innerHTML, /<img/);
  await context.selectBoard("review");
  assert.ok(elements["[data-board-select]"].every((control) => control.value === "review"));
  assert.ok(elements["[data-board-summary]"].every((control) => /0 个启用监控账号 · 6 条证据未确认/.test(control.textContent)));
  assert.ok(elements["[data-board-empty-copy]"].every((control) => !control.textContent.includes("暂无作者") && control.textContent.includes("6 条证据未确认")));
  assert.ok(elements["[data-board-empty-copy]"].every((control) => /按作品证据逐条统计，不等于未监控作者人数；同一作者可有多条记录/.test(control.textContent)));
  assert.doesNotMatch(elements["[data-board-choices]"][0].innerHTML, /名单未接入/);
  assert.ok(elements["[data-board-queue]"].every((control) => control.classList.hidden === false));
});

test("board queue detail requests keep the selected board when switching queue status", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fragment = app.slice(app.indexOf("async function openAuthorQueueDialog("), app.indexOf("function actionLabel("));
  const state = { authorQueueStatus: "all", authorQueueBoard: BOARD_ALL, authorQueueRequest: 0 };
  const urls = [];
  const context = { state, BOARD_ALL, encodeURIComponent, escapeHtml, $: () => ({ innerHTML: "" }), openDialog() {}, renderAuthorQueue() {}, async api(url) { urls.push(url); return { items: [] }; } };
  vm.runInNewContext(fragment, context);
  await context.openAuthorQueueDialog("all", "安澜切片矩阵");
  await context.openAuthorQueueDialog("rejected");
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => new URL(url, "http://localhost").searchParams.get("board") === "安澜切片矩阵"));
  assert.equal(new URL(urls[1], "http://localhost").searchParams.get("status"), "rejected");
});

test("default board submission preserves the display name instead of sending a lowercased key", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fragment = app.slice(app.indexOf("function authorDefaultBoardName()"), app.indexOf("async function selectBoard("));
  const state = { data: { boards: [{ key: "fps creator team", name: "FPS Creator Team" }], targets: [] }, authorDefaultBoard: "fps creator team", authorPreview: null };
  const context = { state, createBoardCatalog };
  vm.runInNewContext(fragment, context);
  assert.equal(context.authorDefaultBoardName(), "FPS Creator Team");
  state.authorPreview = { boardCatalog: [{ key: "new ip", name: "New IP" }] };
  state.authorDefaultBoard = "new ip";
  assert.equal(context.authorDefaultBoardName(), "New IP");
  state.authorDefaultBoard = "missing";
  assert.equal(context.authorDefaultBoardName(), "");
});

test("readonly viewers retain board queue notices regardless of auth and render order", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /<[^>]*data-board-(?:empty|queue)[^>]*data-min-role/);
  const authFunction = app.slice(app.indexOf("function setAuthenticated("), app.indexOf("function showAuthRequired("));
  const renderFunctions = app.slice(app.indexOf("function renderBoardControls()"), app.indexOf("function renderMetrics()"));
  const element = () => ({ innerHTML: "", textContent: "", value: "", classList: { toggle(name, value) { this[name] = value; } } });
  const notice = element();
  const queueButton = element();
  const importButton = element();
  const fields = Object.fromEntries(["#currentUserName", "#currentUserRole", "#userAvatar", "#authorDefaultBoard", "#authorDefaultBoardNote"].map((id) => [id, element()]));
  const elements = { "[data-board-empty]": [notice], "[data-board-queue]": [queueButton], '[data-min-role="editor"]': [importButton], '[data-min-role="admin"]': [] };
  const state = { data: { boards: [{ key: "review", name: "已录入待核验板块", queuedCount: 6 }], targets: [] }, boardSelection: "review", authorDefaultBoard: "" };
  const context = { state, BOARD_ALL, BOARD_UNASSIGNED, createBoardCatalog, normalizeBoardSelection, boardCounts, filterTargetsByBoard, escapeHtml, formatExactNumber: String, $: (selector) => fields[selector], $$: (selector) => elements[selector] || [], document: { body: { classList: { remove() {}, add() {} } } }, roleLabel: () => "查看者", boardCatalog: () => createBoardCatalog(state.data.boards), persistBoardSelection() {} };
  vm.runInNewContext(authFunction + renderFunctions, context);
  const viewer = { user: { displayName: "只读成员", role: "viewer" }, permissions: { edit: false, administer: false } };
  context.setAuthenticated(viewer);
  context.renderBoardControls();
  assert.equal(notice.classList.hidden, false);
  assert.equal(queueButton.classList.hidden, false);
  assert.equal(importButton.classList.hidden, true);
  context.setAuthenticated(viewer);
  assert.equal(notice.classList.hidden, false);
  assert.equal(queueButton.classList.hidden, false);
  assert.equal(importButton.classList.hidden, true);
});

test("late queue responses cannot overwrite a newer board selection", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fragment = app.slice(app.indexOf("async function openAuthorQueueDialog("), app.indexOf("function actionLabel("));
  const state = { authorQueueStatus: "all", authorQueueBoard: BOARD_ALL, authorQueueRequest: 0 };
  const pending = [];
  const rendered = [];
  const context = { state, BOARD_ALL, encodeURIComponent, escapeHtml, $: () => ({ innerHTML: "" }), openDialog() {}, renderAuthorQueue(result) { rendered.push(result.name); }, api() { return new Promise((resolve) => pending.push(resolve)); } };
  vm.runInNewContext(fragment, context);
  const first = context.openAuthorQueueDialog("all", "老飞宇切片矩阵");
  const second = context.openAuthorQueueDialog("all", "安澜切片矩阵");
  pending[1]({ name: "安澜切片矩阵", items: [] });
  await second;
  pending[0]({ name: "老飞宇切片矩阵", items: [] });
  await first;
  assert.deepEqual(rendered, ["安澜切片矩阵"]);
});

test("late automation response cannot put another board's counts into the current view", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fragment = app.slice(app.indexOf("async function refreshBoardAutomation("), app.indexOf("async function sync("));
  const pending = [];
  const state = { data: {}, boardSelection: "first", boardAutomation: null };
  const context = { state, BOARD_ALL, encodeURIComponent, toast() {}, api() { return new Promise((resolve) => pending.push(resolve)); } };
  vm.runInNewContext(fragment, context);
  const first = context.refreshBoardAutomation();
  state.boardSelection = "second";
  const second = context.refreshBoardAutomation();
  pending[1]({ automation: { board: "second" }, recentRuns: [], reports: {} });
  await second;
  pending[0]({ automation: { board: "first" }, recentRuns: [], reports: {} });
  await first;
  assert.equal(state.boardAutomation.automation.board, "second");
});

test("queue badge and accessible description show the selected scope, never the global count", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fragment = app.slice(app.indexOf("function renderAuthorQueueButton()"), app.indexOf("function renderSystem()"));
  const element = () => ({ textContent: "", classList: { toggle(name, value) { this[name] = value; } }, setAttribute(name, value) { this[name] = value; } });
  const fields = { "#authorQueueButton": element(), "#authorQueueButtonCount": element() };
  const state = { data: { boards: [{ key: "老飞宇切片矩阵", name: "老飞宇切片矩阵", queuedCount: 5 }], authorResolutionQueue: { pending: 28 } }, boardSelection: "老飞宇切片矩阵", boardAutomation: null };
  const context = { state, BOARD_ALL, BOARD_UNASSIGNED, boardCatalog: () => createBoardCatalog(state.data.boards), formatExactNumber: String, $: (selector) => fields[selector] };
  vm.runInNewContext(fragment, context);
  context.renderAuthorQueueButton();
  assert.equal(fields["#authorQueueButtonCount"].textContent, "5");
  assert.match(fields["#authorQueueButton"]["aria-label"], /老飞宇切片矩阵 · 5 条证据未确认（待核对或未通过）/);
  assert.match(fields["#authorQueueButton"]["aria-label"], /同一作者可有多条记录，不等于未监控作者人数/);
  state.boardSelection = BOARD_UNASSIGNED;
  context.renderAuthorQueueButton();
  assert.equal(fields["#authorQueueButtonCount"].classList.hidden, true);
  assert.doesNotMatch(fields["#authorQueueButton"]["aria-label"], /28/);
  state.boardAutomation = { authorResolutionQueue: { pending: 23 } };
  context.renderAuthorQueueButton();
  assert.equal(fields["#authorQueueButtonCount"].textContent, "23");
  assert.match(fields["#authorQueueButton"]["aria-label"], /未分板块 · 23 条作者证据待处理/);
  state.boardSelection = BOARD_ALL;
  context.renderAuthorQueueButton();
  assert.equal(fields["#authorQueueButtonCount"].textContent, "28");
});

test("evidence review describes per-record results without claiming an author's monitoring status", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const fragment = app.slice(app.indexOf("function authorQueueStateLabel("), app.indexOf("async function openAuthorQueueDialog("));
  const fields = { "#authorQueueSummary": { innerHTML: "" }, "#authorQueueList": { innerHTML: "" } };
  const context = {
    state: { authorQueueBoard: "玉麒麟切片矩阵", authorQueueStatus: "all" }, BOARD_ALL, BOARD_UNASSIGNED,
    boardCatalog: () => [{ key: "玉麒麟切片矩阵", label: "玉麒麟切片矩阵" }],
    $: (selector) => fields[selector], $$: () => [], escapeHtml, formatNumber: String,
    formatDate: () => "刚刚", platformLabel: () => "抖音", authorEvidenceHtml: () => "作品证据",
    humanizedWarningHtml: escapeHtml,
  };
  vm.runInNewContext(fragment, context);
  context.renderAuthorQueue({
    summary: { pending: 0, resolved: 1, rejected: 1, total: 2 },
    items: [
      { name: "同一作者", submittedAccountId: "12345", status: "resolved", attempts: 1 },
      { name: "同一作者", submittedAccountId: "12345", status: "rejected", attempts: 5, lastError: "本条作品身份不一致" },
    ],
  });
  assert.match(fields["#authorQueueSummary"].innerHTML, /身份与作品证据核验明细/);
  assert.match(fields["#authorQueueSummary"].innerHTML, /已通过 1 条 · 未通过 1 条/);
  assert.match(fields["#authorQueueSummary"].innerHTML, /不等于未监控作者人数；同一作者可有多条记录/);
  assert.match(fields["#authorQueueList"].innerHTML, /本条证据已通过/);
  assert.match(fields["#authorQueueList"].innerHTML, /本条证据未通过/);
  assert.match(fields["#authorQueueList"].innerHTML, /账号启用状态以监控列表为准/);
  assert.doesNotMatch(fields["#authorQueueList"].innerHTML, /未加入监控|已加入每日监控/);
  assert.match(html, /id="authorQueueDialogTitle">身份与作品证据核验明细/);
  assert.match(html, /<script type="module" src="\/app\.js\?v=[\w-]+"><\/script>/);
});

test("global submission receipts are isolated on updates and cannot be mistaken for current board monitoring status", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function renderAuthorJobs()");
  const fragment = app.slice(start, app.indexOf("function statusImpactCopy(", start));
  const panel = { dataset: {}, classList: { add(name) { this[name] = true; }, remove(name) { this[name] = false; } }, setAttribute(name, value) { this[name] = value; } };
  const fields = { "#authorJobPanel": panel, "#authorJobStatus": {}, "#authorJobBody": {} };
  const jobs = [{ id: "other-source-job", totalAuthors: 377, status: "completed", fileName: "其他板块原始表格", result: { createdCount: 3, reusedExistingCount: 4, resolution: { resolvedAuthors: 7 } } }];
  const before = JSON.stringify(jobs);
  const state = { boardSelection: "老飞宇切片矩阵", data: { authorResolutionJobs: jobs } };
  const context = { state, BOARD_ALL, $: (selector) => fields[selector], $$: () => [], escapeHtml, formatNumber: String, formatDate: () => "提交时刻" };
  vm.runInNewContext(fragment, context);
  context.renderAuthorJobs();
  assert.equal(panel.classList.hidden, false);
  const receipt = fields["#authorJobBody"].innerHTML;
  assert.match(receipt, /其他板块原始表格/);
  assert.match(receipt, /377 条提交记录（可能包含重复作者）/);
  assert.match(receipt, /新增监控<\/span><strong>3/);
  assert.match(receipt, /复用已有监控<\/span><strong>4/);
  assert.doesNotMatch(receipt, /老飞宇切片矩阵|377 个作者/);
  state.boardSelection = BOARD_ALL;
  context.renderAuthorJobs();
  assert.equal(fields["#authorJobBody"].innerHTML, receipt, "板块切换不能改写全局历史回执的统计");
  assert.equal(JSON.stringify(jobs), before, "展示不修改历史任务数据");
  state.data.authorResolutionJobs = [];
  context.renderAuthorJobs();
  assert.equal(panel.classList.hidden, true, "没有历史任务时才隐藏回执");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const updates = html.slice(html.indexOf('<section id="updates"'), html.indexOf('<section class="reports-section'));
  assert.match(updates, /id="authorJobPanel"/);
  assert.match(updates, /最近导入回执 · 全部板块/);
  assert.match(updates, /记录提交时的处理结果；后续已通过的证据以“名单证据”当前状态为准/);
  for (const page of ['overview', 'boards', 'targets']) {
    const section = html.slice(html.indexOf(`<section id="${page}"`)).split('</section>')[0];
    assert.doesNotMatch(section, /authorJobPanel/, `${page} 不能混入其他板块的全局导入回执`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import JSZip from "jszip";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authorPreviewContentSha256, canonicalAccountLocator, extractVideoId, markExistingAuthors, normalizeAccountLocator, parseAuthorSpreadsheet, validateSubmittedAccountId } from "../lib/author-spreadsheet.mjs";
import { MonitorDatabase } from "../lib/database.mjs";
import { applyAuthorEvidence, buildAuthorEvidenceRequests } from "../lib/author-resolution.mjs";

const SEC_UID = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const OTHER_SEC_UID = "MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba";

test("标点占位符不能冒充抖音账号身份，原文仍保留供核对", async () => {
  assert.deepEqual(validateSubmittedAccountId("71555289844", "抖音"), {
    value: "71555289844", raw: "71555289844", issue: null,
  });
  const invalid = validateSubmittedAccountId("?!", "抖音");
  assert.equal(invalid.value, "");
  assert.equal(invalid.raw, "?!");
  assert.match(invalid.issue, /格式异常.*不计为独立账号/);
  assert.match(validateSubmittedAccountId("没有后悔药", "抖音").issue, /格式异常/,
    "昵称误填在抖音号列时不能变成稳定账号身份");

  const preview = await parseAuthorSpreadsheet({
    buffer: Buffer.from("作者昵称,抖音号\n正常作者,71555289844\n异常作者,?!"),
    fileName: "异常账号.csv",
  });
  assert.equal(preview.rows[1].douyinId, "");
  assert.equal(preview.rows[1].submittedIdRaw, "?!");
  assert.match(preview.rows[1].submittedIdIssue, /格式异常/);
  assert.equal(preview.rows[1].status, "needs_locator");
  assert.equal(preview.summary.knownUniqueAuthors, 1);
  assert.equal(preview.summary.unresolvedIdentityRows, 1);
  assert.equal(preview.summary.uniqueAuthors, null, "存在未确认身份时不能伪造精确作者总数");
});

test("真实模板空 A 表头按板块配置恢复 19 行老飞宇和 6 行安澜且保留完整目录", async () => {
  const workbook = new ExcelJS.Workbook();
  const config = workbook.addWorksheet("板块配置");
  config.addRow(["板块名称", "备注"]);
  const names = ["杨齐家切片矩阵", "一条小团团切片矩阵", "老飞宇切片矩阵", "安澜切片矩阵", "极煌主播", "7jia主播", "奶团主播", "玉麒麟切片矩阵", "玉麒麟主播"];
  for (const name of names) config.addRow([name, "目录，允许暂无作者"]);
  const sheet = workbook.addWorksheet("作者名单");
  sheet.addRow([
    "", "平台", "作者账号名称", "作者主页链接", "抖音号", "sec_uid", "B站UID", "小红书用户ID",
    "作品ID / BVID", "作品 / 分享链接", "所属机构 / 团队", "作者分层", "内容赛道", "负责人", "填写日期", "备注",
  ]);
  for (let index = 0; index < 25; index += 1) {
    sheet.addRow([index < 19 ? "老飞宇切片矩阵" : "安澜切片矩阵", "抖音", `原表作者${index + 1}`, "", `submitted-id-${index + 1}`, "", "", "", "", "", "原表团队", "", "游戏", "原表负责人", "2026-09-08", `原备注${index + 1}`]);
  }
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "原表.xlsx" });

  assert.equal(preview.selectedSheet, "作者名单");
  assert.equal(preview.headerRow, 1);
  assert.equal(preview.dataRange, "A1:P26");
  assert.deepEqual(preview.boardCatalog, names.map((name) => ({ name })));
  assert.equal(preview.mapping.board.column, 1);
  assert.equal(preview.mapping.board.header, "", "不能伪造原表存在的表头");
  assert.equal(preview.mapping.board.inferred, true);
  assert.match(preview.mapping.board.inferenceReason, /A1 表头为空.*全部匹配.*板块配置/);
  assert.match(preview.validationWarnings.join("；"), /推断空表头的 A 列为板块/);
  assert.deepEqual(preview.rows.map((row) => row.board), [...Array(19).fill(names[2]), ...Array(6).fill(names[3])]);
  assert.deepEqual(preview.rows.map((row) => row.sourceRow), Array.from({ length: 25 }, (_, index) => index + 2));
  assert.equal(preview.rows[24].douyinId, "submitted-id-25");
  assert.equal(preview.rows[24].notes, "原备注25");
  const changed = structuredClone(preview);
  changed.boardCatalog[0].name = "篡改目录";
  assert.notEqual(authorPreviewContentSha256(preview), authorPreviewContentSha256(changed));
});

test("空表头板块推断不把数字、昵称、普通文本、混合值或已标注列当作板块", async () => {
  const cases = [
    { header: "", values: ["1", "2"] },
    { header: "", values: ["一条小团团OvO", "老飞宇卡拉彼丘"] },
    { header: "", values: ["已确认", "请关注"] },
    { header: "", values: ["老飞宇切片矩阵", "无法确定"] },
    { header: "内容赛道", values: ["老飞宇切片矩阵", "安澜切片矩阵"] },
    { header: "未知表头", values: ["老飞宇切片矩阵", "安澜切片矩阵"] },
  ];
  for (const fixture of cases) {
    const csv = `${fixture.header},作者账号名称,抖音号\n${fixture.values[0]},作者甲,ID001\n${fixture.values[1]},作者乙,ID002`;
    const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(csv), fileName: "不能猜分类.csv" });
    assert.equal(preview.mapping.board, undefined, JSON.stringify(fixture));
    assert.deepEqual(preview.rows.map((row) => row.board), ["", ""]);
  }
});

test("无目录时仅受限词缀可兜底，空白不下填且多个候选列不猜", async () => {
  const preview = await parseAuthorSpreadsheet({
    buffer: Buffer.from(",作者账号名称,抖音号\n老飞宇切片矩阵,作者甲,ID001\n,作者乙,ID002\n安澜切片矩阵,作者丙,ID003"),
    fileName: "受限词缀.csv",
  });
  assert.equal(preview.mapping.board.inferred, true);
  assert.match(preview.mapping.board.inferenceReason, /受限的板块名称词缀/);
  assert.deepEqual(preview.rows.map((row) => row.board), ["老飞宇切片矩阵", "", "安澜切片矩阵"]);
  assert.deepEqual(preview.boardCatalog, [], "推断行关系不应伪造板块配置表");
  const ambiguous = await parseAuthorSpreadsheet({
    buffer: Buffer.from(",,作者账号名称,抖音号\n老飞宇切片矩阵,安澜切片矩阵,作者甲,ID001\n安澜切片矩阵,老飞宇切片矩阵,作者乙,ID002"),
    fileName: "多个候选.csv",
  });
  assert.equal(ambiguous.mapping.board, undefined);
  assert.match(ambiguous.validationWarnings.join("；"), /多个可能的空表头板块列.*未自动选择/);
  const noAuthorHeader = await parseAuthorSpreadsheet({
    buffer: Buffer.from(",抖音号\n老飞宇切片矩阵,ID001\n安澜切片矩阵,ID002"),
    fileName: "没有明确作者表头.csv",
  });
  assert.equal(noAuthorHeader.mapping.board, undefined);
});

test("明确目录优先且不允许目录外词缀绕过，正式板块表头不覆盖", async () => {
  const workbook = new ExcelJS.Workbook();
  const config = workbook.addWorksheet("板块配置");
  config.addRow(["板块名称"]);
  config.addRow(["极煌主播"]);
  config.addRow(["极煌主播"]);
  config.addRow(["老飞宇切片矩阵"]);
  const sheet = workbook.addWorksheet("作者名单");
  sheet.addRow(["", "作者账号名称", "抖音号"]);
  sheet.addRow(["极煌主播", "作者甲", "ID001"]);
  sheet.addRow(["老飞宇切片矩阵", "作者乙", "ID002"]);
  const parse = () => workbook.xlsx.writeBuffer().then((buffer) => parseAuthorSpreadsheet({ buffer: Buffer.from(buffer), fileName: "目录优先.xlsx" }));
  const known = await parse();
  assert.deepEqual(known.boardCatalog, [{ name: "极煌主播" }, { name: "老飞宇切片矩阵" }]);
  assert.deepEqual(known.rows.map((row) => row.board), ["极煌主播", "老飞宇切片矩阵"]);
  sheet.getCell("A3").value = "未列入目录切片矩阵";
  assert.equal((await parse()).mapping.board, undefined);
  sheet.getCell("A1").value = "板块";
  const explicit = await parse();
  assert.equal(explicit.mapping.board.header, "板块");
  assert.equal(explicit.mapping.board.inferred, undefined);
  assert.equal(explicit.rows[1].board, "未列入目录切片矩阵", "正式板块列按原文读取，目录不能改写用户明确归属");
});

test("指挥台模板优先读取作者名单，识别组合表头并保留多板块归属", async () => {
  const workbook = new ExcelJS.Workbook();
  const instructions = workbook.addWorksheet("填写说明");
  instructions.addRow(["板块", "平台", "作者账号名称", "作者主页链接", "作品ID / BVID", "作品 / 分享链接", "所属机构 / 团队"]);
  for (let index = 0; index < 8; index += 1) instructions.addRow([`说明${index}`, "抖音", "示例作者", "", "", "", "示例团队"]);
  const config = workbook.addWorksheet("板块配置");
  config.addRow(["项目板块"]);
  config.addRow(["杨齐家切片矩阵"]);
  const sheet = workbook.addWorksheet("作者名单");
  sheet.addRow([
    "业务板块", "平台", "作者账号名称", "作者主页链接", "抖音号", "sec_uid", "B站UID", "小红书用户ID",
    "作品ID / BVID", "作品 / 分享链接", "所属机构 / 团队", "作者分层", "内容赛道", "负责人", "填写日期", "备注",
  ]);
  sheet.addRow(["杨齐家切片矩阵", "抖音", "作者甲", "", "DY001", SEC_UID, "", "", "", "", "团队A", "核心", "游戏", "负责人甲", "2026-09-08", "首批名单"]);
  sheet.addRow(["一条小团团切片矩阵", "抖音", "作者甲", "", "DY001", SEC_UID, "", "", "", "", "团队A", "核心", "游戏", "负责人乙", "2026-09-08", "跨板块"]);
  sheet.addRow(["杨齐家切片矩阵", "抖音", "作者甲重复", "", "DY001", SEC_UID, "", "", "", "", "团队A", "核心", "游戏", "负责人甲", "2026-09-08", "重复行"]);
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "作者监控模板.xlsx" });

  assert.equal(preview.selectedSheet, "作者名单");
  assert.equal(preview.mapping.board.header, "业务板块");
  assert.equal(preview.mapping.contentId.header, "作品ID / BVID");
  assert.equal(preview.mapping.videoLink.header, "作品 / 分享链接");
  assert.equal(preview.mapping.organization.header, "所属机构 / 团队");
  assert.equal(preview.mapping.tier.header, "作者分层");
  assert.equal(preview.mapping.category.header, "内容赛道");
  assert.equal(preview.mapping.owner.header, "负责人");
  assert.equal(preview.mapping.filledDate.header, "填写日期");
  assert.equal(preview.mapping.notes.header, "备注");
  assert.deepEqual(
    [preview.rows[0].owner, preview.rows[0].filledDate, preview.rows[0].notes],
    ["负责人甲", "2026-09-08", "首批名单"],
  );
  assert.deepEqual(preview.rows.map((row) => row.name), ["作者甲", "作者甲", "作者甲重复"]);
  assert.deepEqual(preview.rows.map((row) => row.board), ["杨齐家切片矩阵", "一条小团团切片矩阵", "杨齐家切片矩阵"]);
  assert.deepEqual(preview.rows.map((row) => row.status), ["ready", "ready", "ready"]);
  assert.match(preview.rows[2].reason, /关系资料不同.*记录冲突来源/);
  assert.equal(preview.summary.uniqueAuthors, 1);
  const reviewed = markExistingAuthors(preview, [{
    type: "account",
    provider: "public-web",
    locator: SEC_UID,
    metadata: { platform: "douyin" },
    boards: [{
      key: "杨齐家切片矩阵", name: "杨齐家切片矩阵", organization: "团队A", tier: "核心", category: "游戏",
      owner: "负责人甲", filledDate: "2026-09-08", note: "首批名单",
    }],
  }]);
  assert.deepEqual(reviewed.rows.map((row) => row.status), ["existing", "ready", "ready"]);
  assert.match(reviewed.rows[1].reason, /补充新的板块/);
  assert.equal(reviewed.summary.autoMonitorAuthors, 1, "全是已监控作者时，新板块归属仍必须可提交");
  const changed = structuredClone(preview);
  changed.rows[0].board = "老飞宇切片矩阵";
  assert.notEqual(authorPreviewContentSha256(preview), authorPreviewContentSha256(changed), "板块变更必须改变审查指纹");
});

test("同一已有板块只有关系资料完全一致才标记 existing", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("作者名单");
  sheet.addRow(["板块", "平台", "作者账号名称", "sec_uid", "所属机构 / 团队", "作者分层", "内容赛道", "负责人", "填写日期", "备注"]);
  sheet.addRow(["杨齐家切片矩阵", "抖音", "作者甲", SEC_UID, "团队A", "核心", "游戏", "负责人甲", "2026-09-08", "首批名单"]);
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "关系资料.xlsx" });
  const baseTarget = {
    type: "account",
    provider: "public-web",
    locator: SEC_UID,
    metadata: { platform: "douyin" },
    boards: [{ name: "杨齐家切片矩阵", organization: "团队A", tier: "核心", category: "游戏", owner: "负责人甲", filledDate: "2026-09-08", note: "首批名单" }],
  };

  const unchanged = markExistingAuthors(preview, [baseTarget]);
  assert.equal(unchanged.rows[0].status, "existing");

  const missingOwner = structuredClone(baseTarget);
  missingOwner.boards[0].owner = "";
  const addition = markExistingAuthors(preview, [missingOwner]);
  assert.equal(addition.rows[0].status, "ready");
  assert.match(addition.rows[0].reason, /补充负责人/);

  const differentTier = structuredClone(baseTarget);
  differentTier.boards[0].tier = "重点";
  const conflictReview = markExistingAuthors(preview, [differentTier]);
  assert.equal(conflictReview.rows[0].status, "ready");
  assert.match(conflictReview.rows[0].reason, /作者分层.*冲突审查/);
});

test("同一作者同板块的不同关系保留审查，但再次出现相同关系才去重", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("作者名单");
  sheet.addRow(["板块", "平台", "作者账号名称", "sec_uid", "所属机构 / 团队", "作者分层", "负责人", "备注"]);
  sheet.addRow(["杨齐家切片矩阵", "抖音", "作者甲", SEC_UID, "团队A", "核心", "负责人甲", "第一份关系"]);
  sheet.addRow(["杨齐家切片矩阵", "抖音", "作者甲", SEC_UID, "团队B", "重点", "负责人乙", "第二份关系"]);
  sheet.addRow(["杨齐家切片矩阵", "抖音", "作者甲", SEC_UID, "团队B", "重点", "负责人乙", "第二份关系"]);

  const preview = await parseAuthorSpreadsheet({
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: "关系冲突与重复.xlsx",
  });

  assert.deepEqual(preview.rows.map((row) => row.status), ["ready", "ready", "duplicate"]);
  assert.match(preview.rows[1].reason, /关系资料不同.*记录冲突来源/);
  assert.match(preview.rows[2].reason, /关系资料完全重复/);
  assert.equal(preview.summary.importableRows, 2);
  assert.equal(preview.summary.duplicateRows, 1);
});

test("同一行的强账号身份、平台专属字段和官方作品 ID 冲突会被阻止且保留证据", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("作者名单");
  sheet.addRow(["平台", "作者昵称", "作者主页链接", "sec_uid", "B站UID", "小红书用户ID", "作品ID / BVID", "作品 / 分享链接"]);
  sheet.addRow(["抖音", "抖音身份冲突", `https://www.douyin.com/user/${OTHER_SEC_UID}`, SEC_UID, "", "", "", ""]);
  sheet.addRow(["B站", "B站身份冲突", "https://space.bilibili.com/222222", "", "111111", "", "", ""]);
  sheet.addRow(["小红书", "小红书身份冲突", "https://www.xiaohongshu.com/user/profile/5d8f88dc0000000001005d3b", "", "", "5d8f88dc0000000001005d3a", "", ""]);
  sheet.addRow(["抖音", "抖音作品冲突", "", "", "", "", "7679097628281376036", "https://www.douyin.com/video/7679270829082823972"]);
  sheet.addRow(["B站", "B站作品冲突", "", "", "", "", "BV1xx411c7mD", "https://www.bilibili.com/video/BV1Q541167Qg"]);
  sheet.addRow(["抖音", "平台列冲突", "", "", "1809444890", "", "", ""]);
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "身份冲突.xlsx" });

  assert.deepEqual(preview.rows.map((row) => row.status), Array(6).fill("identity_conflict"));
  assert.equal(preview.summary.identityConflictRows, 6);
  assert.equal(preview.summary.skippedRows, 0, "身份冲突必须只进入独立审查分类，不能重复计入跳过");
  assert.equal(preview.summary.autoMonitorAuthors, 0);
  assert.equal(preview.rows[0].locator, SEC_UID, "冲突行必须保留原始可解析身份供人工审查");
  assert.equal(preview.rows[3].videoId, "7679097628281376036", "冲突行必须保留作品证据供人工审查");
  assert.equal(preview.rows[3].videoLink, "https://www.douyin.com/video/7679270829082823972");
  assert.match(preview.rows[0].reason, /身份冲突.*sec_uid列.*作者主页.*已阻止/);
  assert.match(preview.rows[1].reason, /B站强身份不一致/);
  assert.match(preview.rows[2].reason, /小红书强身份不一致/);
  assert.match(preview.rows[3].reason, /抖音作品身份不一致/);
  assert.match(preview.rows[4].reason, /B站作品身份不一致/);
  assert.match(preview.rows[5].reason, /平台列选择“抖音”.*B站UID/);
  assert.match(preview.validationWarnings.join("；"), /6 行强身份冲突.*阻止进入自动核验和监控/);
});

test("一致的账号和作品证据保留，作品归属进入 resolver 而不是直接声称可导入", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("作者名单");
  sheet.addRow(["平台", "作者昵称", "作者主页链接", "sec_uid", "B站UID", "小红书用户ID", "作品ID / BVID", "作品 / 分享链接"]);
  sheet.addRow(["抖音", "抖音作者", `https://www.douyin.com/user/${SEC_UID}`, SEC_UID, "", "", "7679097628281376036", "https://www.douyin.com/video/7679097628281376036"]);
  sheet.addRow(["B站", "B站作者", "https://space.bilibili.com/1809444890", "", "1809444890", "", "BV1xx411c7mD", "https://www.bilibili.com/video/BV1xx411c7mD"]);
  sheet.addRow(["小红书", "小红书作者", "https://www.xiaohongshu.com/user/profile/5d8f88dc0000000001005d3a", "", "", "5d8f88dc0000000001005d3a", "", ""]);
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "一致身份.xlsx" });

  assert.deepEqual(preview.rows.map((row) => row.status), ["resolvable", "resolvable", "ready"]);
  assert.match(preview.rows[0].reason, /必须通过公开作品反查发布者.*sec_uid \/ 主页严格一致/);
  assert.match(preview.rows[1].reason, /B站官方公开作品接口.*UID \/ 主页严格一致/);
  assert.doesNotMatch(preview.rows[0].reason, /字段完整/);
  assert.equal(preview.summary.resolvableAuthors, 2);
  assert.equal(preview.summary.autoMonitorAuthors, 3);
});

test("XLSX author import finds a later header row and reads an author-cell hyperlink", async () => {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("说明");
  summary.addRow(["使用说明"]);
  const sheet = workbook.addWorksheet("作者库");
  sheet.addRow(["2026 作者监控名单"]);
  sheet.addRow([]);
  sheet.addRow(["主播账号名称", "抖音号", "所属机构", "分层"]);
  sheet.addRow([{ text: "作者甲", hyperlink: `https://www.douyin.com/user/${SEC_UID}` }, "DY001", "机构A", "头部"]);
  sheet.addRow([{ text: "作者甲重复", hyperlink: `https://www.douyin.com/user/${SEC_UID}` }, "DY002", "机构A", "头部"]);
  sheet.addRow(["作者乙", "123456789", "机构B", "腰部"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const preview = await parseAuthorSpreadsheet({ buffer, fileName: "作者名单.xlsx" });
  assert.equal(preview.selectedSheet, "作者库");
  assert.equal(preview.headerRow, 3);
  assert.equal(preview.mapping.name.header, "主播账号名称");
  assert.equal(preview.rows[0].locator, SEC_UID);
  assert.equal(preview.rows[0].status, "ready");
  assert.equal(preview.rows[0].organization, "机构A");
  assert.equal(preview.rows[1].status, "duplicate");
  assert.equal(preview.rows[2].status, "needs_locator");
  assert.equal(preview.summary.importableRows, 1);
  assert.equal(preview.summary.duplicateRows, 1);
  assert.equal(preview.summary.needsLocatorRows, 1);
});

test("CSV import handles quoted author names and flags database-existing accounts", async () => {
  const csv = `作者昵称,抖音主页,赛道\n"作者,甲",https://www.douyin.com/user/${SEC_UID},游戏\n作者乙,987654321,生活\n`;
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(csv), fileName: "作者.csv" });
  assert.equal(preview.rows[0].name, "作者,甲");
  assert.equal(preview.rows[0].locator, SEC_UID);
  assert.equal(preview.rows[1].status, "needs_locator");
  const reviewed = markExistingAuthors(preview, [{ type: "account", provider: "public-web", locator: "https://v.douyin.com/old-link", known_author_id: SEC_UID }]);
  assert.equal(reviewed.rows[0].status, "existing");
  assert.equal(reviewed.summary.existingRows, 1);
  assert.equal(reviewed.summary.importableRows, 0);
});

test("creator-content workbooks recognize 创作者昵称 and choose the detail sheet", async () => {
  const workbook = new ExcelJS.Workbook();
  const overview = workbook.addWorksheet("数据总览");
  overview.addRow(["参与内容数据总览"]);
  overview.addRow([]);
  overview.addRow(["排名", "创作者", "播放量", "内容ID"]);
  overview.addRow([1, "摘要作者", 1000, "V1"]);
  const detail = workbook.addWorksheet("数据明细");
  detail.addRow(["创作者昵称（必填）", "抖音号", "内容ID", "视频标题", "播放量", "视频链接"]);
  detail.addRow(["作者甲", "DY001", "7679097628281376036", "作品一", 1000, "https://www.douyin.com/video/7679097628281376036"]);
  detail.addRow(["作者乙", "DY002", "7679270829082823972", "作品二", 2000, "https://www.douyin.com/video/7679270829082823972"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const preview = await parseAuthorSpreadsheet({ buffer, fileName: "参与内容数据.xlsx" });
  assert.equal(preview.selectedSheet, "数据明细");
  assert.equal(preview.headerRow, 1);
  assert.equal(preview.mapping.name.header, "创作者昵称（必填）");
  assert.equal(preview.mapping.douyinId.header, "抖音号");
  assert.equal(preview.mapping.contentId.header, "内容ID");
  assert.equal(preview.mapping.videoLink.header, "视频链接");
  assert.deepEqual(preview.rows.map((row) => row.name), ["作者甲", "作者乙"]);
  assert.deepEqual(preview.rows.map((row) => row.douyinId), ["DY001", "DY002"]);
  assert.deepEqual(preview.rows.map((row) => row.videoId), ["7679097628281376036", "7679270829082823972"]);
  assert.deepEqual(preview.rows.map((row) => row.status), ["resolvable", "resolvable"]);
  assert.equal(preview.summary.totalRows, 2);
  assert.equal(preview.summary.importableRows, 0);
  assert.equal(preview.summary.needsLocatorRows, 0);
  assert.equal(preview.summary.resolvableAuthors, 2);
  assert.equal(preview.summary.autoMonitorAuthors, 2);
  assert.equal(preview.summary.uniqueAuthors, 2);
  const samePreview = await parseAuthorSpreadsheet({ buffer, fileName: "再次导出.xlsx" });
  assert.equal(authorPreviewContentSha256(preview), authorPreviewContentSha256(samePreview));
  const changedPreview = structuredClone(samePreview);
  changedPreview.rows[0].name = "被修改的作者";
  assert.notEqual(authorPreviewContentSha256(preview), authorPreviewContentSha256(changedPreview));
});

test("author name is optional when a profile or public video is available", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("身份线索");
  sheet.addRow(["sec_uid", "内容ID"]);
  sheet.addRow([SEC_UID, ""]);
  sheet.addRow(["", "7679270829082823972"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const preview = await parseAuthorSpreadsheet({ buffer, fileName: "身份线索.xlsx" });
  assert.equal(preview.rows[0].name, "");
  assert.equal(preview.rows[0].locator, SEC_UID);
  assert.equal(preview.rows[0].status, "ready");
  assert.match(preview.rows[0].reason, /自动补全作者名称/);
  assert.equal(preview.rows[1].status, "resolvable");
  assert.match(preview.rows[1].reason, /公开作品.*确认发布作者/);
  assert.equal(preview.summary.autoMonitorAuthors, 2);
});

test("玉麒麟结算表识别作者和发布链接，保留主页及 modal 作品证据且不导入结算指标", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("8月");
  sheet.addRow([
    "抖音名字", "账号ID", "发布链接", "最终结算播放量", "最终结算点赞",
    "最终结算评论", "最终结算收藏", "最终结算截图证明",
  ]);
  const profileUrl = `https://www.douyin.com/user/${SEC_UID}?from_tab_name=main&modal_id=7677513556136430884`;
  const searchUrl = "https://www.douyin.com/jingxuan/search/%E4%BA%91%E6%97%AC?aid=6383&modal_id=7678987860875234614&type=general";
  const shareText = "复制打开抖音 https://v.douyin.com/AbCdEfG/ 看作品";
  sheet.addRow(["云旬（玉麒麟切片）", "58260466888", profileUrl, 123456, 1234, 56, 78, "结算截图"]);
  sheet.addRow(["云旬（玉麒麟切片）", "58260466888", searchUrl, 654321, 4321, 65, 87, "结算截图"]);
  sheet.addRow(["临舟（玉麒麟切片）", "52733715193", shareText, 987654, 9876, 54, 32, "结算截图"]);
  const preview = await parseAuthorSpreadsheet({
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "玉麒麟寒川8月结算表.xlsx",
  });

  assert.equal(preview.mapping.name.header, "抖音名字");
  assert.equal(preview.mapping.douyinId.header, "账号ID");
  assert.equal(preview.mapping.videoLink.header, "发布链接");
  assert.deepEqual(Object.keys(preview.mapping).sort(), ["douyinId", "name", "videoLink"]);
  assert.deepEqual(preview.rows.map((row) => row.sourceRow), [2, 3, 4]);
  assert.deepEqual(preview.rows.map((row) => row.status), ["resolvable", "resolvable", "resolvable"]);
  assert.equal(preview.rows[0].name, "云旬（玉麒麟切片）");
  assert.equal(preview.rows[0].douyinId, "58260466888");
  assert.equal(preview.rows[0].locator, SEC_UID);
  assert.equal(preview.rows[0].videoId, "7677513556136430884");
  assert.equal(preview.rows[0].videoLink, profileUrl);
  assert.match(preview.rows[0].reason, /账号与作品均已提供.*严格一致/);
  assert.equal(preview.rows[1].locator, null, "搜索词不能变成作者身份");
  assert.equal(preview.rows[1].videoId, "7678987860875234614");
  assert.equal(preview.rows[1].videoLink, searchUrl);
  assert.equal(preview.rows[2].shareUrl, "https://v.douyin.com/AbCdEfG/");
  assert.equal(preview.rows[2].videoLink, shareText);
  for (const row of preview.rows) {
    assert.equal(Object.keys(row).some((key) => /play|like|comment|collect|metric|snapshot/i.test(key)), false);
  }
});

test("飞书空 t 加富文本导出完整保留可见账号文字及短链，不采用自动超链接的局部显示名", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  const shareUrl = "https://v.douyin.com/Cu0tbcEzFXY/";
  const selfShareUrl = "https://v.douyin.com/MK98D_46tFc/";
  const profileLink = `https://www.douyin.com/user/${SEC_UID}?modal_id=7684617087687331118`;
  const selfLink = `https://www.douyin.com/user/self?modal_id=7684675001341005096&sec_uid=${OTHER_SEC_UID}`;
  sheet.addRow(["抖音名字", "抖音号", "视频链接"]);
  sheet.addRow([
    { text: "RICH_NAME_PLACEHOLDER", hyperlink: `https://www.douyin.com/user/${SEC_UID}` },
    { text: "RICH_ID_PLACEHOLDER", hyperlink: "http://Ni.De", tooltip: "Ni.De" },
    { text: "RICH_SHARE_PLACEHOLDER", hyperlink: profileLink },
  ]);
  sheet.addRow(["小欣ovo", "75421710453", { text: "RICH_SELF_SHARE_PLACEHOLDER", hyperlink: selfLink }]);
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  let strings = await zip.file("xl/sharedStrings.xml").async("string");
  const replacements = [
    ["RICH_NAME_PLACEHOLDER", "<t></t><r><t>团水&amp;</t></r><r><t>解说&#x1F600;</t></r><rPh sb=\"0\" eb=\"1\"><t>拼音不属于可见名称</t></rPh>"],
    ["RICH_ID_PLACEHOLDER", "<t></t><r><rPr><u val=\"single\"/></rPr><t>Ni.De</t></r><r><t>.GIRL_LMZW</t></r>"],
    ["RICH_SHARE_PLACEHOLDER", `<t></t><r><t xml:space="preserve">  ${shareUrl} </t></r>`],
    ["RICH_SELF_SHARE_PLACEHOLDER", `<t></t><r><t>${selfShareUrl}</t></r>`],
  ];
  for (const [placeholder, richText] of replacements) {
    const original = `<si><t>${placeholder}</t></si>`;
    assert.ok(strings.includes(original), `fixture must replace ${placeholder}`);
    strings = strings.replace(original, `<si>${richText}</si>`);
  }
  zip.file("xl/sharedStrings.xml", strings);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const preview = await parseAuthorSpreadsheet({ buffer, fileName: "飞书真实富文本结构.xlsx" });
  assert.equal(preview.parserMode, "compatible");
  assert.equal(preview.summary.totalRows, 2, "双证据不展开或伪增源行数");
  assert.equal(preview.rows[0].name, "团水&解说😀");
  assert.equal(preview.rows[0].douyinId, "Ni.De.GIRL_LMZW");
  assert.equal(preview.rows[0].videoLink, shareUrl);
  assert.equal(preview.rows[0].videoHyperlink, profileLink);
  assert.equal(preview.rows[0].shareUrl, shareUrl);
  assert.equal(preview.rows[0].videoId, "7684617087687331118");
  assert.equal(preview.rows[0].locator, SEC_UID);
  assert.equal(preview.rows[1].videoLink, selfShareUrl);
  assert.equal(preview.rows[1].videoHyperlink, selfLink);
  assert.equal(preview.rows[1].shareUrl, selfShareUrl);
  assert.equal(preview.rows[1].videoId, "7684675001341005096");
  assert.equal(preview.rows[1].locator, null, "self 及其 sec_uid 参数不是作者身份");
  assert.deepEqual(preview.rows.map((row) => row.status), ["resolvable", "resolvable"]);

  const requests = buildAuthorEvidenceRequests(preview.rows);
  assert.deepEqual(requests.map((item) => item.videoIds), [["7684617087687331118"], ["7684675001341005096"]]);
  assert.deepEqual(requests.map((item) => item.shareUrls), [[shareUrl], [selfShareUrl]]);
  const candidate = { videoId: "7684617087687331118", secUid: SEC_UID, uniqueId: "Ni.De.GIRL_LMZW", nickname: "团水&解说😀" };
  const partial = applyAuthorEvidence([preview.rows[0]], { items: [{ key: requests[0].key, candidates: [candidate], errors: [] }] });
  assert.notEqual(partial.rows[0].status, "ready", "只核验隐藏 modal 不能跳过可见短链");
  const complete = applyAuthorEvidence([preview.rows[0]], { items: [{ key: requests[0].key, candidates: [{ ...candidate, sourceEvidenceUrl: shareUrl }], errors: [] }] });
  assert.equal(complete.rows[0].status, "ready");
});

test("标准超链接单元格保留可见名称与账号，作品隐藏目标不能替代可见证据", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("作者名单");
  sheet.addRow(["作者昵称", "账号ID", "视频链接"]);
  const visibleShare = "https://v.douyin.com/VisibleCase/";
  sheet.addRow([
    { text: "可见作者名", hyperlink: `https://www.douyin.com/user/${SEC_UID}` },
    { text: "Ni.De.GIRL_LMZW", hyperlink: "http://Ni.De" },
    { text: visibleShare, hyperlink: `https://www.douyin.com/user/${SEC_UID}?modal_id=7684617087687331118` },
  ]);
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "标准超链接.xlsx" });
  assert.equal(preview.parserMode, "standard");
  assert.equal(preview.rows[0].name, "可见作者名");
  assert.equal(preview.rows[0].douyinId, "Ni.De.GIRL_LMZW");
  assert.equal(preview.rows[0].videoLink, visibleShare);
  assert.equal(preview.rows[0].shareUrl, visibleShare);
  assert.equal(preview.rows[0].videoId, "7684617087687331118");
  assert.equal(preview.rows[0].status, "resolvable");
});

test("同一行多条不同短链不能静默选择一条放行，同一条重复显示不误报", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("作者名单");
  sheet.addRow(["作者昵称", "账号ID", "视频链接"]);
  const first = "https://v.douyin.com/CaseSensitiveA/";
  const second = "https://v.douyin.com/CaseSensitiveB/";
  sheet.addRow(["作者甲", "DY001", { text: first, hyperlink: second }]);
  sheet.addRow(["作者乙", "DY002", `复制打开 ${first} 以及 ${second}`]);
  sheet.addRow(["作者丙", "DY003", { text: first, hyperlink: first }]);
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "多条短链.xlsx" });
  assert.deepEqual(preview.rows.map((row) => row.status), ["needs_locator", "needs_locator", "resolvable"]);
  for (const row of preview.rows.slice(0, 2)) {
    assert.match(row.reason, /2 条不同的官方分享链接.*已阻止自动处理/);
    assert.ok(row.reason.includes(first) && row.reason.includes(second), "未承载的第二条证据也必须明确呈现");
  }
  assert.equal(preview.summary.needsLocatorRows, 2);
  assert.equal(preview.summary.autoMonitorAuthors, 1);
  assert.equal(preview.rows[0].videoHyperlink, second);
  const changed = structuredClone(preview);
  changed.rows[0].videoHyperlink = "https://v.douyin.com/DifferentHiddenEvidence/";
  assert.notEqual(authorPreviewContentSha256(preview), authorPreviewContentSha256(changed), "可见文字不变时，隐藏证据变化也必须改变内容指纹");
});

test("modal_id 作品证据只接受精确官方 HTTPS 域名和有效视频 ID", () => {
  const videoId = "7677513556136430884";
  for (const url of [
    `https://www.douyin.com/user/${SEC_UID}?modal_id=${videoId}`,
    `https://douyin.com/jingxuan/search/author?modal_id=${videoId}`,
    `https://www.douyin.com/jingxuan/search/author?aweme_id=&modal_id=${videoId}`,
  ]) assert.equal(extractVideoId(url), videoId, url);
  for (const url of [
    `https://example.com/user/${SEC_UID}?modal_id=${videoId}`,
    `https://www.douyin.com.evil.example/user/${SEC_UID}?modal_id=${videoId}`,
    `http://www.douyin.com/user/${SEC_UID}?modal_id=${videoId}`,
    `https://user:password@www.douyin.com/user/${SEC_UID}?modal_id=${videoId}`,
    `https://www.douyin.com:8443/user/${SEC_UID}?modal_id=${videoId}`,
    `https://evil.example/https://www.douyin.com/user/${SEC_UID}?modal_id=${videoId}`,
    "https://www.douyin.com/jingxuan/search/author?modal_id=1234",
    `https://www.douyin.com/jingxuan/search/author?modal_id=${videoId}text`,
  ]) assert.equal(extractVideoId(url), null, url);
});

test("发布链接中的主页和全部作品参数参与身份冲突审查", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("发布证据");
  sheet.addRow(["抖音名字", "账号ID", "sec_uid", "发布链接"]);
  sheet.addRow(["作者甲", "DY001", SEC_UID, `https://www.douyin.com/user/${OTHER_SEC_UID}?modal_id=7677513556136430884`]);
  sheet.addRow(["作者乙", "DY002", "", "https://www.douyin.com/jingxuan/search/author?aweme_id=7677513556136430884&modal_id=7678987860875234614"]);
  sheet.addRow(["作者丙", "DY003", "", "https://www.douyin.com/jingxuan/search/author?modal_id=7677513556136430884&modal_id=7678987860875234614"]);
  const preview = await parseAuthorSpreadsheet({
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "发布证据冲突.xlsx",
  });
  assert.deepEqual(preview.rows.map((row) => row.status), Array(3).fill("identity_conflict"));
  assert.match(preview.rows[0].reason, /强身份不一致.*作品 \/ 分享链接中的主页/);
  assert.match(preview.rows[1].reason, /作品身份不一致/);
  assert.match(preview.rows[2].reason, /作品身份不一致/);
  assert.equal(preview.summary.autoMonitorAuthors, 0);
});

test("用户主页下的 search 子路径仅保留 modal 作品，不把搜索上下文误认成发布作者", async () => {
  const videoId = "7677513556136430884";
  const searchUrl = `https://www.douyin.com/user/${OTHER_SEC_UID}/search/96856902135?aid=6383&modal_id=${videoId}&type=general`;
  for (const url of [searchUrl, `${searchUrl}&sec_uid=${OTHER_SEC_UID}`]) {
    assert.equal(normalizeAccountLocator(url), null);
    assert.equal(extractVideoId(url), videoId);
  }
  assert.equal(normalizeAccountLocator(`https://www.douyin.com/user/${SEC_UID}/?modal_id=${videoId}`), SEC_UID);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("8月");
  sheet.addRow(["抖音名字", "账号ID", "sec_uid", "发布链接"]);
  sheet.addRow(["星叙（玉麒麟切片）", "96856902135", "", searchUrl]);
  sheet.addRow(["星叙（玉麒麟切片）", "96856902135", SEC_UID, searchUrl]);
  sheet.addRow(["星叙（玉麒麟切片）", "96856902135", SEC_UID, `https://www.douyin.com/user/${OTHER_SEC_UID}?modal_id=${videoId}`]);
  const preview = await parseAuthorSpreadsheet({
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "用户搜索结果.xlsx",
  });
  assert.deepEqual(preview.rows.map((row) => row.status), ["resolvable", "resolvable", "identity_conflict"]);
  assert.deepEqual(preview.rows.map((row) => row.videoId), Array(3).fill(videoId));
  assert.equal(preview.rows[0].locator, null);
  assert.equal(preview.rows[0].videoLink, searchUrl);
  assert.equal(preview.rows[1].locator, SEC_UID, "保留显式提交的强身份并与作品核验");
  assert.equal(preview.rows[1].identityConflict, null);
  assert.match(preview.rows[2].reason, /强身份不一致/, "真正的主页不能丢掉身份约束");
});

test("only official profile/share links or sec_uid values are accepted", () => {
  assert.equal(normalizeAccountLocator("123456789"), null);
  assert.equal(normalizeAccountLocator("https://example.com/user/test"), null);
  assert.equal(normalizeAccountLocator(`https://www.douyin.com/user/${SEC_UID}?from_tab_name=main`), SEC_UID);
  assert.equal(normalizeAccountLocator("复制打开 https://v.douyin.com/AbCdEfG/ 看主页"), "https://v.douyin.com/AbCdEfG");
  assert.equal(normalizeAccountLocator(`https://alice:secret@evil.example/user/${SEC_UID}`), null);
  assert.equal(normalizeAccountLocator(`http://www.douyin.com/user/${SEC_UID}`), null);
  assert.equal(normalizeAccountLocator(`https://www.douyin.com:8443/user/${SEC_UID}`), null);
  assert.equal(normalizeAccountLocator(`https://evil.example/https://www.douyin.com/user/${SEC_UID}`), null);
  assert.equal(canonicalAccountLocator(SEC_UID), `secuid:${SEC_UID}`);
  assert.equal(normalizeAccountLocator("1809444890", "bilibili"), "1809444890");
  assert.equal(canonicalAccountLocator("https://space.bilibili.com/1809444890", "bilibili"), "bilibili:1809444890");
  assert.equal(
    normalizeAccountLocator("https://www.xiaohongshu.com/user/profile/5d8f88dc0000000001005d3a?xsec_token=temporary", "xiaohongshu"),
    "https://www.xiaohongshu.com/user/profile/5d8f88dc0000000001005d3a",
  );
  assert.equal(normalizeAccountLocator("https://user@www.xiaohongshu.com/user/profile/5d8f88dc0000000001005d3a", "xiaohongshu"), null);
  assert.equal(normalizeAccountLocator("https://www.xiaohongshu.com:8443/user/profile/5d8f88dc0000000001005d3a", "xiaohongshu"), null);
  assert.equal(normalizeAccountLocator("https://example.com/https://www.xiaohongshu.com/user/profile/5d8f88dc0000000001005d3a", "xiaohongshu"), null);
  assert.equal(extractVideoId("https://example.com/video/7679097628281376036"), null);
  assert.equal(extractVideoId("https://www.douyin.com/video/7679097628281376036"), "7679097628281376036");
});

test("a Douyin short share link is queued for public expansion instead of imported as an account", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("短链");
  sheet.addRow(["分享链接"]);
  sheet.addRow(["https://v.douyin.com/AbCdEfG/"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const preview = await parseAuthorSpreadsheet({ buffer, fileName: "短链.xlsx" });
  assert.equal(preview.rows[0].locator, null);
  assert.equal(preview.rows[0].shareUrl, "https://v.douyin.com/AbCdEfG/");
  assert.equal(preview.rows[0].status, "resolvable");
  assert.equal(preview.summary.autoMonitorAuthors, 1);
});

test("preview author counts prefer account and work evidence over display names", async () => {
  async function previewRows(rows, fileName) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("作者证据");
    sheet.addRow(["作者昵称", "sec_uid", "内容ID"]);
    rows.forEach((row) => sheet.addRow(row));
    return parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName });
  }

  const sameNameDifferentWorks = await previewRows([
    ["同名作者", "", "7679097628281376036"],
    ["同名作者", "", "7679270829082823972"],
  ], "同名不同作品.xlsx");
  assert.deepEqual(sameNameDifferentWorks.rows.map((row) => row.status), ["resolvable", "resolvable"]);
  assert.equal(sameNameDifferentWorks.summary.uniqueAuthors, null, "作品证据尚未返回发布者身份时，不得冒称已知作者总数");
  assert.equal(sameNameDifferentWorks.summary.knownUniqueAuthors, 0);
  assert.equal(sameNameDifferentWorks.summary.unresolvedIdentityRows, 2);
  assert.equal(sameNameDifferentWorks.summary.resolvableAuthors, 2);
  assert.equal(sameNameDifferentWorks.summary.autoMonitorAuthors, 2);

  const differentNamesSameWork = await previewRows([
    ["作者甲", "", "7679097628281376036"],
    ["作者乙", "", "7679097628281376036"],
  ], "同作品不同名称.xlsx");
  assert.equal(differentNamesSameWork.summary.uniqueAuthors, null, "同一作品线索仍需公开证据返回账号身份");
  assert.equal(differentNamesSameWork.summary.knownUniqueAuthors, 0);
  assert.equal(differentNamesSameWork.summary.unresolvedIdentityRows, 2);
  assert.equal(differentNamesSameWork.summary.resolvableAuthors, 1);
  assert.equal(differentNamesSameWork.summary.autoMonitorAuthors, 1);

  const sameAccountDifferentWorks = await previewRows([
    ["作者甲", SEC_UID, "7679097628281376036"],
    ["作者乙", SEC_UID, "7679270829082823972"],
  ], "同账号不同作品.xlsx");
  assert.deepEqual(sameAccountDifferentWorks.rows.map((row) => row.status), ["resolvable", "resolvable"]);
  assert.equal(sameAccountDifferentWorks.summary.uniqueAuthors, 1);
  assert.equal(sameAccountDifferentWorks.summary.knownUniqueAuthors, 1);
  assert.equal(sameAccountDifferentWorks.summary.unresolvedIdentityRows, 0);
  assert.equal(sameAccountDifferentWorks.summary.autoMonitorAuthors, 1);
});

test("same-name author rows without account evidence are not falsely collapsed into one unique author", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("仅作者名称");
  sheet.addRow(["作者名称", "业务板块"]);
  sheet.addRow(["同名作者", "板块甲"]);
  sheet.addRow(["同名作者", "板块乙"]);
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "同名无身份锚点.xlsx" });

  assert.equal(preview.rows.length, 2, "不得因名称相同而删除任一来源行");
  assert.deepEqual(preview.rows.map((row) => row.status), ["needs_locator", "needs_locator"]);
  assert.equal(preview.summary.identityCountVersion, 2);
  assert.equal(preview.summary.knownUniqueAuthors, 0);
  assert.equal(preview.summary.unresolvedIdentityRows, 2, "按来源行报告身份不确定，不把行数说成作者人数");
  assert.equal(preview.summary.uniqueAuthors, null, "身份不确定时总人数必须明确为未知");
  assert.equal(preview.summary.autoMonitorAuthors, 0, "仅凭名称不能自动创建监控账号");
});

test("Douyin shares and Bilibili BV evidence can enter anonymous author resolution", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("平台能力边界");
  sheet.addRow(["平台", "作者昵称", "作品链接"]);
  sheet.addRow(["B站", "作者B", "https://b23.tv/AbCdEfG"]);
  sheet.addRow(["小红书", "作者红", "https://xhslink.com/a/AbCdEfG"]);
  sheet.addRow(["抖音", "作者抖", "https://v.douyin.com/AbCdEfG/"]);
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "平台能力边界.xlsx" });

  assert.deepEqual(preview.rows.map((row) => row.platform), ["bilibili", "xiaohongshu", "douyin"]);
  assert.deepEqual(preview.rows.map((row) => row.status), ["resolvable", "needs_locator", "resolvable"]);
  assert.match(preview.rows[0].reason, /B站官方公开作品接口.*昵称严格一致/);
  assert.match(preview.rows[1].reason, /小红书不能.*匿名反查.*用户 ID 或官方主页/);
  assert.equal(preview.summary.autoMonitorAuthors, 2);
});

test("Bilibili BV IDs and canonical video links stay separate for same-name authors", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("B站作品证据");
  sheet.addRow(["作者昵称", "BVID", "作品链接"]);
  sheet.addRow(["同名作者", "BV1xx411c7mD", ""]);
  sheet.addRow(["同名作者", "", "https://www.bilibili.com/video/BV1Q541167Qg/?spm_id_from=333.999.0.0"]);
  const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "B站同名作者.xlsx" });

  assert.deepEqual(preview.rows.map((row) => row.platform), ["bilibili", "bilibili"]);
  assert.deepEqual(preview.rows.map((row) => row.videoId), ["BV1xx411c7mD", "BV1Q541167Qg"]);
  assert.deepEqual(preview.rows.map((row) => row.status), ["resolvable", "resolvable"]);
  assert.equal(preview.summary.uniqueAuthors, null, "两个B站作品没有回传UID前不能称为两位作者");
  assert.equal(preview.summary.knownUniqueAuthors, 0);
  assert.equal(preview.summary.unresolvedIdentityRows, 2);
  assert.equal(preview.summary.resolvableAuthors, 2);
  assert.equal(preview.summary.autoMonitorAuthors, 2);
});

test("Bilibili video evidence requires an exact credential-free HTTPS official host", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("B站链接边界");
  sheet.addRow(["平台", "作者昵称", "作品链接"]);
  sheet.addRow(["B站", "官方作者", "https://www.bilibili.com/video/BV1Q541167Qg/?share_source=copy_web"]);
  sheet.addRow(["B站", "伪域名", "https://evilbilibili.com/video/BV1Q541167Qg"]);
  sheet.addRow(["B站", "明文链接", "http://www.bilibili.com/video/BV1Q541167Qg"]);
  sheet.addRow(["B站", "带凭据", "https://user@www.bilibili.com/video/BV1Q541167Qg"]);
  sheet.addRow(["B站", "自定义端口", "https://www.bilibili.com:8443/video/BV1Q541167Qg"]);
  sheet.addRow(["", "明文短链", "http://b23.tv/unsafe"]);
  const preview = await parseAuthorSpreadsheet({
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: "B站链接边界.xlsx",
  });

  assert.equal(preview.rows[0].videoId, "BV1Q541167Qg");
  assert.equal(preview.rows[0].status, "resolvable");
  for (const row of preview.rows.slice(1)) {
    assert.equal(row.videoId, null);
    assert.equal(row.shareUrl, "");
    assert.equal(row.status, "needs_locator");
  }
  assert.equal(preview.summary.autoMonitorAuthors, 1);
});

test("mixed-platform workbook detects Bilibili and Xiaohongshu account identities", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("跨平台作者");
  sheet.addRow(["平台", "作者昵称", "B站UID", "小红书用户ID", "主页链接"]);
  sheet.addRow(["B站", "作者B", "1809444890", "", ""]);
  sheet.addRow(["小红书", "作者红", "", "5d8f88dc0000000001005d3a", ""]);
  sheet.addRow(["抖音", "作者抖", "", "", `https://www.douyin.com/user/${SEC_UID}`]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const preview = await parseAuthorSpreadsheet({ buffer, fileName: "跨平台名单.xlsx" });
  assert.deepEqual(preview.rows.map((row) => row.platform), ["bilibili", "xiaohongshu", "douyin"]);
  assert.deepEqual(preview.rows.map((row) => row.status), ["ready", "ready", "ready"]);
  assert.equal(preview.rows[0].locator, "1809444890");
  assert.equal(preview.rows[1].locator, "https://www.xiaohongshu.com/user/profile/5d8f88dc0000000001005d3a");
  assert.equal(preview.summary.uniqueAuthors, 3);
});

test("compatibility parser reads a legacy Excel binary even when it has an xlsx extension", async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["作者昵称", "抖音主页", "所属机构"],
    ["兼容作者", `https://www.douyin.com/user/${SEC_UID}`, "兼容机构"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "作者库");
  const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xls" }));
  const preview = await parseAuthorSpreadsheet({ buffer, fileName: "旧系统导出.xlsx" });
  assert.equal(preview.parserMode, "compatible");
  assert.equal(preview.detectedFormat, "legacy-excel");
  assert.equal(preview.rows[0].name, "兼容作者");
  assert.equal(preview.rows[0].locator, SEC_UID);
  assert.equal(preview.summary.importableRows, 1);
  assert.match(preview.validationWarnings.join("；"), /扩展名与内部格式不一致/);
});

test("invalid binary workbooks return a precise format error", async () => {
  await assert.rejects(
    parseAuthorSpreadsheet({ buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), fileName: "伪造.xlsx" }),
    /不是可识别的 Excel 工作簿|结构无法解析/,
  );
});

test("bulk author import is transactional, idempotent and writes an audit fingerprint", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-author-import-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const input = [{ label: "作者甲", locator: SEC_UID, metadata: { importSource: { fileName: "作者.xlsx", sourceRow: 4 } } }];
  const first = database.importAuthorTargets(input, { fileName: "作者.xlsx", sheetName: "作者库", reviewedRows: 3, skippedCount: 2 });
  const second = database.importAuthorTargets(input, { fileName: "作者.xlsx", sheetName: "作者库", reviewedRows: 1, skippedCount: 0 });
  assert.equal(first.created.length, 1);
  assert.equal(second.created.length, 0);
  assert.equal(second.skipped.length, 1);
  const overview = database.getOverview();
  assert.equal(overview.targets.length, 1);
  assert.match(overview.audits[0].message, /新增 0 个监控/);
  assert.ok(overview.audits[0].source_checksum);
});

test('spreadsheet automatic domain links preserve dotted public IDs without accepting misleading URLs',()=>{
 const raw='[Ni.De](http://Ni.De).GIRL_LMZW';
 assert.deepEqual(validateSubmittedAccountId(raw),{value:'Ni.De.GIRL_LMZW',raw,issue:null});
 for(const x of ['[real.id](https://other.invalid).account','[real.id](https://real.id/path).account','[real.id](https://real.id/?token=[REDACTED]','[real.id](https://user@real.id).account','https://real.id'])assert.equal(validateSubmittedAccountId(x).value,'');
});

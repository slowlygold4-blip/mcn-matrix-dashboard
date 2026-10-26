import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import { exportLarkSheetWorkbook, larkExportArguments, larkWorkbookInfoArguments, normalizeLarkSheetUrl, requestedLarkSheetId, resolveLarkCliCommand } from "../lib/lark-sheet-source.mjs";
import { filterAnonymousState } from "../scripts/douyin_browser_resolver.mjs";

test("Lark sheet source only accepts official HTTPS spreadsheet URLs", () => {
  assert.equal(
    normalizeLarkSheetUrl("https://bytedance.larkoffice.com/sheets/SLe2sW0xQhr5bOtYTZ7cEg8Cnyg?sheet=abc#x"),
    "https://bytedance.larkoffice.com/sheets/SLe2sW0xQhr5bOtYTZ7cEg8Cnyg?sheet=abc",
  );
  assert.equal(requestedLarkSheetId("https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp?sheet=Sheet_2"), "Sheet_2");
  assert.equal(
    normalizeLarkSheetUrl("https://example.feishu.cn/spreadsheets/AbCdEfGhIjKlMnOp"),
    "https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp",
  );
  assert.equal(
    normalizeLarkSheetUrl("https://example.larksuite.com/sheets/AbCdEfGhIjKlMnOp"),
    "https://example.larksuite.com/sheets/AbCdEfGhIjKlMnOp",
  );
  assert.throws(() => normalizeLarkSheetUrl("http://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp"), /HTTPS/);
  assert.throws(() => normalizeLarkSheetUrl("https://evil-larkoffice.com/sheets/AbCdEfGhIjKlMnOp"), /官方/);
  assert.throws(() => normalizeLarkSheetUrl("https://example.feishu.cn/wiki/AbCdEfGhIjKlMnOp"), /知识库/);
  assert.throws(() => normalizeLarkSheetUrl("https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp?sheet=%2Fbad"), /工作表 ID/);
});

test("Lark sheet selection survives normalization, both CLI calls and source readback", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("说明").addRow(["说明"]);
  const authorSheet = workbook.addWorksheet("作者明细");
  authorSheet.addRow(["作者昵称", "内容ID"]);
  authorSheet.addRow(["作者乙", "7679270829082823972"]);
  const fixture = Buffer.from(await workbook.xlsx.writeBuffer());
  const calls = [];
  const commandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("+workbook-info")) {
      return { stdout: JSON.stringify({ ok: true, data: {
        title: "指定页来源",
        revision: 22,
        sheets: [
          { sheet_id: "sheet_intro", title: "说明", row_count: 1, column_count: 1 },
          { sheet_id: "sheet_authors", title: "作者明细", row_count: 2, column_count: 2 },
        ],
      } }), stderr: "" };
    }
    await writeFile(join(options.cwd, "source.xlsx"), fixture);
    return { stdout: JSON.stringify({ ok: true, data: { file_name: "指定页来源", file_size: fixture.length } }), stderr: "" };
  };
  const exported = await exportLarkSheetWorkbook(
    "https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp?sheet=sheet_authors&utm_source=copy#range=A1",
    { command: "lark-cli-test", commandRunner },
  );
  assert.equal(exported.source.url, "https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp?sheet=sheet_authors");
  assert.equal(exported.source.requestedSheetId, "sheet_authors");
  assert.equal(exported.source.requestedSheetTitle, "作者明细");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const urlIndex = call.args.indexOf("--url");
    assert.equal(call.args[urlIndex + 1], exported.source.url);
  }
});

test("a requested Lark sheet remains selectable beyond the bounded sheet list", async () => {
  const workbook = new ExcelJS.Workbook();
  const selected = workbook.addWorksheet("第31页作者");
  selected.addRow(["作者昵称", "内容ID"]);
  selected.addRow(["作者丙", "7679270829082823972"]);
  const fixture = Buffer.from(await workbook.xlsx.writeBuffer());
  const sheets = Array.from({ length: 31 }, (_, index) => ({
    sheet_id: `sheet_${index + 1}`,
    title: index === 30 ? "第31页作者" : `工作表 ${index + 1}`,
  }));
  const commandRunner = async (_command, args, options) => {
    if (args.includes("+workbook-info")) return { stdout: JSON.stringify({ ok: true, data: { title: "多页来源", sheets } }), stderr: "" };
    await writeFile(join(options.cwd, "source.xlsx"), fixture);
    return { stdout: JSON.stringify({ ok: true, data: { file_name: "多页来源", file_size: fixture.length } }), stderr: "" };
  };
  const exported = await exportLarkSheetWorkbook(
    "https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp?sheet=sheet_31",
    { command: "lark-cli-test", commandRunner },
  );
  assert.equal(exported.source.sheets.length, 30);
  assert.ok(exported.source.sheets.some((sheet) => sheet.id === "sheet_31"));
  assert.equal(exported.source.requestedSheetTitle, "第31页作者");
});

test("Lark sheet export uses user identity, isolated temp storage and no configured proxy", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("作者库");
  sheet.addRow(["作者昵称", "抖音号", "内容ID"]);
  sheet.addRow(["作者甲", "DY001", "7679097628281376036"]);
  const fixture = Buffer.from(await workbook.xlsx.writeBuffer());
  let captured = null;
  const commandRunner = async (command, args, options) => {
    captured = { command, args, options };
    await writeFile(join(options.cwd, "source.xlsx"), fixture);
    return { stdout: JSON.stringify({ ok: true, data: { file_name: "作者来源", file_size: fixture.length } }), stderr: "" };
  };
  const exported = await exportLarkSheetWorkbook("https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp", { command: "lark-cli-test", commandRunner });
  assert.equal(exported.fileName, "作者来源.xlsx");
  assert.deepEqual(exported.buffer, fixture);
  assert.equal(exported.source.type, "lark-sheet");
  assert.equal(captured.command, "lark-cli-test");
  assert.deepEqual(captured.args, larkExportArguments(exported.source.url));
  assert.equal(captured.args.at(-1), "--json");
  assert.equal(larkWorkbookInfoArguments(exported.source.url).at(-1), "--json");
  assert.equal(captured.options.env.LARK_CLI_NO_PROXY, "1");
  assert.match(captured.options.cwd, /douyin-monitor-lark-sheet-/);
});

test("Lark CLI resolution prefers configured then per-user then PATH executables", async () => {
  let probes = 0;
  assert.equal(await resolveLarkCliCommand({
    envCommand: "/approved/tools/lark-cli",
    accessImpl: async () => { probes += 1; },
  }), "/approved/tools/lark-cli");
  assert.equal(probes, 0, "an explicit service command must not depend on PATH probing");

  const visited = [];
  const perUser = await resolveLarkCliCommand({
    envCommand: "",
    homeDirectory: "/Users/example",
    pathValue: "/usr/bin:/custom/bin",
    accessImpl: async (candidate) => {
      visited.push(candidate);
      if (candidate !== "/Users/example/.local/bin/lark-cli") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(perUser, "/Users/example/.local/bin/lark-cli");
  assert.deepEqual(visited, ["/Users/example/.local/bin/lark-cli"]);

  const fromPath = await resolveLarkCliCommand({
    envCommand: "",
    homeDirectory: "/Users/missing",
    pathValue: "/custom/bin:/usr/bin",
    accessImpl: async (candidate) => {
      if (candidate !== "/custom/bin/lark-cli") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(fromPath, "/custom/bin/lark-cli");
});

function largeExportFixture({ sheets, revision = 7, changeRows, changeAfter } = {}) {
  const calls = [];
  const defaultSheets = [{ sheet_id: "authors", title: "8月", row_count: 3, column_count: 3 }];
  const info = { ok: true, data: { title: "含截图作者名单", revision, sheets: sheets ?? defaultSheets } };
  let infoReads = 0;
  const commandRunner = async (_command, args, options) => {
    calls.push(args);
    if (args.includes("+workbook-info")) {
      const result = structuredClone(info);
      if (infoReads++ > 0) changeAfter?.(result);
      return { stdout: JSON.stringify(result) };
    }
    if (args.includes("+workbook-export")) {
      await writeFile(join(options.cwd, "source.xlsx"), Buffer.alloc(8_000_001));
      return { stdout: JSON.stringify({ ok: true, data: { file_size: 8_000_001 } }) };
    }
    assert.ok(args.includes("+csv-get"));
    assert.ok(args.includes("--rows-json"));
    assert.equal(args[args.indexOf("--as") + 1], "user");
    const sheet = info.data.sheets.find((item) => item.sheet_id === args[args.indexOf("--sheet-id") + 1]);
    const range = args[args.indexOf("--range") + 1];
    const columns = Array.from({ length: sheet.column_count }, (_, index) => XLSX.utils.encode_col(index));
    const matrix = [["抖音名字", "账号ID", "发布链接"],
      ["作者甲", "00123456789012345678", "分享文字\nhttps://v.douyin.com/proofA/"],
      ["最后一行作者", "52733715193", "https://www.douyin.com/user/MS4wExample?modal_id=7678244317458074907"]];
    const result = { ok: true, data: { actual_range: range, range, current_region: range,
      revision, row_count: sheet.row_count, col_count: sheet.column_count, has_more: false,
      rows: Array.from({ length: sheet.row_count }, (_, index) => ({ row_number: index + 1,
        values: Object.fromEntries(columns.map((column, col) => [column, matrix[index]?.[col] ?? ""])) })) } };
    changeRows?.(result);
    return { stdout: JSON.stringify(result) };
  };
  return { commandRunner, calls };
}

const largeSourceUrl = "https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp";

test("large Lark exports fall back to complete cloud text without losing IDs or last-row proof", async () => {
  const fixture = largeExportFixture();
  const result = await exportLarkSheetWorkbook(`${largeSourceUrl}?sheet=authors`, fixture);
  assert.equal(result.source.readMode, "cloud-cell-values");
  assert.equal(result.source.originalExportFileSize, 8_000_001);
  assert.equal(result.source.fileSize, result.buffer.length);
  assert.ok(result.buffer.length < 8_000_000);
  assert.match(result.source.excludedContent, /图片、截图/);
  assert.equal(result.source.revision, 7);
  assert.equal(result.source.requestedSheetTitle, "8月");
  assert.deepEqual(result.source.cellReads.map((read) => [read.sheetId, read.range, read.rowCount]), [["authors", "A1:C3", 3]]);
  assert.match(result.source.cellReads[0].valuesSha256, /^[a-f0-9]{64}$/);
  const workbook = XLSX.read(result.buffer, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["8月"]);
  assert.equal(workbook.Sheets["8月"].B2.v, "00123456789012345678");
  assert.equal(workbook.Sheets["8月"].C2.v, "分享文字\nhttps://v.douyin.com/proofA/");
  assert.equal(workbook.Sheets["8月"].A3.v, "最后一行作者");
  assert.match(workbook.Sheets["8月"].C3.v, /7678244317458074907/);
  assert.deepEqual(fixture.calls.map((args) => args[1]), ["+workbook-info", "+workbook-export", "+csv-get", "+workbook-info"]);
});

test("large exports without sheet selection read every worksheet, including hidden sheets", async () => {
  const fixture = largeExportFixture({ sheets: [
    { sheet_id: "first", title: "第一板块", row_count: 3, column_count: 3 },
    { sheet_id: "second", title: "隐藏板块", row_count: 3, column_count: 3, is_hidden: true },
  ] });
  const result = await exportLarkSheetWorkbook(largeSourceUrl, fixture);
  assert.deepEqual(XLSX.read(result.buffer).SheetNames, ["第一板块", "隐藏板块"]);
  assert.deepEqual(result.source.cellReads.map((read) => read.sheetId), ["first", "second"]);
});

test("large selected-sheet fallback does not read unrelated oversized grids", async () => {
  const fixture = largeExportFixture({ sheets: [
    { sheet_id: "authors", title: "8月", row_count: 3, column_count: 3 },
    { sheet_id: "other", title: "别的表", row_count: 100_000, column_count: 300 },
  ] });
  const result = await exportLarkSheetWorkbook(`${largeSourceUrl}?sheet=authors`, fixture);
  assert.deepEqual(result.source.cellReads.map((read) => read.sheetId), ["authors"]);
});

for (const [label, changeRows, pattern] of [
  ["has_more", (r) => { r.data.has_more = true; }, /未完整读取/],
  ["missing has_more", (r) => { delete r.data.has_more; }, /未完整读取/],
  ["data_not_fully_read", (r) => { r.data.data_not_fully_read = { unread_rows: 1 }; }, /未完整读取/],
  ["notice incompleteness", (r) => { r._notice = { data_not_fully_read: {} }; }, /未完整读取/],
  ["truncated", (r) => { r.data.truncated = true; }, /未完整读取/],
  ["short range", (r) => { r.data.actual_range = "A1:C2"; }, /范围或行列数量不完整/],
  ["missing row", (r) => { r.data.rows.pop(); }, /范围或行列数量不完整/],
  ["region outside grid", (r) => { r.data.current_region = "A1:C4"; }, /数据区域无法完整核对/],
  ["wrong row number", (r) => { r.data.rows[2].row_number = 5; }, /单元格不完整/],
  ["missing column", (r) => { delete r.data.rows[2].values.C; }, /单元格不完整/],
  ["structured cell", (r) => { r.data.rows[1].values.C = { text: "不能默默丢失链接" }; }, /不是可无损读取/],
  ["unsafe numeric identity", (r) => { r.data.rows[1].values.B = 7678244317458074907; }, /不是可无损读取/],
  ["changed row revision", (r) => { r.data.revision = 8; }, /读取期间发生变化/],
]) {
  test(`large Lark fallback rejects ${label}`, async () => {
    await assert.rejects(exportLarkSheetWorkbook(`${largeSourceUrl}?sheet=authors`, largeExportFixture({ changeRows })), pattern);
  });
}

for (const [label, options, pattern] of [
  ["too many rows", { sheets: [{ sheet_id: "authors", title: "8月", row_count: 5001, column_count: 3 }] }, /5000 行/],
  ["too many columns", { sheets: [{ sheet_id: "authors", title: "8月", row_count: 3, column_count: 101 }] }, /100 列/],
  ["unknown physical grid", { sheets: [{ sheet_id: "authors", title: "8月" }] }, /缺少有效范围/],
  ["missing revision", { revision: 0 }, /修订号/],
  ["changed final revision", { changeAfter: (r) => { r.data.revision += 1; } }, /读取期间发生变化/],
  ["changed final grid", { changeAfter: (r) => { r.data.sheets[0].row_count += 1; } }, /读取期间发生变化/],
]) {
  test(`large Lark fallback rejects ${label}`, async () => {
    await assert.rejects(exportLarkSheetWorkbook(`${largeSourceUrl}?sheet=authors`, largeExportFixture(options)), pattern);
  });
}

test("large unselected workbooks over the sheet or total-row limit are rejected, never first-sheet-only", async () => {
  for (const sheets of [
    Array.from({ length: 31 }, (_, index) => ({ sheet_id: `s${index}`, title: `页${index}`, row_count: 1, column_count: 1 })),
    [{ sheet_id: "a", title: "甲", row_count: 3000, column_count: 3 }, { sheet_id: "b", title: "乙", row_count: 3000, column_count: 3 }],
  ]) {
    const fixture = largeExportFixture({ sheets });
    await assert.rejects(exportLarkSheetWorkbook(largeSourceUrl, fixture), /指定.*工作表/);
    assert.equal(fixture.calls.filter((args) => args.includes("+csv-get")).length, 0);
  }
});

test("anonymous Douyin state drops account-session cookies and every origin store", () => {
  const filtered = filterAnonymousState({
    cookies: [
      { name: "ttwid", domain: ".douyin.com", value: "anonymous" },
      { name: "UIFID_TEMP", domain: ".douyin.com", value: "anonymous" },
      { name: "sessionid", domain: ".douyin.com", value: "private" },
      { name: "uid_tt", domain: ".douyin.com", value: "private" },
      { name: "passport_auth_status", domain: ".douyin.com", value: "private" },
      { name: "ttwid", domain: ".example.com", value: "wrong-domain" },
    ],
    origins: [
      { origin: "https://www.douyin.com", localStorage: [{ name: "passport-session", value: "private" }] },
      { origin: "https://example.com", localStorage: [{ name: "token", value: "private" }] },
    ],
  });
  assert.deepEqual(filtered.cookies.map((cookie) => cookie.name), ["ttwid", "UIFID_TEMP"]);
  assert.deepEqual(filtered.origins, []);
  assert.equal(JSON.stringify(filtered).includes("passport-session"), false);
  assert.equal(JSON.stringify(filtered).includes("localStorage"), false);
});

test("anonymous Douyin state never persists localStorage even for allowlisted cookie names", () => {
  const filtered = filterAnonymousState({
    cookies: [{ name: "sessionid", domain: ".douyin.com", value: "private-cookie" }],
    origins: [{
      origin: "https://www.douyin.com",
      localStorage: [
        { name: "ttwid", value: "must-not-survive" },
        { name: "UIFID", value: "must-not-survive" },
      ],
    }],
  });
  assert.deepEqual(filtered, { cookies: [], origins: [] });
});

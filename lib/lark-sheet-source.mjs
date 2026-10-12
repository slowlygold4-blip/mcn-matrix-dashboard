import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as XLSX from "@e965/xlsx";
import { AUTHOR_UPLOAD_LIMITS } from "./author-spreadsheet.mjs";

const MAX_EXPORT_BYTES = 8_000_000;
const ALLOWED_HOSTS = new Set(["larkoffice.com", "larksuite.com", "feishu.cn", "doubao.com"]);
const ALLOWED_HOST_SUFFIXES = [".larkoffice.com", ".larksuite.com", ".feishu.cn", ".doubao.com"];
const SHEET_PATH_RE = /^\/(?:sheets|spreadsheets)\/([A-Za-z0-9_-]{10,})\/?$/;
const SHEET_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

function clean(value, maxLength = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseEnvelope(stdout) {
  const source = String(stdout ?? "").trim();
  if (!source) throw new Error("飞书读取组件没有返回结果");
  try { return JSON.parse(source); }
  catch { throw new Error("飞书读取组件返回了无法识别的结果"); }
}

function sourceError(error) {
  const combined = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  let envelope = null;
  try { envelope = parseEnvelope(error?.stdout); } catch {}
  const detail = clean(envelope?.error?.message || envelope?.error || error?.message || "飞书云表格读取失败", 500);
  if (error?.code === "ENOENT") return new Error("本机缺少飞书读取组件，请先安装并完成飞书授权");
  if (/keychain|钥匙串|master key/i.test(combined)) {
    return new Error("本机飞书授权存储暂不可用，请由管理员在本机重新打开飞书授权后再试");
  }
  if (/authorization|unauthor|access token|auth login|登录|授权|token_missing/i.test(combined)) {
    return new Error("飞书授权已失效，请由本机管理员重新完成飞书授权后再试");
  }
  if (/permission|forbidden|scope|99991679|无权限|权限/i.test(combined)) {
    return new Error("当前飞书身份没有读取这份云表格的权限，请确认表格已对本机管理员开放");
  }
  return new Error(detail || "飞书云表格读取失败");
}

export function normalizeLarkSheetUrl(value) {
  const raw = clean(value, 2_000);
  if (!raw) throw new Error("请粘贴飞书云表格链接");
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error("飞书云表格链接格式无效"); }
  if (parsed.protocol !== "https:") throw new Error("飞书云表格链接必须使用 HTTPS");
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname) && !ALLOWED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error("仅支持飞书或 Lark 官方云表格链接");
  }
  const match = SHEET_PATH_RE.exec(parsed.pathname.replace(/\/+$/, ""));
  if (!match) {
    if (/^\/wiki\//.test(parsed.pathname)) throw new Error("该链接是飞书知识库地址，请先在飞书中打开原始电子表格后复制 /sheets/ 链接");
    throw new Error("未识别到飞书电子表格地址，请粘贴包含 /sheets/ 的完整链接");
  }
  const sheetId = parsed.searchParams.get("sheet");
  if (parsed.searchParams.has("sheet") && !SHEET_ID_RE.test(sheetId ?? "")) {
    throw new Error("飞书链接中的工作表 ID 无效");
  }
  const normalized = new URL(`${parsed.origin}/sheets/${match[1]}`);
  if (sheetId) normalized.searchParams.set("sheet", sheetId);
  return normalized.toString();
}

export function requestedLarkSheetId(value) {
  return new URL(normalizeLarkSheetUrl(value)).searchParams.get("sheet") ?? "";
}

export function larkExportArguments(url, outputName = "source.xlsx") {
  return [
    "sheets", "+workbook-export",
    "--url", normalizeLarkSheetUrl(url),
    "--file-extension", "xlsx",
    "--output-path", `./${clean(outputName, 120).replace(/^\.+\//, "") || "source.xlsx"}`,
    "--as", "user",
    "--json",
  ];
}

export function larkWorkbookInfoArguments(url) {
  return ["sheets", "+workbook-info", "--url", normalizeLarkSheetUrl(url), "--as", "user", "--json"];
}

export function larkSheetRowsArguments(url, sheetId, range) {
  if (!SHEET_ID_RE.test(sheetId)) throw new Error("飞书工作表 ID 无效");
  return ["sheets", "+csv-get", "--url", normalizeLarkSheetUrl(url), "--sheet-id", sheetId,
    "--range", range, "--rows-json", "--max-chars", "8000000", "--as", "user", "--json"];
}

function workbookSheets(envelope) {
  return (envelope?.data?.sheets ?? []).map((sheet) => ({
    id: clean(sheet?.sheet_id || sheet?.sheetId || sheet?.id, 80),
    title: clean(sheet?.title || sheet?.sheet_name || sheet?.name, 120),
    rowCount: Number(sheet?.row_count ?? 0),
    columnCount: Number(sheet?.column_count ?? 0),
    hidden: Boolean(sheet?.is_hidden),
  }));
}

function decodeCloudRange(value) {
  if (!/^[A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*$/.test(String(value ?? ""))) return null;
  return XLSX.utils.decode_range(value);
}

function completeCloudRows(envelope, sheet, revision, range) {
  const data = envelope?.data;
  const incomplete = data?.data_not_fully_read || envelope?.data_not_fully_read
    || envelope?._notice?.data_not_fully_read || data?.truncated || envelope?.truncated;
  if (incomplete || data?.has_more !== false) throw new Error(`工作表“${sheet.title}”未完整读取，请缩小表格或拆分后重试`);
  if (Number(data?.revision) !== revision) throw new Error("飞书表格在读取期间发生变化，请重新读取最新版本");
  if (data?.actual_range !== range || data?.range !== range
    || Number(data?.row_count) !== sheet.rowCount || Number(data?.col_count) !== sheet.columnCount
    || !Array.isArray(data?.rows) || data.rows.length !== sheet.rowCount) {
    throw new Error(`工作表“${sheet.title}”返回的范围或行列数量不完整，已停止导入`);
  }
  const region = decodeCloudRange(data.current_region);
  if (!region || region.s.r > region.e.r || region.s.c > region.e.c
    || region.e.r >= sheet.rowCount || region.e.c >= sheet.columnCount) {
    throw new Error(`工作表“${sheet.title}”的数据区域无法完整核对，已停止导入`);
  }
  const columns = Array.from({ length: sheet.columnCount }, (_, index) => XLSX.utils.encode_col(index));
  const columnSet = new Set(columns);
  return data.rows.map((row, index) => {
    if (row?.row_number !== index + 1 || !row.values || Array.isArray(row.values)
      || Object.keys(row.values).length !== columns.length
      || Object.keys(row.values).some((key) => !columnSet.has(key))) {
      throw new Error(`工作表“${sheet.title}”第 ${index + 1} 行的单元格不完整，已停止导入`);
    }
    return columns.map((column) => {
      const value = row.values[column];
      if (value == null) return "";
      if (typeof value === "string" || typeof value === "boolean") return value;
      if (typeof value === "number" && Number.isFinite(value)
        && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
      throw new Error(`工作表“${sheet.title}”第 ${index + 1} 行 ${column} 列不是可无损读取的文本值，已停止导入`);
    });
  });
}

async function exportLargeWorkbookText({ url, requestedSheetId, availableSheets, infoEnvelope, command, commandRunner, commandOptions }) {
  const selected = requestedSheetId ? availableSheets.filter((sheet) => sheet.id === requestedSheetId) : availableSheets;
  if (!selected.length || selected.length > AUTHOR_UPLOAD_LIMITS.maxSheets) {
    throw new Error(`图片较多的飞书表格须指定工作表，或将工作表数量控制在 ${AUTHOR_UPLOAD_LIMITS.maxSheets} 个以内`);
  }
  const revision = Number(infoEnvelope?.data?.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error("无法核对飞书表格修订号，已停止大文件文本导入");
  let totalRows = 0;
  const ids = new Set();
  const titles = new Set();
  for (const sheet of selected) {
    if (!SHEET_ID_RE.test(sheet.id) || ids.has(sheet.id) || !sheet.title || titles.has(sheet.title)) {
      throw new Error("飞书工作表身份无法完整核对，已停止大文件文本导入");
    }
    ids.add(sheet.id);
    titles.add(sheet.title);
    if (!Number.isSafeInteger(sheet.rowCount) || sheet.rowCount < 1 || sheet.rowCount > AUTHOR_UPLOAD_LIMITS.maxRows
      || !Number.isSafeInteger(sheet.columnCount) || sheet.columnCount < 1 || sheet.columnCount > AUTHOR_UPLOAD_LIMITS.maxColumns) {
      throw new Error(`工作表“${sheet.title}”网格超过 ${AUTHOR_UPLOAD_LIMITS.maxRows} 行 / ${AUTHOR_UPLOAD_LIMITS.maxColumns} 列限制，或缺少有效范围；请在飞书中缩小表格后重试`);
    }
    totalRows += sheet.rowCount;
  }
  if (totalRows > AUTHOR_UPLOAD_LIMITS.maxRows) throw new Error(`飞书工作簿总网格超过 ${AUTHOR_UPLOAD_LIMITS.maxRows} 行限制，请在链接中指定要导入的工作表`);
  const workbook = XLSX.utils.book_new();
  const reads = [];
  for (const sheet of selected) {
    const range = `A1:${XLSX.utils.encode_col(sheet.columnCount - 1)}${sheet.rowCount}`;
    let result;
    try {
      result = await commandRunner(command, larkSheetRowsArguments(url, sheet.id, range), {
        ...commandOptions, maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) { throw sourceError(error); }
    const envelope = parseEnvelope(result?.stdout);
    if (!envelope?.ok) throw sourceError({ stdout: result?.stdout, stderr: result?.stderr });
    const rows = completeCloudRows(envelope, sheet, revision, range);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheet.title);
    reads.push({ sheetId: sheet.id, sheetTitle: sheet.title, range, currentRegion: envelope.data.current_region,
      rowCount: rows.length, columnCount: sheet.columnCount, revision,
      valuesSha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") });
  }
  let afterResult;
  try { afterResult = await commandRunner(command, larkWorkbookInfoArguments(url), commandOptions); }
  catch (error) { throw sourceError(error); }
  const after = parseEnvelope(afterResult?.stdout);
  if (!after?.ok) throw sourceError({ stdout: afterResult?.stdout, stderr: afterResult?.stderr });
  if (Number(after?.data?.revision) !== revision || JSON.stringify(workbookSheets(after)) !== JSON.stringify(availableSheets)) {
    throw new Error("飞书表格在读取期间发生变化，请重新读取最新版本");
  }
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
  if (buffer.length > MAX_EXPORT_BYTES) throw new Error("飞书表格去除图片后的文本文件仍超过 8MB 限制，请拆分工作表后重试");
  return { buffer, reads };
}

export async function resolveLarkCliCommand({
  envCommand = process.env.LARK_CLI_BIN,
  homeDirectory = homedir(),
  pathValue = process.env.PATH,
  accessImpl = access,
} = {}) {
  const configured = clean(envCommand, 2_000);
  if (configured) return configured;
  const candidates = [
    join(homeDirectory, ".local", "bin", "lark-cli"),
    ...String(pathValue ?? "").split(":").filter((directory) => isAbsolute(directory)).map((directory) => join(directory, "lark-cli")),
    "/opt/homebrew/bin/lark-cli",
    "/usr/local/bin/lark-cli",
    "/usr/bin/lark-cli",
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      await accessImpl(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return "lark-cli";
}

export async function exportLarkSheetWorkbook(value, options = {}) {
  const url = normalizeLarkSheetUrl(value);
  const requestedSheetId = requestedLarkSheetId(url);
  const command = options.command || await resolveLarkCliCommand(options.commandResolution);
  const commandRunner = options.commandRunner || runCommand;
  const tempDirectory = await mkdtemp(join(tmpdir(), "douyin-monitor-lark-sheet-"));
  const outputName = "source.xlsx";
  const outputPath = join(tempDirectory, outputName);
  try {
    const commandOptions = {
      cwd: tempDirectory,
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, LARK_CLI_NO_PROXY: "1" },
    };
    let infoResult;
    let result;
    try {
      infoResult = await commandRunner(command, larkWorkbookInfoArguments(url), commandOptions);
      result = await commandRunner(command, larkExportArguments(url, outputName), commandOptions);
    } catch (error) {
      throw sourceError(error);
    }
    const infoEnvelope = parseEnvelope(infoResult?.stdout);
    if (!infoEnvelope?.ok) throw sourceError({ stdout: infoResult?.stdout, stderr: infoResult?.stderr });
    const envelope = parseEnvelope(result?.stdout);
    if (!envelope?.ok) throw sourceError({ stdout: result?.stdout, stderr: result?.stderr });
    const file = await stat(outputPath).catch(() => null);
    if (!file?.isFile()) throw new Error("飞书云表格导出完成，但没有生成可读取的 XLSX 文件");
    const title = clean(infoEnvelope?.data?.title || envelope?.data?.file_name, 200) || "飞书作者表格";
    const availableSheets = workbookSheets(infoEnvelope);
    const requestedSheet = requestedSheetId
      ? availableSheets.find((sheet) => sheet.id === requestedSheetId)
      : null;
    if (requestedSheetId && !requestedSheet) {
      throw new Error("飞书链接指定的工作表不存在，或当前身份无权读取该工作表");
    }
    const textExport = file.size > MAX_EXPORT_BYTES
      ? await exportLargeWorkbookText({ url, requestedSheetId, availableSheets, infoEnvelope, command, commandRunner, commandOptions })
      : null;
    const buffer = textExport?.buffer ?? await readFile(outputPath);
    const sheets = availableSheets.slice(0, 30);
    if (requestedSheet && !sheets.some((sheet) => sheet.id === requestedSheet.id)) {
      sheets.splice(Math.max(0, sheets.length - 1), 1, requestedSheet);
    }
    return {
      buffer,
      fileName: `${title.replace(/[\\/:*?"<>|]/g, "-")}.xlsx`,
      source: {
        type: "lark-sheet",
        url,
        title,
        fileSize: textExport ? buffer.length : Number(envelope?.data?.file_size ?? buffer.length),
        readMode: textExport ? "cloud-cell-values" : "xlsx-export",
        ...(textExport ? {
          originalExportFileSize: file.size,
          cellReads: textExport.reads,
          excludedContent: "仅读取完整单元格文本值；图片、截图及格式不作为作者身份字段，未载入生成的 XLSX",
        } : {}),
        revision: Number(infoEnvelope?.data?.revision ?? 0),
        sheets,
        requestedSheetId,
        requestedSheetTitle: requestedSheet?.title ?? "",
        exportSha256: createHash("sha256").update(buffer).digest("hex"),
        readAt: new Date().toISOString(),
      },
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

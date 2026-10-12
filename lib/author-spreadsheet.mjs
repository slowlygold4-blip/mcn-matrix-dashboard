import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import { SaxesParser } from "saxes";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { repairDouyinShareLink } from './douyin-share-link-repair.mjs';

export const AUTHOR_UPLOAD_LIMITS = Object.freeze({
  maxFileBytes: 8_000_000,
  maxRows: 5_000,
  maxColumns: 100,
  maxSheets: 30,
  maxBatchRows: 10_000,
});

export const AUTHOR_PREVIEW_LIMITS = Object.freeze({
  sampleRows: 50,
  problemRows: 100,
});

const FIELD_ALIASES = {
  board: ["板块", "板块名称", "业务板块", "矩阵板块", "项目板块", "所属板块", "矩阵", "项目"],
  platform: ["平台", "内容平台", "账号平台", "所属平台", "渠道", "来源平台", "platform"],
  name: ["作者", "作者名称", "作者昵称", "作者账号名称", "创作者", "创作者名称", "创作者昵称", "创作者账号", "创作者账号名称", "内容作者", "内容创作者", "发布者", "发布者名称", "发布者昵称", "账号名", "账号昵称", "抖音昵称", "抖音名字", "昵称", "达人", "达人名称", "达人昵称", "主播", "主播名称", "主播账号", "主播账号名称", "达人账号名称", "账号名称", "抖音账号名称", "博主", "博主昵称", "用户昵称", "kol名称", "ip名称"],
  locator: ["抖音主页", "b站主页", "哔哩哔哩主页", "小红书主页", "小红书账号链接", "主页链接", "抖音链接", "账号链接", "账号主页", "作者主页", "作者主页链接", "作者链接", "作者账号链接", "创作者主页", "创作者主页链接", "创作者链接", "分享链接", "抖音主页链接", "抖音账号链接", "主页", "主页地址", "profileurl", "accounturl", "url", "link"],
  secUid: ["secuid", "抖音secuid", "sec用户id", "secuserid"],
  douyinId: ["抖音号", "作者抖音号", "创作者抖音号", "账号抖音号", "抖音账号", "抖音id", "douyinid", "dyid", "账号id"],
  bilibiliId: ["b站uid", "哔哩哔哩uid", "bilibiliuid", "b站用户id", "b站账号id", "哔哩哔哩账号id", "b站id"],
  xiaohongshuId: ["小红书用户id", "小红书账号id", "小红书id", "红书id", "xhsid", "rednoteid"],
  contentId: ["内容id", "视频id", "作品id", "作品id/bvid", "视频内容id", "抖音内容id", "抖音视频id", "awemeid", "itemid", "bvid", "bv号", "b站视频id"],
  videoLink: ["视频链接", "作品链接", "作品/分享链接", "发布链接", "内容链接", "视频地址", "作品地址", "内容地址", "抖音视频链接", "公开视频链接", "awemeurl", "videourl"],
  organization: ["所属机构", "所属机构/团队", "所属公司", "机构", "公会", "传媒", "mcn", "公司", "团队"],
  tier: ["评级", "分层", "作者分层", "量级", "等级", "层级", "标签"],
  category: ["类型", "赛道", "内容赛道", "内容类型", "垂类", "分类"],
  owner: ["负责人", "运营负责人", "项目负责人", "板块负责人", "对接人", "owner", "manager"],
  filledDate: ["填写日期", "填表日期", "录入日期", "提交日期", "filleddate", "submittedat"],
  notes: ["备注", "补充说明", "说明备注", "note", "notes", "remark", "remarks"],
};

const NORMALIZED_ALIASES = Object.fromEntries(
  Object.entries(FIELD_ALIASES).map(([field, aliases]) => [field, new Set(aliases.map(normalizeHeader))]),
);
const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const VIDEO_ID_RE = /^\d{15,25}$/;
const BILIBILI_VIDEO_ID_RE = /^BV[0-9A-Za-z]{10}$/;
const DOUYIN_SHORT_URL_RE = /^https?:\/\/v\.douyin\.com\/[^\s]+/i;
const DOUYIN_HOSTS = new Set(["douyin.com", "www.douyin.com", "v.douyin.com"]);
// The legacy share site supplies work locators, never an account identity.
const DOUYIN_VIDEO_HOSTS = new Set([...DOUYIN_HOSTS, "iesdouyin.com", "www.iesdouyin.com"]);
const BILIBILI_VIDEO_HOSTS = new Set(["bilibili.com", "www.bilibili.com"]);
const BILIBILI_PROFILE_HOSTS = new Set(["space.bilibili.com"]);
const XIAOHONGSHU_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);
const OFFICIAL_SHARE_HOSTS = new Set(["v.douyin.com", "b23.tv", "xhslink.com", "www.xhslink.com"]);

function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-—–·:：/\\()（）\[\]【】.]/g, "")
    .replace(/(?:必填|选填|可选|请填写|填写|如有|optional|required)+$/g, "");
}

function cleanText(value, maxLength = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanUrlTail(value) {
  return value.replace(/[。；，,;!！)）\]】}>]+$/g, "");
}

function httpUrlsFromText(value) {
  const repaired = repairDouyinShareLink(value);
  if (repaired) return [repaired.normalizedUrl];
  return cleanText(value, 1_000)
    .match(/https?:\/\/[^\s，。；;,<>"']+/gi)
    ?.map(cleanUrlTail) ?? [];
}

function trustedHttpsUrls(value, allowedHosts, { strictAuthority = false } = {}) {
  const output = [];
  for (const candidate of httpUrlsFromText(value)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) continue;
      // URL normalizes an explicit :443 away. Work evidence must also reject
      // that port, escaped authority spellings, and backslash URL repair.
      if (strictAuthority && candidate.match(/^https:\/\/([^/?#]*)/i)?.[1]?.toLowerCase() !== parsed.hostname.toLowerCase()) continue;
      if (allowedHosts.has(parsed.hostname.toLowerCase())) output.push(parsed);
    } catch {}
  }
  return output;
}

function trustedHttpsUrl(value, allowedHosts) {
  return trustedHttpsUrls(value, allowedHosts)[0] ?? null;
}

function officialBilibiliProfileId(value) {
  const parsed = trustedHttpsUrl(value, BILIBILI_PROFILE_HOSTS);
  return parsed?.pathname.match(/^\/(\d{2,20})(?:\/|$)/)?.[1] ?? null;
}

function officialXiaohongshuProfileId(value) {
  const parsed = trustedHttpsUrl(value, XIAOHONGSHU_HOSTS);
  return parsed?.pathname.match(/^\/user\/profile\/([0-9a-z]{16,40})(?:\/|$)/i)?.[1]?.toLowerCase() ?? null;
}

function officialDouyinProfileSecUids(value) {
  const output = [];
  for (const parsed of trustedHttpsUrls(value, DOUYIN_HOSTS)) {
    // A user-scoped search URL describes search context, not the modal video's author.
    if (/(?:^|\/)(?:search|self)(?:\/|$)/i.test(parsed.pathname)) continue;
    if (/^\/user\/[^/]+\/.+/.test(parsed.pathname)) continue;
    const pathSecUid = parsed.pathname.match(/^\/user\/(MS4wLj[\w-]{12,220})\/?$/)?.[1];
    const querySecUid = parsed.searchParams.get("sec_uid");
    if (pathSecUid && SEC_UID_RE.test(pathSecUid)) output.push(pathSecUid);
    if (querySecUid && SEC_UID_RE.test(querySecUid)) output.push(querySecUid);
  }
  return output;
}

function officialBilibiliProfileIds(value) {
  return trustedHttpsUrls(value, BILIBILI_PROFILE_HOSTS)
    .map((parsed) => parsed.pathname.match(/^\/(\d{2,20})(?:\/|$)/)?.[1] ?? null)
    .filter(Boolean);
}

function officialXiaohongshuProfileIds(value) {
  return trustedHttpsUrls(value, XIAOHONGSHU_HOSTS)
    .map((parsed) => parsed.pathname.match(/^\/user\/profile\/([0-9a-z]{16,40})(?:\/|$)/i)?.[1]?.toLowerCase() ?? null)
    .filter(Boolean);
}

function officialDouyinVideoIds(value) {
  const output = [];
  for (const parsed of trustedHttpsUrls(value, DOUYIN_VIDEO_HOSTS, { strictAuthority: true })) {
    const legacyShare = !DOUYIN_HOSTS.has(parsed.hostname.toLowerCase());
    const pathId = legacyShare
      ? parsed.pathname.match(/^\/share\/video\/(\d{15,25})\/?$/)?.[1]
      : parsed.pathname.match(/^\/(?:video|note|share\/video)\/(\d{15,25})(?:\/|$)/i)?.[1];
    // Do not expand query-only or profile identity trust to iesdouyin.com.
    if (legacyShare && !pathId) continue;
    if (pathId && VIDEO_ID_RE.test(pathId)) output.push(pathId);
    for (const parameter of ["aweme_id", "item_id", "modal_id"]) {
      for (const queryId of parsed.searchParams.getAll(parameter)) {
        if (VIDEO_ID_RE.test(queryId)) output.push(queryId);
      }
    }
  }
  return output;
}

function officialBilibiliVideoIds(value) {
  return trustedHttpsUrls(value, BILIBILI_VIDEO_HOSTS)
    .map((parsed) => parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/)?.[1] ?? null)
    .filter(Boolean);
}

function officialXiaohongshuWorkIds(value) {
  return trustedHttpsUrls(value, XIAOHONGSHU_HOSTS)
    .map((parsed) => parsed.pathname.match(/^\/(?:explore|discovery\/item)\/([0-9a-f]{16,40})(?:\/|$)/i)?.[1]?.toLowerCase() ?? null)
    .filter(Boolean);
}

function officialBilibiliVideoId(value) {
  const raw = cleanText(value, 1_000);
  if (BILIBILI_VIDEO_ID_RE.test(raw)) return raw;
  return officialBilibiliVideoIds(raw)[0] ?? null;
}

function hasOfficialB23Share(value) {
  const parsed = trustedHttpsUrl(value, new Set(["b23.tv"]));
  return Boolean(parsed && parsed.pathname !== "/");
}

export function normalizePlatform(value) {
  const normalized = cleanText(value, 80).toLowerCase().replace(/[\s_\-]/g, "");
  if (["b站", "哔哩哔哩", "哔哩哔哩bilibili", "bilibili", "bili"].includes(normalized)) return "bilibili";
  if (["小红书", "红书", "xiaohongshu", "rednote", "xhs"].includes(normalized)) return "xiaohongshu";
  if (["抖音", "douyin", "dy"].includes(normalized)) return "douyin";
  return null;
}

/**
 * Validate a submitted platform account ID without allowing a nickname, URL,
 * or punctuation-only cell to become a stable deduplication identity. The
 * original value remains available for review when validation fails.
 */
export function validateSubmittedAccountId(value, platformHint = "douyin") {
  const platform = normalizePlatform(platformHint) || "douyin";
  const raw = cleanText(value, 120).replace(/^@/, "");
  if (!raw) return { value: "", raw: "", issue: null };
  let valid = false;
  if (platform === "bilibili") valid = /^\d{2,20}$/.test(raw);
  else if (platform === "xiaohongshu") valid = /^[0-9a-z]{16,40}$/i.test(raw);
  else valid = /^[A-Za-z0-9._-]{1,100}$/.test(raw) && /[A-Za-z0-9]/.test(raw) && raw !== "0";
  if (valid) return { value: raw, raw, issue: null };
  const label = platform === "bilibili" ? "B站 UID" : platform === "xiaohongshu" ? "小红书用户 ID" : "抖音号";
  return { value: "", raw, issue: `${label}“${raw}”格式异常，已保留原文但不计为独立账号；请核对后重新提交` };
}

export function normalizeAccountLocator(value, platformHint = null) {
  const raw = cleanText(value, 1_000);
  if (!raw) return null;
  const platform = normalizePlatform(platformHint)
    ?? (officialBilibiliProfileId(raw) ? "bilibili" : officialXiaohongshuProfileId(raw) ? "xiaohongshu" : "douyin");
  if (platform === "bilibili") {
    if (/^\d{2,20}$/.test(raw)) return raw;
    return officialBilibiliProfileId(raw);
  }
  if (platform === "xiaohongshu") {
    const userId = officialXiaohongshuProfileId(raw);
    if (userId) return `https://www.xiaohongshu.com/user/profile/${userId}`;
    if (/^[0-9a-z]{16,40}$/i.test(raw) && normalizePlatform(platformHint) === "xiaohongshu") {
      return `https://www.xiaohongshu.com/user/profile/${raw}`;
    }
    return null;
  }
  // A bare sec_uid is already a canonical public account identifier. Any value
  // containing a URL must instead pass the complete credential-free HTTPS and
  // exact-host checks in trustedHttpsUrls; never extract an ID from an evil,
  // HTTP, credential-bearing, or non-standard-port URL merely because its path
  // happens to contain `/user/<sec_uid>`.
  if (SEC_UID_RE.test(raw)) return raw;
  const profileSecUid = officialDouyinProfileSecUids(raw)[0];
  if (profileSecUid) return profileSecUid;
  const short = trustedHttpsUrl(raw, new Set(["v.douyin.com"]));
  if (!short || short.pathname === "/") return null;
  short.hash = "";
  return short.toString().replace(/\/$/, "");
}

export function canonicalAccountLocator(value, platformHint = null) {
  const normalized = normalizeAccountLocator(value, platformHint);
  if (!normalized) return null;
  const platform = normalizePlatform(platformHint);
  if (platform === "bilibili" || /^\d{2,20}$/.test(normalized)) return `bilibili:${normalized}`;
  if (platform === "xiaohongshu" || normalized.includes("xiaohongshu.com/user/profile/")) {
    const userId = normalized.match(/\/user\/profile\/([0-9a-z]+)/i)?.[1];
    return userId ? `xiaohongshu:${userId.toLowerCase()}` : null;
  }
  if (SEC_UID_RE.test(normalized)) return `secuid:${normalized}`;
  try {
    const parsed = new URL(normalized);
    return `url:${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

export function extractVideoId(...values) {
  for (const value of values) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) continue;
    const raw = cleanText(value, 1_000);
    if (!raw) continue;
    if (VIDEO_ID_RE.test(raw)) return raw;
    if (BILIBILI_VIDEO_ID_RE.test(raw)) return raw;
    const douyinMatch = officialDouyinVideoIds(raw)[0];
    if (douyinMatch) return douyinMatch;
    const bilibiliMatch = officialBilibiliVideoId(raw);
    if (bilibiliMatch) return bilibiliMatch;
    const xiaohongshuMatch = officialXiaohongshuWorkIds(raw)[0];
    if (xiaohongshuMatch) return xiaohongshuMatch;
  }
  return null;
}

function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) { row.push({ text: field, hyperlink: null }); field = ""; }
    else if (char === "\n") { row.push({ text: field.replace(/\r$/, ""), hyperlink: null }); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push({ text: field.replace(/\r$/, ""), hyperlink: null }); rows.push(row); }
  return rows;
}

function valueText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return cleanText(value);
  if (Array.isArray(value.richText)) return cleanText(value.richText.map((part) => part.text ?? "").join(""));
  if (value.result !== undefined) return valueText(value.result);
  if (value.text !== undefined) return cleanText(value.text);
  return "";
}

function unsafeNumericCell(value) {
  if (typeof value === "number") return !Number.isSafeInteger(value);
  return Boolean(value && typeof value === "object" && value.result !== undefined && unsafeNumericCell(value.result));
}

function sheetJsVisibleText(cell) {
  // Some Feishu exports prepend an empty <t> before rich-text runs. ExcelJS
  // rejects that shape and SheetJS leaves v/w empty but retains the complete r.
  // Read all visible runs, never hyperlink display/Target (which may be partial).
  if (typeof cell?.r === "string" && /<(?:\w+:)?r(?:\s|>)/.test(cell.r)) {
    const tags = [];
    const parts = [];
    const parser = new SaxesParser({ fragment: true });
    parser.on("opentag", ({ name }) => { tags.push(name.split(":").at(-1)); });
    parser.on("closetag", () => { tags.pop(); });
    parser.on("text", (text) => {
      if (tags.at(-1) === "t" && !tags.includes("rPh")) parts.push(text);
    });
    parser.write(cell.r).close();
    return parts.join("").replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return cell?.w ?? cell?.v ?? "";
}

function workbookSheetToRows(worksheet) {
  if (worksheet.actualRowCount > AUTHOR_UPLOAD_LIMITS.maxRows + 25) throw new Error(`工作表“${worksheet.name}”超过 ${AUTHOR_UPLOAD_LIMITS.maxRows} 行限制`);
  if (worksheet.actualColumnCount > AUTHOR_UPLOAD_LIMITS.maxColumns) throw new Error(`工作表“${worksheet.name}”超过 ${AUTHOR_UPLOAD_LIMITS.maxColumns} 列限制`);
  const rows = [];
  const lastRow = Math.min(worksheet.rowCount, AUTHOR_UPLOAD_LIMITS.maxRows + 25);
  const lastColumn = Math.min(Math.max(worksheet.actualColumnCount, 1), AUTHOR_UPLOAD_LIMITS.maxColumns);
  for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
    const source = worksheet.getRow(rowNumber);
    const row = [];
    for (let column = 1; column <= lastColumn; column += 1) {
      const cell = source.getCell(column);
      const raw = cell.value;
      row.push({
        text: cleanText(cell.text || valueText(raw)),
        hyperlink: cleanText(raw && typeof raw === "object" ? raw.hyperlink : "", 1_000) || null,
        unsafeNumericIdentity: unsafeNumericCell(raw),
      });
    }
    rows.push(row);
  }
  return rows;
}

function sheetJsSheetToRows(sheet, sheetName) {
  if (!sheet?.["!ref"]) return [];
  let range;
  try { range = XLSX.utils.decode_range(sheet["!ref"]); }
  catch { throw new Error(`工作表“${sheetName}”的单元格范围无效`); }
  if (range.e.r + 1 > AUTHOR_UPLOAD_LIMITS.maxRows + 25) throw new Error(`工作表“${sheetName}”超过 ${AUTHOR_UPLOAD_LIMITS.maxRows} 行限制`);
  if (range.e.c + 1 > AUTHOR_UPLOAD_LIMITS.maxColumns) throw new Error(`工作表“${sheetName}”超过 ${AUTHOR_UPLOAD_LIMITS.maxColumns} 列限制`);
  const rows = [];
  for (let rowIndex = 0; rowIndex <= range.e.r; rowIndex += 1) {
    const row = [];
    for (let columnIndex = 0; columnIndex <= range.e.c; columnIndex += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      row.push({
        text: cleanText(sheetJsVisibleText(cell)),
        hyperlink: cleanText(cell?.l?.Target ?? "", 1_000) || null,
        unsafeNumericIdentity: cell?.t === "n" && unsafeNumericCell(cell.v),
      });
    }
    rows.push(row);
  }
  return rows;
}

function safeParserMessage(error) {
  return cleanText(error?.message ?? error ?? "未知解析错误", 280).replace(/[\r\n]+/g, " ");
}

function columnName(index) {
  let value = Math.max(1, Math.trunc(Number(index) || 1));
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function populatedRange(rows) {
  let firstRow = Infinity;
  let lastRow = 0;
  let firstColumn = Infinity;
  let lastColumn = 0;
  rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    if (!cell?.text && !cell?.hyperlink) return;
    firstRow = Math.min(firstRow, rowIndex + 1);
    lastRow = Math.max(lastRow, rowIndex + 1);
    firstColumn = Math.min(firstColumn, columnIndex + 1);
    lastColumn = Math.max(lastColumn, columnIndex + 1);
  }));
  if (!lastRow || !lastColumn) return null;
  return `${columnName(firstColumn)}${firstRow}:${columnName(lastColumn)}${lastRow}`;
}

function fileSignature(buffer) {
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "zip";
  if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "ole";
  const sample = buffer.subarray(0, Math.min(buffer.length, 4_096));
  const nullBytes = [...sample].filter((byte) => byte === 0).length;
  if (sample.length && nullBytes / sample.length < 0.01) return "text";
  return "binary";
}

function sheetJsWorkbookToSheets(workbook) {
  if (!workbook?.SheetNames?.length) throw new Error("工作簿没有可读取的工作表");
  if (workbook.SheetNames.length > AUTHOR_UPLOAD_LIMITS.maxSheets) throw new Error(`工作簿超过 ${AUTHOR_UPLOAD_LIMITS.maxSheets} 个工作表限制`);
  return workbook.SheetNames.map((name) => ({ name, rows: sheetJsSheetToRows(workbook.Sheets[name], name) }));
}

function parseCompatibleWorkbook(buffer) {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellFormula: false,
    cellHTML: false,
    cellDates: false,
    cellText: true,
    dense: false,
    WTF: false,
  });
  return sheetJsWorkbookToSheets(workbook);
}

function mapHeaderRow(row) {
  const mapping = {};
  row.forEach((cell, index) => {
    const normalized = normalizeHeader(cell.text);
    for (const [field, aliases] of Object.entries(NORMALIZED_ALIASES)) {
      if (!mapping[field] && aliases.has(normalized)) mapping[field] = { column: index + 1, header: cleanText(cell.text, 120) };
    }
  });
  return mapping;
}

function detectHeader(rows) {
  let best = null;
  for (let index = 0; index < Math.min(rows.length, 25); index += 1) {
    const mapping = mapHeaderRow(rows[index]);
    const score = (mapping.name ? 8 : 0) + (mapping.locator ? 6 : 0) + (mapping.secUid ? 6 : 0)
      + (mapping.platform ? 2 : 0) + (mapping.douyinId ? 2 : 0) + (mapping.bilibiliId ? 2 : 0)
      + (mapping.xiaohongshuId ? 2 : 0) + (mapping.contentId ? 3 : 0) + (mapping.videoLink ? 3 : 0)
      + (mapping.board ? 2 : 0) + (mapping.organization ? 1 : 0) + (mapping.tier ? 1 : 0) + (mapping.category ? 1 : 0);
    const dataRowCount = rows.slice(index + 1).filter((row) => row.some((cell) => cell.text || cell.hyperlink)).length;
    if (!best || score > best.score || (score === best.score && dataRowCount > best.dataRowCount)) {
      best = { rowNumber: index + 1, mapping, score, dataRowCount };
    }
  }
  return best;
}

function boardNameKey(value) {
  return cleanText(value, 120).normalize("NFKC").toLowerCase();
}

function readBoardCatalog(sheets) {
  const configuration = sheets.find((sheet) => cleanText(sheet.name, 120) === "板块配置");
  if (!configuration) return [];
  let header = null;
  for (let index = 0; index < Math.min(configuration.rows.length, 25); index += 1) {
    const board = mapHeaderRow(configuration.rows[index]).board;
    if (board) { header = { rowIndex: index, column: board.column }; break; }
  }
  if (!header) return [];
  const catalog = new Map();
  for (const row of configuration.rows.slice(header.rowIndex + 1)) {
    const cell = row[header.column - 1];
    const name = cleanText(cell?.text, 1_000);
    if (!name || name.length > 120 || cell?.hyperlink) continue;
    const key = boardNameKey(name);
    if (!catalog.has(key)) catalog.set(key, { name });
  }
  return [...catalog.values()];
}

function inferUntitledBoardColumn(rows, header, catalog) {
  // Only infer a missing relationship header when an explicitly named author
  // column is present. Never repurpose a labeled/claimed field or guess from
  // account nicknames, row numbers, a partially matching column, or two equally
  // plausible columns. Empty cells remain empty; there is no fill-down.
  if (!header?.mapping.name || header.mapping.board) return { header, warning: null };
  const headerCells = rows[header.rowNumber - 1] ?? [];
  const occupied = new Set(Object.values(header.mapping).map((item) => item.column));
  const knownBoards = new Set(catalog.map((board) => boardNameKey(board.name)));
  const strictBoardName = /^[\p{L}\p{N}][\p{L}\p{N} ·._-]{0,99}(?:切片矩阵|主播板块|切片板块|作者板块)$/u;
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const candidates = [];
  for (let column = 1; column <= columnCount; column += 1) {
    const headerCell = headerCells[column - 1];
    if (occupied.has(column) || cleanText(headerCell?.text) || headerCell?.hyperlink) continue;
    const cells = rows.slice(header.rowNumber).map((row) => row[column - 1])
      .filter((cell) => cleanText(cell?.text, 1_000) || cell?.hyperlink);
    if (!cells.length) continue;
    const allMatch = cells.every((cell) => {
      const value = cleanText(cell?.text, 1_000);
      if (!value || value.length > 120 || cell?.hyperlink) return false;
      return knownBoards.size ? knownBoards.has(boardNameKey(value)) : strictBoardName.test(value);
    });
    if (allMatch) candidates.push(column);
  }
  if (candidates.length > 1) {
    return { header, warning: `存在多个可能的空表头板块列（${candidates.map(columnName).join("、")}列），未自动选择；请为实际板块列补上“板块”表头后重新读取` };
  }
  if (!candidates.length) return { header, warning: null };
  const column = candidates[0];
  const basis = knownBoards.size ? "非空值全部匹配“板块配置”目录" : "非空值全部符合受限的板块名称词缀";
  const inferenceReason = `${columnName(column)}${header.rowNumber} 表头为空，${basis}`;
  return {
    header: {
      ...header,
      mapping: { ...header.mapping, board: { column, header: "", inferred: true, inferenceReason } },
    },
    warning: `已推断空表头的 ${columnName(column)} 列为板块：${basis}；保留原始板块名称与空白单元格，建议在原表补上“板块”表头`,
  };
}

function cellAt(row, mapping) {
  return mapping?.column ? (row[mapping.column - 1] ?? { text: "", hyperlink: null }) : { text: "", hyperlink: null };
}

function fieldText(row, mapping) {
  return cleanText(cellAt(row, mapping).text, 300);
}

function cellValues(row, mapping) {
  const cell = cellAt(row, mapping);
  return [cell.text, cell.hyperlink].map((value) => cleanText(value, 1_000)).filter(Boolean);
}

const PLATFORM_NAMES = Object.freeze({ douyin: "抖音", bilibili: "B站", xiaohongshu: "小红书" });

function platformColumnConflict(row, mapping) {
  const rawPlatform = fieldText(row, mapping.platform);
  const explicitPlatform = normalizePlatform(rawPlatform);
  if (rawPlatform && !explicitPlatform) return `平台列“${rawPlatform.slice(0, 40)}”无法识别，仅支持抖音、B站或小红书`;
  const platformFields = [
    { platform: "douyin", label: "sec_uid", present: cellValues(row, mapping.secUid).length > 0 },
    { platform: "douyin", label: "抖音号", present: cellValues(row, mapping.douyinId).length > 0 },
    { platform: "bilibili", label: "B站UID", present: cellValues(row, mapping.bilibiliId).length > 0 },
    { platform: "xiaohongshu", label: "小红书用户ID", present: cellValues(row, mapping.xiaohongshuId).length > 0 },
  ].filter((item) => item.present);
  if (explicitPlatform) {
    const mismatched = platformFields.filter((item) => item.platform !== explicitPlatform);
    if (mismatched.length) {
      return `平台列选择“${PLATFORM_NAMES[explicitPlatform]}”，但同时填写了${mismatched.map((item) => item.label).join("、")}`;
    }
  } else {
    const platforms = new Set(platformFields.map((item) => item.platform));
    if (platforms.size > 1) return `同一行同时填写了${platformFields.map((item) => item.label).join("、")}，无法唯一判断账号平台`;
  }
  return null;
}

function accountEvidenceFromRow(row, mapping, platform) {
  const evidence = [];
  const push = (platform, id, source) => {
    if (!id) return;
    const normalizedId = platform === "xiaohongshu" ? id.toLowerCase() : id;
    if (!evidence.some((item) => item.platform === platform && item.id === normalizedId && item.source === source)) {
      evidence.push({ platform, id: normalizedId, source });
    }
  };
  const directSecUid = fieldText(row, mapping.secUid);
  if (SEC_UID_RE.test(directSecUid)) push("douyin", directSecUid, "sec_uid列");
  const directBilibiliId = fieldText(row, mapping.bilibiliId);
  if (/^\d{2,20}$/.test(directBilibiliId)) push("bilibili", directBilibiliId, "B站UID列");
  const directXiaohongshuId = fieldText(row, mapping.xiaohongshuId);
  if (/^[0-9a-z]{16,40}$/i.test(directXiaohongshuId)) push("xiaohongshu", directXiaohongshuId, "小红书用户ID列");
  for (const value of cellValues(row, mapping.locator)) {
    if (SEC_UID_RE.test(value)) push("douyin", value, "作者主页 / 强身份列");
    else if (platform === "bilibili" && /^\d{2,20}$/.test(value)) push("bilibili", value, "作者主页 / 强身份列");
    else if (platform === "xiaohongshu" && /^[0-9a-z]{16,40}$/i.test(value)) push("xiaohongshu", value, "作者主页 / 强身份列");
  }

  const sources = [
    [mapping.secUid, "sec_uid列链接"],
    [mapping.bilibiliId, "B站UID列链接"],
    [mapping.xiaohongshuId, "小红书用户ID列链接"],
    [mapping.locator, "作者主页"],
    [mapping.name, "作者名称超链接"],
    [mapping.videoLink, "作品 / 分享链接中的主页"],
  ];
  for (const [field, label] of sources) {
    for (const value of cellValues(row, field)) {
      for (const id of officialDouyinProfileSecUids(value)) push("douyin", id, label);
      for (const id of officialBilibiliProfileIds(value)) push("bilibili", id, label);
      for (const id of officialXiaohongshuProfileIds(value)) push("xiaohongshu", id, label);
    }
  }
  return evidence;
}

function accountEvidenceConflict(row, mapping, platform) {
  const evidence = accountEvidenceFromRow(row, mapping, platform);
  const otherPlatforms = [...new Set(evidence.map((item) => item.platform).filter((item) => item !== platform))];
  if (otherPlatforms.length) {
    return `账号平台为${PLATFORM_NAMES[platform]}，但主页或强身份列还指向${otherPlatforms.map((item) => PLATFORM_NAMES[item]).join("、")}`;
  }
  const samePlatform = evidence.filter((item) => item.platform === platform);
  const identities = [...new Set(samePlatform.map((item) => item.id))];
  if (identities.length <= 1) return null;
  const details = samePlatform
    .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 3)
    .map((item) => `${item.source}“${item.id}”`)
    .join("与");
  return `${PLATFORM_NAMES[platform]}强身份不一致：${details}`;
}

function workEvidenceFromRow(row, mapping, platform) {
  const evidence = [];
  const push = (evidencePlatform, id, source) => {
    if (!id) return;
    const normalizedId = evidencePlatform === "xiaohongshu" ? id.toLowerCase() : id;
    if (!evidence.some((item) => item.platform === evidencePlatform && item.id === normalizedId && item.source === source)) {
      evidence.push({ platform: evidencePlatform, id: normalizedId, source });
    }
  };
  const direct = fieldText(row, mapping.contentId);
  if (BILIBILI_VIDEO_ID_RE.test(direct)) push("bilibili", direct, "作品ID / BVID列");
  else if (platform === "douyin" && VIDEO_ID_RE.test(direct)) push("douyin", direct, "作品ID列");
  else if (platform === "xiaohongshu" && /^[0-9a-f]{16,40}$/i.test(direct)) push("xiaohongshu", direct, "作品ID列");

  const sources = [
    [mapping.contentId, "作品ID列链接"],
    [mapping.videoLink, "作品 / 分享链接"],
    [mapping.locator, "主页 / 链接列"],
  ];
  for (const [field, label] of sources) {
    for (const value of cellValues(row, field)) {
      for (const id of officialDouyinVideoIds(value)) push("douyin", id, label);
      for (const id of officialBilibiliVideoIds(value)) push("bilibili", id, label);
      for (const id of officialXiaohongshuWorkIds(value)) push("xiaohongshu", id, label);
    }
  }
  return evidence;
}

function workEvidenceConflict(row, mapping, platform) {
  const evidence = workEvidenceFromRow(row, mapping, platform);
  const linkPlatforms = [];
  for (const field of [mapping.contentId, mapping.videoLink, mapping.locator]) {
    for (const value of cellValues(row, field)) {
      for (const parsed of trustedHttpsUrls(value, OFFICIAL_SHARE_HOSTS)) {
        const hostname = parsed.hostname.toLowerCase();
        linkPlatforms.push(hostname === "b23.tv" ? "bilibili" : hostname.includes("xhslink.com") ? "xiaohongshu" : "douyin");
      }
    }
  }
  const otherPlatforms = [...new Set([
    ...evidence.map((item) => item.platform),
    ...linkPlatforms,
  ].filter((item) => item !== platform))];
  if (otherPlatforms.length) {
    return `账号平台为${PLATFORM_NAMES[platform]}，但官方作品链接或 BVID 指向${otherPlatforms.map((item) => PLATFORM_NAMES[item]).join("、")}`;
  }
  const samePlatform = evidence.filter((item) => item.platform === platform);
  const identities = [...new Set(samePlatform.map((item) => item.id))];
  if (identities.length <= 1) return null;
  const details = samePlatform
    .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 3)
    .map((item) => `${item.source}“${item.id}”`)
    .join("与");
  return `${PLATFORM_NAMES[platform]}作品身份不一致：${details}`;
}

function identityConflictFromRow(row, mapping, platform) {
  if ([mapping.contentId, mapping.videoLink].some((field) => cellAt(row, field).unsafeNumericIdentity)) {
    return "作品标识以超出安全精度的数字存储，原始末位无法确认；请将作品 ID 以文本重新提供，或使用完整官方作品链接";
  }
  return platformColumnConflict(row, mapping)
    ?? accountEvidenceConflict(row, mapping, platform)
    ?? workEvidenceConflict(row, mapping, platform);
}

function platformFromRow(row, mapping) {
  const explicit = normalizePlatform(fieldText(row, mapping.platform));
  if (explicit) return explicit;
  const values = [
    cellAt(row, mapping.locator).text,
    cellAt(row, mapping.locator).hyperlink,
    cellAt(row, mapping.videoLink).text,
    cellAt(row, mapping.videoLink).hyperlink,
    cellAt(row, mapping.contentId).text,
  ]
    .map((value) => String(value ?? ""));
  if (values.some((value) => officialBilibiliVideoId(value) || officialBilibiliProfileId(value) || hasOfficialB23Share(value))) return "bilibili";
  const loweredValues = values.map((value) => value.toLowerCase());
  if (values.some((value) => officialXiaohongshuProfileId(value) || officialXiaohongshuWorkIds(value).length)) return "xiaohongshu";
  if (loweredValues.some((value) => value.includes("xhslink.com"))) return "xiaohongshu";
  if (fieldText(row, mapping.bilibiliId)) return "bilibili";
  if (fieldText(row, mapping.xiaohongshuId)) return "xiaohongshu";
  return "douyin";
}

function locatorFromRow(row, mapping, platform) {
  const nameCell = cellAt(row, mapping.name);
  const locatorCell = cellAt(row, mapping.locator);
  const videoCell = cellAt(row, mapping.videoLink);
  const secUidCell = cellAt(row, mapping.secUid);
  const platformIdCell = platform === "bilibili" ? cellAt(row, mapping.bilibiliId)
    : platform === "xiaohongshu" ? cellAt(row, mapping.xiaohongshuId)
      : { text: "", hyperlink: null };
  const candidates = [secUidCell.text, secUidCell.hyperlink, platformIdCell.text, platformIdCell.hyperlink, locatorCell.hyperlink, locatorCell.text, nameCell.hyperlink, videoCell.hyperlink, videoCell.text];
  for (const candidate of candidates) {
    const locator = normalizeAccountLocator(candidate, platform);
    if (locator) return locator;
  }
  return null;
}

function officialShareUrls(...values) {
  const urls = new Set();
  for (const value of values) {
    for (const parsed of trustedHttpsUrls(value, OFFICIAL_SHARE_HOSTS)) {
      if (parsed.pathname === "/") continue;
      parsed.hash = "";
      urls.add(parsed.toString());
    }
  }
  return [...urls];
}

function stableAuthorIdentityKey(row) {
  const platform = normalizePlatform(row.platform) || "douyin";
  const locatorKey = canonicalAccountLocator(row.locator, platform);
  if (locatorKey) return locatorKey;
  const accountId = platform === "bilibili" ? row.bilibiliId : platform === "xiaohongshu" ? row.xiaohongshuId : row.douyinId;
  if (accountId) return `${platform}:${String(accountId).normalize("NFKC").trim().toLowerCase()}`;
  return null;
}

function authorResolutionKey(row) {
  const platform = normalizePlatform(row.platform) || "douyin";
  const accountIdentity = stableAuthorIdentityKey(row);
  if (accountIdentity) return accountIdentity;
  if (row.videoId) return `${platform}:video:${row.videoId}`;
  if (row.shareUrl) return `${platform}:share:${String(row.shareUrl).trim().toLowerCase()}`;
  if (row.name) return `${platform}:name:${String(row.name).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()}`;
  return null;
}

function summarizeRows(rows) {
  const counts = { identityCountVersion: 2, totalRows: rows.length, recognizedRows: 0, uniqueAuthors: 0, knownUniqueAuthors: 0, unresolvedIdentityRows: 0, importableRows: 0, resolvableRows: 0, resolvableAuthors: 0, autoMonitorAuthors: 0, needsLocatorRows: 0, identityConflictRows: 0, identityConflictAuthors: 0, skippedRows: 0, duplicateRows: 0, existingRows: 0 };
  const uniqueAuthors = new Set();
  const resolvableAuthors = new Set();
  const autoMonitorAuthors = new Set();
  const identityConflictAuthors = new Set();
  for (const row of rows) {
    const authorKey = authorResolutionKey(row);
    const stableIdentityKey = stableAuthorIdentityKey(row);
    if (authorKey) {
      counts.recognizedRows += 1;
      if (stableIdentityKey) uniqueAuthors.add(stableIdentityKey);
      else counts.unresolvedIdentityRows += 1;
    }
    if (row.status === "identity_conflict" || row.identityConflict) {
      counts.identityConflictRows += 1;
      if (stableIdentityKey || authorKey) identityConflictAuthors.add(stableIdentityKey || authorKey);
    }
    if (row.status === "identity_conflict") {
      continue;
    }
    if (row.status === "ready") {
      counts.importableRows += 1;
      if (authorKey) autoMonitorAuthors.add(authorKey);
    }
    else if (row.status === "resolvable") {
      counts.resolvableRows += 1;
      if (authorKey) {
        resolvableAuthors.add(authorKey);
        autoMonitorAuthors.add(authorKey);
      }
    }
    else if (row.status === "needs_locator") counts.needsLocatorRows += 1;
    else if (row.status === "duplicate") counts.duplicateRows += 1;
    else if (row.status === "existing") counts.existingRows += 1;
    else counts.skippedRows += 1;
  }
  counts.knownUniqueAuthors = uniqueAuthors.size;
  // Names and work links are useful resolution evidence, but neither proves
  // account identity. Do not present a guessed total as a unique-author count.
  counts.uniqueAuthors = counts.unresolvedIdentityRows > 0 ? null : uniqueAuthors.size;
  counts.resolvableAuthors = resolvableAuthors.size;
  counts.autoMonitorAuthors = autoMonitorAuthors.size;
  counts.identityConflictAuthors = identityConflictAuthors.size;
  return counts;
}

const AUTHOR_PREVIEW_PROBLEM_PRIORITY = Object.freeze({
  identity_conflict: 0,
  needs_locator: 1,
  skipped: 2,
  duplicate: 3,
});

export function projectAuthorPreviewRows(rows) {
  const source = Array.isArray(rows) ? rows : [];
  const problems = source.filter((row) => Object.hasOwn(AUTHOR_PREVIEW_PROBLEM_PRIORITY, row?.status))
    .sort((left, right) => {
      const statusOrder = AUTHOR_PREVIEW_PROBLEM_PRIORITY[left.status] - AUTHOR_PREVIEW_PROBLEM_PRIORITY[right.status];
      if (statusOrder) return statusOrder;
      const leftRow = Number.isSafeInteger(left.sourceRow) ? left.sourceRow : Number.MAX_SAFE_INTEGER;
      const rightRow = Number.isSafeInteger(right.sourceRow) ? right.sourceRow : Number.MAX_SAFE_INTEGER;
      return leftRow - rightRow;
    });
  return {
    sampleRows: source.slice(0, AUTHOR_PREVIEW_LIMITS.sampleRows),
    problemRowCount: problems.length,
    problemRows: problems.slice(0, AUTHOR_PREVIEW_LIMITS.problemRows),
    problemRowsTruncated: Math.max(0, problems.length - AUTHOR_PREVIEW_LIMITS.problemRows),
  };
}

export function authorPreviewContentSha256(preview) {
  const rowFields = [
    "sourceRow", "board", "name", "platform", "locator", "douyinId", "bilibiliId", "xiaohongshuId",
    "submittedIdRaw", "submittedIdIssue", "contentId", "videoLink", "videoHyperlink", "videoId", "shareUrl",
    "organization", "tier", "category", "owner", "filledDate", "notes", "identityConflict",
  ];
  const mapping = Object.fromEntries(Object.entries(preview?.mapping ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, item]) => [field, { column: Number(item?.column ?? 0), header: cleanText(item?.header, 120) }]));
  const rows = (preview?.rows ?? []).map((row) => Object.fromEntries(rowFields.map((field) => [field, row?.[field] ?? ""])));
  const canonical = JSON.stringify({
    selectedSheet: cleanText(preview?.selectedSheet, 120),
    dataRange: cleanText(preview?.dataRange, 80),
    headerRow: Number(preview?.headerRow ?? 0),
    boardCatalog: (preview?.boardCatalog ?? []).map((board) => ({ name: cleanText(board?.name, 120) })),
    mapping,
    rows,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function parseAuthorRows(rows, header) {
  const mapping = header?.mapping ?? {};
  if (![mapping.name, mapping.locator, mapping.secUid, mapping.douyinId, mapping.bilibiliId, mapping.xiaohongshuId, mapping.contentId, mapping.videoLink].some(Boolean)) {
    throw new Error("未识别到作者身份列；请提供作者名称、平台账号 ID、主页、作品 ID 或分享链接中的任意一种");
  }
  const output = [];
  const seen = new Map();
  for (let index = header.rowNumber; index < rows.length; index += 1) {
    const row = rows[index];
    const hasContent = row.some((cell) => cell.text || cell.hyperlink);
    if (!hasContent) continue;
    const board = fieldText(row, header.mapping.board).slice(0, 120);
    const name = fieldText(row, header.mapping.name).slice(0, 120);
    const platform = platformFromRow(row, header.mapping);
    const rawDouyinId = fieldText(row, header.mapping.douyinId);
    const rawBilibiliId = fieldText(row, header.mapping.bilibiliId);
    const rawXiaohongshuId = fieldText(row, header.mapping.xiaohongshuId);
    const submittedId = validateSubmittedAccountId(platform === "bilibili" ? rawBilibiliId
      : platform === "xiaohongshu" ? rawXiaohongshuId : rawDouyinId, platform);
    const douyinId = platform === "douyin" ? submittedId.value : rawDouyinId;
    const bilibiliId = platform === "bilibili" ? submittedId.value : rawBilibiliId;
    const xiaohongshuId = platform === "xiaohongshu" ? submittedId.value : rawXiaohongshuId;
    const contentId = fieldText(row, header.mapping.contentId);
    const organization = fieldText(row, header.mapping.organization);
    const tier = fieldText(row, header.mapping.tier);
    const category = fieldText(row, header.mapping.category);
    const owner = fieldText(row, header.mapping.owner);
    const filledDate = fieldText(row, header.mapping.filledDate);
    const notes = fieldText(row, header.mapping.notes);
    const locatorCell = cellAt(row, header.mapping.locator);
    const videoCell = cellAt(row, header.mapping.videoLink);
    const contentCell = cellAt(row, header.mapping.contentId);
    const videoLink = cleanText(videoCell.text || videoCell.hyperlink, 1_000);
    const videoHyperlink = cleanText(videoCell.hyperlink, 1_000);
    const detectedVideoId = contentCell.unsafeNumericIdentity || videoCell.unsafeNumericIdentity ? null
      : extractVideoId(contentId, contentCell.hyperlink, videoCell.text, videoCell.hyperlink, locatorCell.text, locatorCell.hyperlink);
    const detectedLocator = locatorFromRow(row, header.mapping, platform);
    const detectedShareUrls = officialShareUrls(contentId, contentCell.hyperlink, videoCell.text, videoCell.hyperlink, locatorCell.text, locatorCell.hyperlink, cellAt(row, header.mapping.name).hyperlink);
    const detectedShareUrl = detectedShareUrls[0] ?? "";
    const identityConflict = identityConflictFromRow(row, header.mapping, platform);
    const xiaohongshuWorkNeedsUnsupportedVerification = !identityConflict && platform === "xiaohongshu" && Boolean(detectedVideoId || detectedShareUrl) && Boolean(detectedLocator);
    const locator = platform === "douyin" && DOUYIN_SHORT_URL_RE.test(detectedLocator || "") ? null : detectedLocator;
    const videoId = detectedVideoId;
    const shareUrl = detectedShareUrl;
    const key = canonicalAccountLocator(locator, platform);
    const submittedAccountId = platform === "bilibili" ? bilibiliId : platform === "xiaohongshu" ? xiaohongshuId : douyinId;
    let status = "ready";
    let reason = "账号身份可直接定位，可加入监控";
    if (identityConflict) {
      status = "identity_conflict";
      reason = `身份冲突：${identityConflict}；已阻止该行进入自动核验和监控，请核对后重传`;
    }
    else if (submittedId.issue) {
      status = "needs_locator";
      reason = submittedId.issue;
    }
    else if (detectedShareUrls.length > 1) {
      status = "needs_locator";
      reason = `同一行包含 ${detectedShareUrls.length} 条不同的官方分享链接，当前单行不能完整保留全部核验证据，已阻止自动处理；请按同一作者拆为多行、保留每条链接后重传：${detectedShareUrls.join("；")}`;
    }
    else if (xiaohongshuWorkNeedsUnsupportedVerification) {
      status = "needs_locator";
      reason = "账号与作品均已填写，但当前公开无密钥能力不能严格核验小红书作品的发布作者；该行已阻止自动监控，请移除作品字段仅按主页监控或补充可核验来源";
    }
    else if (!name && !submittedAccountId && !locator && !videoId && !shareUrl) { status = "skipped"; reason = "该行没有可识别的作者名称、账号 ID、主页或作品证据"; }
    else if ((platform === "douyin" || platform === "bilibili") && locator && key
      && ((platform === "douyin" && (VIDEO_ID_RE.test(videoId || "") || shareUrl))
        || (platform === "bilibili" && (BILIBILI_VIDEO_ID_RE.test(videoId || "") || /^https:\/\/b23\.tv\//i.test(shareUrl))))) {
      status = "resolvable";
      reason = platform === "bilibili"
        ? "账号与作品均已提供；必须通过 B站官方公开作品接口反查发布者，并与提交 UID / 主页严格一致后才能加入监控"
        : "账号与作品均已提供；必须通过公开作品反查发布者，并与提交 sec_uid / 主页严格一致后才能加入监控";
    }
    else if ((platform === "douyin" || platform === "bilibili") && (!locator || !key)
      && ((platform === "douyin" && (VIDEO_ID_RE.test(videoId || "") || shareUrl))
        || (platform === "bilibili" && (BILIBILI_VIDEO_ID_RE.test(videoId || "") || /^https:\/\/b23\.tv\//i.test(shareUrl))))) {
      status = "resolvable";
      reason = platform === "bilibili"
        ? bilibiliId
          ? "可通过 B站官方公开作品接口反查发布者，并与提交 UID 严格一致后自动加入监控"
          : name
            ? "可通过 B站官方公开作品接口反查发布者，并与作者昵称严格一致后自动加入监控"
            : "可通过 B站官方公开作品接口直接确认发布者，并自动补全 UID 与作者名"
        : douyinId
          ? "可通过公开作品或分享链接反查作者，并用抖音号严格核验后自动加入监控"
          : name
            ? "可通过公开作品或分享链接反查作者，并用作者昵称严格核验后自动加入监控"
            : "可通过公开作品或分享链接直接确认发布作者，并在严格核验后自动补全作者名";
    }
    else if (!locator || !key) {
      status = "needs_locator";
      reason = platform === "bilibili"
        ? "B站需要有效 BV 作品链接、B站 UID 或官方主页；其他链接不能自动确权"
        : platform === "xiaohongshu"
          ? "小红书不能仅通过作品或分享链接匿名反查作者；请提供小红书用户 ID 或官方主页"
          : submittedAccountId
            ? "缺少可验证的作者主页或公开视频证据"
            : "缺少平台账号主页、账号 ID 和可核验公开证据";
    }
    else if (!name) { reason = "主页或平台账号 ID 可直接定位；首次公开采集后自动补全作者名称"; }
    if (status === "ready" && key) {
      const membershipKey = `${key}\u0000${board.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()}`;
      const relationshipFingerprint = JSON.stringify([organization, tier, category, owner, filledDate, notes].map((value) => cleanText(value, 500).normalize("NFKC").toLowerCase()));
      const fingerprints = seen.get(membershipKey) ?? new Set();
      if (fingerprints.has(relationshipFingerprint)) {
        status = "duplicate";
        reason = "表格内同一板块账号及关系资料完全重复，已保留首次出现行";
      } else if (fingerprints.size) {
        reason = "表格内同一账号在同一板块的关系资料不同；提交后保留原有非空值并记录冲突来源";
      }
      fingerprints.add(relationshipFingerprint);
      seen.set(membershipKey, fingerprints);
    }
    output.push({
      sourceRow: index + 1,
      board,
      name,
      platform,
      locator,
      douyinId,
      bilibiliId,
      xiaohongshuId,
      submittedIdRaw: submittedId.issue ? submittedId.raw : "",
      submittedIdIssue: submittedId.issue || "",
      contentId,
      videoLink,
      videoHyperlink,
      videoId,
      shareUrl,
      organization,
      tier,
      category,
      owner,
      filledDate,
      notes,
      identityConflict,
      status,
      reason,
    });
    if (output.length > AUTHOR_UPLOAD_LIMITS.maxRows) throw new Error(`作者数据超过 ${AUTHOR_UPLOAD_LIMITS.maxRows} 行限制`);
  }
  return output;
}

export function markExistingAuthors(preview, existingTargets) {
  const existing = new Map();
  for (const target of existingTargets.filter((item) => item.type === "account" && item.provider === "public-web")) {
    const locatorKey = canonicalAccountLocator(target.locator, target.metadata?.platform);
    const authorKey = canonicalAccountLocator(target.known_author_id, target.metadata?.platform);
    if (locatorKey) existing.set(locatorKey, target);
    if (authorKey) existing.set(authorKey, target);
  }
  const rows = preview.rows.map((row) => {
    if (row.status !== "ready") return row;
    const target = existing.get(canonicalAccountLocator(row.locator, row.platform));
    if (!target) return row;
    const boardKey = cleanText(row.board, 120).normalize("NFKC").toLowerCase();
    const targetBoards = (target.boards ?? []).map((board) => ({
      value: board,
      key: cleanText(board?.name ?? board, 120).normalize("NFKC").toLowerCase(),
    }));
    const matchingBoard = targetBoards.find((board) => board.key === boardKey)?.value;
    if (boardKey && !matchingBoard) {
      return { ...row, reason: "该账号已在监控列表中，可补充新的板块归属" };
    }
    if (boardKey && matchingBoard && typeof matchingBoard === "object") {
      const relationshipFields = [
        ["organization", "organization", "所属机构 / 团队"],
        ["tier", "tier", "作者分层"],
        ["category", "category", "内容赛道"],
        ["owner", "owner", "负责人"],
        ["filledDate", "filledDate", "填写日期"],
        ["notes", "note", "备注"],
      ];
      const additions = [];
      const changes = [];
      for (const [rowField, boardField, label] of relationshipFields) {
        const incoming = cleanText(row[rowField], rowField === "notes" ? 500 : 200);
        const stored = cleanText(boardField === "note" ? matchingBoard.note ?? matchingBoard.notes : matchingBoard[boardField], rowField === "notes" ? 500 : 200);
        if (!incoming) continue;
        if (!stored) additions.push(label);
        else if (incoming.normalize("NFKC").toLowerCase() !== stored.normalize("NFKC").toLowerCase()) changes.push(label);
      }
      if (additions.length || changes.length) {
        const details = [
          additions.length ? `补充${additions.join("、")}` : "",
          changes.length ? `${changes.join("、")}与已有记录不同，提交后进入冲突审查` : "",
        ].filter(Boolean).join("；");
        return { ...row, reason: `该账号已在当前板块，可提交关系资料：${details}` };
      }
    }
    return { ...row, status: "existing", reason: boardKey ? "该账号已在当前板块的监控列表中" : "该账号已在监控列表中" };
  });
  return { ...preview, rows, summary: summarizeRows(rows) };
}

export async function parseAuthorSpreadsheet({ buffer, fileName, sheetName, includeAllSheets = false }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("上传文件为空");
  if (buffer.length > AUTHOR_UPLOAD_LIMITS.maxFileBytes) throw new Error("文件超过 8MB 限制");
  const extension = extname(String(fileName ?? "")).toLowerCase();
  let sheets;
  let parserMode = "standard";
  let detectedFormat = extension.replace(/^\./, "") || "unknown";
  const validationWarnings = [];
  if ([".csv", ".tsv"].includes(extension)) {
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    const rows = parseDelimited(text, extension === ".tsv" ? "\t" : ",");
    if (rows.length > AUTHOR_UPLOAD_LIMITS.maxRows + 25) throw new Error(`表格超过 ${AUTHOR_UPLOAD_LIMITS.maxRows} 行限制`);
    if (Math.max(0, ...rows.map((row) => row.length)) > AUTHOR_UPLOAD_LIMITS.maxColumns) throw new Error(`表格超过 ${AUTHOR_UPLOAD_LIMITS.maxColumns} 列限制`);
    sheets = [{ name: "CSV", rows }];
  } else if ([".xlsx", ".xls", ".xlsm", ".xlsb"].includes(extension)) {
    const signature = fileSignature(buffer);
    detectedFormat = signature === "ole" ? "legacy-excel" : signature === "text" ? "text-table" : extension.replace(/^\./, "");
    if (signature === "binary") throw new Error("文件内容不是可识别的 Excel 工作簿；请从 Excel 或飞书重新导出为 XLSX");
    let primaryError = null;
    if (signature === "zip" && [".xlsx", ".xlsm"].includes(extension)) {
      const workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(buffer);
        if (!workbook.worksheets.length) throw new Error("工作簿没有可读取的工作表");
        if (workbook.worksheets.length > AUTHOR_UPLOAD_LIMITS.maxSheets) throw new Error(`工作簿超过 ${AUTHOR_UPLOAD_LIMITS.maxSheets} 个工作表限制`);
        sheets = workbook.worksheets.map((worksheet) => ({ name: worksheet.name, rows: workbookSheetToRows(worksheet) }));
      } catch (error) {
        primaryError = error;
      }
    }
    if (!sheets) {
      try {
        sheets = parseCompatibleWorkbook(buffer);
        parserMode = "compatible";
        validationWarnings.push("已使用公开兼容解析模式；单元格公式不会执行，只读取缓存值和文本");
        if ((extension === ".xlsx" && signature !== "zip") || (extension === ".xls" && signature !== "ole")) {
          validationWarnings.push(`文件扩展名与内部格式不一致，已按实际的 ${detectedFormat} 格式读取`);
        }
      } catch (fallbackError) {
        const primary = primaryError ? `ExcelJS: ${safeParserMessage(primaryError)}；` : "";
        const fallback = `兼容解析: ${safeParserMessage(fallbackError)}`;
        const detail = `${primary}${fallback}`;
        const encrypted = /password|encrypted|encryption|密码|加密/i.test(detail);
        const invalidType = signature === "binary" && !encrypted;
        const message = encrypted
          ? "该工作簿已加密或设置打开密码；请另存为未加密的 XLSX 后再上传"
          : invalidType
            ? "文件内容不是可识别的 Excel 工作簿；请从 Excel 或飞书重新导出为 XLSX"
            : `工作簿结构无法解析：${safeParserMessage(fallbackError)}`;
        throw new Error(message, { cause: new Error(detail) });
      }
    }
  } else {
    throw new Error("仅支持 .xlsx、.xls、.xlsm、.xlsb、.csv、.tsv 文件");
  }

  const boardCatalog = readBoardCatalog(sheets);
  const candidates = sheets.map((sheet) => ({ ...sheet, header: detectHeader(sheet.rows) }));
  const preferredAuthorSheet = candidates.find((sheet) => normalizeHeader(sheet.name) === normalizeHeader("作者名单") && (sheet.header?.score ?? 0) > 0);
  const selected = sheetName
    ? candidates.find((sheet) => sheet.name === sheetName)
    : preferredAuthorSheet ?? [...candidates].sort((a, b) => ((b.header?.score ?? 0) - (a.header?.score ?? 0)) || ((b.header?.dataRowCount ?? 0) - (a.header?.dataRowCount ?? 0)))[0];
  if (!selected) throw new Error(`未找到工作表“${sheetName}”`);
  const parseCandidate = (candidate) => {
    const warnings = [...validationWarnings];
    const boardInference = inferUntitledBoardColumn(candidate.rows, candidate.header, boardCatalog);
    const header = boardInference.header;
    if (boardInference.warning) warnings.push(boardInference.warning);
    const rows = parseAuthorRows(candidate.rows, header);
    const conflictRows = rows.filter((row) => row.identityConflict).length;
    if (conflictRows) warnings.push(`检测到 ${conflictRows} 行强身份冲突；这些行已被阻止进入自动核验和监控，请核对后重新提交`);
    return {
      dataRange: populatedRange(candidate.rows),
      headerRow: header.rowNumber,
      mapping: Object.fromEntries(Object.entries(header.mapping).map(([field, item]) => [field, item])),
      rows,
      summary: summarizeRows(rows),
      validationWarnings: warnings,
    };
  };
  const selectedPreview = parseCandidate(selected);
  let sheetPreviews;
  if (includeAllSheets) {
    let totalBatchRows = 0;
    sheetPreviews = candidates.map((candidate) => {
      const base = { name: candidate.name, rowCount: candidate.rows.length, headerScore: candidate.header?.score ?? 0 };
      if ((candidate.header?.score ?? 0) <= 0) return { ...base, importable: false, issue: "未识别到作者表头" };
      try {
        const parsed = candidate === selected ? selectedPreview : parseCandidate(candidate);
        totalBatchRows += parsed.rows.length;
        if (totalBatchRows > AUTHOR_UPLOAD_LIMITS.maxBatchRows) {
          throw new Error(`批量导入合计最多支持 ${AUTHOR_UPLOAD_LIMITS.maxBatchRows.toLocaleString("zh-CN")} 行作者数据；请拆分工作簿后再批量导入`);
        }
        return { ...base, ...parsed, importable: parsed.rows.length > 0, issue: parsed.rows.length ? "" : "没有可导入的作者数据行" };
      } catch (error) {
        if (/批量导入合计最多支持/.test(String(error?.message ?? ""))) throw error;
        return { ...base, importable: false, issue: safeParserMessage(error), rows: [], summary: summarizeRows([]) };
      }
    });
  }
  return {
    fileName: cleanText(fileName, 240),
    parserMode,
    detectedFormat,
    validationWarnings,
    boardCatalog,
    selectedSheet: selected.name,
    dataRange: selectedPreview.dataRange,
    sheets: candidates.map((sheet) => ({ name: sheet.name, rowCount: sheet.rows.length, headerScore: sheet.header?.score ?? 0 })),
    ...(sheetPreviews ? { sheetPreviews } : {}),
    headerRow: selectedPreview.headerRow,
    mapping: selectedPreview.mapping,
    rows: selectedPreview.rows,
    summary: selectedPreview.summary,
    validationWarnings: selectedPreview.validationWarnings,
  };
}

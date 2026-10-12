import { HttpError } from "./access-control.mjs";

const TABLE_ID = /^tbl[A-Za-z0-9_-]{6,77}$/;
const VIEW_ID = /^vew[A-Za-z0-9_-]{6,77}$/;
const OFFICIAL_HOST = /^(?:[a-z0-9-]+\.)*(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/;

/** Metadata attested by an authenticated source reader, not a fresh XLSX export. */
export function normalizeBitableAuthorSource(body, reference = new Date()) {
  if (body?.sourceType !== "lark-bitable") return {};
  const reject = () => { throw new HttpError(400, "多维表格来源凭证不完整或不一致，请重新读取已授权来源"); };
  if (typeof body.sourceUrl !== "string" || body.sourceUrl.length > 1_000
    || body.sourceUrl !== body.sourceUrl.trim()
    || /[\u0000-\u0020\u007f]/.test(body.sourceUrl)) reject();
  let url;
  try { url = new URL(body.sourceUrl); } catch { reject(); }
  const authority = /^https:\/\/([^/?#]+)/i.exec(body.sourceUrl)?.[1];
  if (url.protocol !== "https:" || !authority || authority.includes(":") || authority.includes("@")
    || url.username || url.password || url.port || !OFFICIAL_HOST.test(url.hostname)
    || !/^\/(?:wiki|base)\/[A-Za-z0-9_-]{10,120}\/?$/.test(url.pathname)) reject();
  if (typeof body.sourceSheetId !== "string" || !TABLE_ID.test(body.sourceSheetId)) reject();
  const seen = new Set();
  let tableCount = 0, viewCount = 0;
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) reject();
    seen.add(key);
    if (key === "table" || key === "table_id") {
      if (++tableCount > 1 || !TABLE_ID.test(value) || value !== body.sourceSheetId) reject();
    } else if (key === "view" || key === "view_id") {
      if (++viewCount > 1 || !VIEW_ID.test(value)) reject();
    } else if (key !== "from" || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) reject();
  }
  if (!Number.isSafeInteger(body.sourceRevision) || body.sourceRevision < 0
    || typeof body.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(body.sourceSha256)
    || typeof body.sourceReadAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(body.sourceReadAt)) reject();
  const readAt = Date.parse(body.sourceReadAt);
  const expected = body.sourceReadAt.includes(".") ? body.sourceReadAt : body.sourceReadAt.replace(/Z$/, ".000Z");
  if (!Number.isFinite(readAt) || new Date(readAt).toISOString() !== expected
    || !Number.isFinite(reference.getTime()) || readAt > reference.getTime()) reject();
  if (body.sourceTitle !== undefined && (typeof body.sourceTitle !== "string" || body.sourceTitle.length > 200)) reject();
  url.hash = "";
  url.searchParams.sort();
  return {
    sourceType: "lark-bitable", sourceUrl: url.href,
    sourceTitle: String(body.sourceTitle ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(),
    sourceRevision: body.sourceRevision, sourceSheetId: body.sourceSheetId,
    sourceSha256: body.sourceSha256.toLowerCase(), sourceReadAt: new Date(readAt).toISOString(),
  };
}

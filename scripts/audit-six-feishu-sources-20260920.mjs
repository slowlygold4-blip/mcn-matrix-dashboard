import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";

const outDir = "data/feishu-six-sources-20260920";
const board = "一条小团团切片矩阵";

const sourceDefs = [
  { kind: "作品登记多维表", wikiUrl: "https://dawgasqmco.feishu.cn/wiki/KPLSwjTkCilmaKkrpz2cEzOcnBc?from=from_copylink", sourceUrl: "https://dawgasqmco.feishu.cn/wiki/KPLSwjTkCilmaKkrpz2cEzOcnBc?from=from_copylink", title: "一条小团团切片作品登记表", revision: 1265, mode: "bitable", file: "/tmp/feishu_kpl_records.json", fieldFile: "/tmp/feishu_kpl_fields.json", baseToken: "Mo5jbat2May3MwsJ4wacFnOAnpe", tableId: "tblNrw9W6NyiyRlJ" },
  { kind: "授权作者多维表", wikiUrl: "https://ccnmwvgvsr3v.feishu.cn/wiki/FbWFw55aqibiMFkig84cKbvhnNe?from=from_copylink", sourceUrl: "https://ccnmwvgvsr3v.feishu.cn/wiki/FbWFw55aqibiMFkig84cKbvhnNe?from=from_copylink", title: "切片&原创授权作者登记表", revision: 1503, mode: "bitable", file: "/tmp/feishu_fb_records.json", fieldFile: "/tmp/feishu_fb_fields.json", baseToken: "VMdZbsT6uajUg4s9wtNcRjZtnEh", tableId: "tblvx0Q1ZmVx88Er" },
  { kind: "AI作者视频登记", wikiUrl: "https://ccnmwvgvsr3v.feishu.cn/wiki/LoopwFAzWiLEPqkkvrOc9bhbnnf?from=from_copylink", sourceUrl: "https://ccnmwvgvsr3v.feishu.cn/sheets/L4hZsqBkNhog6Yt6vP1ckhvlnzh?sheet=f49886", title: "AI作者视频数据登记表", revision: 602, mode: "sheet", file: "/tmp/feishu_loop.json", sheetId: "f49886", sheetName: "Sheet1", effectiveLastRow: 99 },
  { kind: "创作者视频登记", wikiUrl: "https://ccnmwvgvsr3v.feishu.cn/wiki/TTUIwNvlwiGiXBkioeGc5uvMnZe?from=from_copylink", sourceUrl: "https://ccnmwvgvsr3v.feishu.cn/sheets/QCWnsFzInhMpcetueKUcIktrnac?sheet=f49886", title: "创作者视频数据登记表", revision: 117, mode: "sheet", file: "/tmp/feishu_ttui.json", sheetId: "f49886", sheetName: "Sheet1", effectiveLastRow: 17 },
  { kind: "切片作者视频登记", wikiUrl: "https://ccnmwvgvsr3v.feishu.cn/wiki/ZLkJwa4mgi3FFhko78ucXszenLe?from=from_copylink&sheet=f49886", sourceUrl: "https://ccnmwvgvsr3v.feishu.cn/sheets/CUHPs5THQhDD4gtvDHCcoJirnze?sheet=f49886", title: "切片作者视频数据登记表", revision: 6332, mode: "sheet-multi", file: "/tmp/feishu_zl1.json", sheetId: "f49886", sheetName: "Sheet1", effectiveLastRow: 994, extra: { file: "/tmp/feishu_zl2.json", sheetId: "1v2rfi", sheetName: "Sheet2", effectiveLastRow: 56 },
  },
  { kind: "热点登记", wikiUrl: "https://dawgasqmco.feishu.cn/wiki/RQq6ws8K9iK7mYkkUxYcZK0InTc?from=from_copylink", sourceUrl: "https://dawgasqmco.feishu.cn/sheets/YR58sxWa0hyIW6tqGPCcoxhGnYd?sheet=d8a44f", title: "#一条小团团这直播效果对味了 热点登记", revision: 4108, mode: "sheet", file: "/tmp/feishu_rq.json", sheetId: "d8a44f", sheetName: "Sheet1", effectiveLastRow: 767 },
];

const clean = (value, max = 1_000) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
const empty = (value) => value === null || value === undefined || clean(value) === "";
function urls(value) {
  return clean(value, 3000).match(/https?:\/\/[^\s，。；;,<>"'\]\)）】]+/gi)?.map((u) => u.replace(/[。；，,;!！\]\)）】}>]+$/g, "")) ?? [];
}
function canonicalUrl(value) {
  for (const candidate of urls(value)) {
    try {
      const u = new URL(candidate);
      if (u.protocol !== "https:" || u.username || u.password || u.port) continue;
      if (!["v.douyin.com", "www.douyin.com", "douyin.com"].includes(u.hostname.toLowerCase())) continue;
      u.hash = "";
      return u.toString().replace(/\/$/, "");
    } catch {}
  }
  return "";
}
function videoId(...values) {
  for (const value of values) {
    const raw = clean(value, 3000);
    if (/^\d{15,25}$/.test(raw)) return raw;
    for (const candidate of urls(raw)) {
      try {
        const u = new URL(candidate);
        const path = u.pathname.match(/^\/(?:video|note|share\/video)\/(\d{15,25})(?:\/|$)/i)?.[1];
        if (path) return path;
        for (const key of ["aweme_id", "item_id", "modal_id"]) if (/^\d{15,25}$/.test(u.searchParams.get(key) ?? "")) return u.searchParams.get(key);
      } catch {}
    }
  }
  return "";
}
function sourceNote(source, sheetName, sourceRow, extra = "") {
  return `来源 wiki=${source.wikiUrl};表格=${source.sourceUrl};revision=${source.revision};sheet=${sheetName};源行=${sourceRow}${extra ? `;${extra}` : ""}`.slice(0, 500);
}
function boardInfo(source, sheetName, sourceRow, category = "") {
  return [{ name: board, category, note: sourceNote(source, sheetName, sourceRow), sourceRow }];
}
function rowFromSheet(source, item, sheetName, sourceRow) {
  const v = item.values ?? {};
  const name = clean(v.A, 120);
  const douyinId = clean(v.B, 120);
  const link = clean(v.C, 3000);
  const contentId = clean(v.D, 120);
  const id = videoId(link, contentId);
  const share = canonicalUrl(link);
  const category = /AI作者/.test(source.title) ? "AI二创" : /热点/.test(source.title) ? "热点" : "切片/原创";
  if (!name && !douyinId && !link && !contentId) return null;
  return { sourceRow, platform: "douyin", name, douyinId, videoId: id, videoLink: share, shareUrl: share, contentId, status: share || id ? "resolvable" : "needs_locator", board, boards: boardInfo(source, sheetName, sourceRow, category), notes: sourceNote(source, sheetName, sourceRow), raw: v };
}
function readSheetSource(source, file, sheetName, lastRow) {
  const payload = JSON.parse(requireSync(file));
  const rows = payload.data?.rows ?? [];
  return rows.filter((r) => r.row_number >= 4 && r.row_number <= lastRow).map((r) => rowFromSheet(source, r, sheetName, r.row_number)).filter(Boolean);
}
function requireSync(file) { return readFileSync(file, "utf8"); }
function readBitableSource(source) {
  const recordPayload = JSON.parse(requireSync(source.file));
  const recordData = recordPayload.data ?? {};
  // +record-list returns `fields` in the exact positional order used by its
  // `data` rows. The separate +field-list endpoint has a different order.
  const names = recordData.fields ?? [];
  const records = recordData.data ?? [];
  const recordIds = recordData.record_id_list ?? [];
  return records.map((record, index) => {
    const mapped = Object.fromEntries(names.map((name, i) => [name, record[i]]));
    const name = clean(mapped["抖音昵称"] ?? mapped["抖音名称"], 120);
    const douyinId = clean(mapped["抖音号"] ?? mapped["抖音ID"], 120);
    const link = clean(mapped["作品链接"] ?? mapped["视频链接"] ?? "", 3000);
    const share = canonicalUrl(link);
    const id = videoId(link);
    const category = clean(mapped["作品类型"] ?? mapped["内容类型"] ?? mapped["内容类型选项"] ?? "", 120);
    const authorOnly = source.kind === "授权作者多维表";
    if (!name && !douyinId && !link) return null;
    return {
      sourceRow: index + 1,
      platform: "douyin",
      name,
      douyinId,
      videoId: id,
      videoLink: share,
      shareUrl: share,
      status: share || id ? "resolvable" : "needs_locator",
      board,
      boards: boardInfo(source, "数据表", index + 1, category || (authorOnly ? "授权作者" : "作品登记")),
      notes: sourceNote(source, "数据表", index + 1, `${recordIds[index] ? `record_id=${recordIds[index]};` : ""}${authorOnly ? `多维表记录;授权=${clean(mapped["临时授权/正式授权"], 80)}` : "多维表记录"}`),
      raw: mapped,
    };
  }).filter(Boolean);
}

function readAllSources() {
  const out = [];
  for (const source of sourceDefs) {
    if (source.mode === "bitable") out.push({ source, rows: readBitableSource(source) });
    else if (source.mode === "sheet-multi") {
      out.push({ source, sheetName: source.sheetName, sheetId: source.sheetId, rows: readSheetSource(source, source.file, source.sheetName, source.effectiveLastRow) });
      out.push({ source, sheetName: source.extra.sheetName, sheetId: source.extra.sheetId, rows: readSheetSource(source, source.extra.file, source.extra.sheetName, source.extra.effectiveLastRow) });
    } else out.push({ source, sheetName: source.sheetName, sheetId: source.sheetId, rows: readSheetSource(source, source.file, source.sheetName, source.effectiveLastRow) });
  }
  return out;
}

function parseJsonArray(value) { try { return JSON.parse(value || "[]"); } catch { return []; } }
function loadExistingEvidence() {
  const posts = JSON.parse(requireSync("/tmp/local_posts.json"));
  const queue = JSON.parse(requireSync("/tmp/local_queue.json"));
  const ids = new Set(posts.map((p) => `v:${p.external_id}`).filter(Boolean));
  const urlsSet = new Set();
  for (const q of queue) {
    for (const id of parseJsonArray(q.video_ids_json)) ids.add(`v:${id}`);
    for (const url of parseJsonArray(q.share_urls_json)) { const canonical = canonicalUrl(url); if (canonical) urlsSet.add(`u:${canonical}`); }
  }
  return { ids, urls: urlsSet, queueCount: queue.length, postCount: posts.length };
}
function rowKey(row) {
  if (row.videoId) return `v:${row.videoId}`;
  if (row.shareUrl) return `u:${row.shareUrl}`;
  if (row.douyinId) return `a:${row.douyinId.toLowerCase()}`;
  return `n:${clean(row.name, 120).toLowerCase()}`;
}
function dedupe(allSources, existing) {
  const seen = new Set();
  const perSource = [];
  const rows = [];
  for (const group of allSources) {
    const before = group.rows.length;
    let intra = 0; let existingCount = 0;
    for (const row of group.rows) {
      const key = rowKey(row);
      const evidenceExisting = row.videoId ? existing.ids.has(`v:${row.videoId}`) : row.shareUrl ? existing.urls.has(`u:${row.shareUrl}`) : false;
      if (seen.has(key)) { intra++; continue; }
      seen.add(key);
      if (evidenceExisting) { existingCount++; continue; }
      rows.push({ ...row, _sourceKind: group.source.kind, _sheetName: group.sheetName ?? "数据表", _sheetId: group.sheetId ?? "", dedupeKey: key });
    }
    perSource.push({ kind: group.source.kind, title: group.source.title, sourceUrl: group.source.sourceUrl, wikiUrl: group.source.wikiUrl, revision: group.source.revision, sheet: group.sheetName ?? "数据表", sheetId: group.sheetId ?? "", rawRows: before, existingEvidenceSkipped: existingCount, crossSourceOrWithinSourceDuplicates: intra, selectedRows: before - existingCount - intra });
  }
  return { rows, perSource };
}

await mkdir(outDir, { recursive: true });
const sourceGroups = readAllSources();
const existing = loadExistingEvidence();
const { rows, perSource } = dedupe(sourceGroups, existing);
const bySource = new Map();
for (const row of rows) {
  const source = sourceDefs.find((item) => item.kind === row._sourceKind);
  const key = `${row._sourceKind}\u0000${row._sheetName}`;
  if (!bySource.has(key)) bySource.set(key, { source, sheetName: row._sheetName, sheetId: row._sheetId, rows: [] });
  const { _sourceKind, _sheetName, _sheetId, dedupeKey, raw, ...cleanRow } = row;
  bySource.get(key).rows.push(cleanRow);
}
const payload = {
  generatedAt: new Date().toISOString(),
  board,
  sourceCount: sourceDefs.length,
  existingEvidence: { postCount: existing.postCount, queueCount: existing.queueCount, videoIds: existing.ids.size, shareUrls: existing.urls.size },
  perSource,
  totalRawRows: perSource.reduce((n, x) => n + x.rawRows, 0),
  totalSelectedRows: rows.length,
  sources: [...bySource.values()].map((group) => ({
    kind: group.source.kind,
    wikiUrl: group.source.wikiUrl,
    sourceUrl: group.source.sourceUrl,
    title: group.source.title,
    sourceRevision: group.source.revision,
    sheetName: group.sheetName,
    sheetId: group.sheetId,
    fileName: `feishu-${group.source.kind.replace(/[^\p{L}\p{N}]+/gu, "-")}-rev${group.source.revision}-20260920.xlsx`,
    rows: group.rows,
  })),
};
await writeFile(`${outDir}/normalized-dedup.json`, JSON.stringify(payload, null, 2));
await writeFile(`${outDir}/source-summary.json`, JSON.stringify({ generatedAt: payload.generatedAt, board, existingEvidence: payload.existingEvidence, perSource, totalRawRows: payload.totalRawRows, totalSelectedRows: payload.totalSelectedRows }, null, 2));
console.log(JSON.stringify({ sourceCount: sourceDefs.length, totalRawRows: payload.totalRawRows, totalSelectedRows: payload.totalSelectedRows, existingEvidence: payload.existingEvidence, perSource }, null, 2));

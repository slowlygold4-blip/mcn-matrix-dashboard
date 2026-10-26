#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { MonitorDatabase } from "../lib/database.mjs";
import { checksum, nowIso } from "../lib/utils.mjs";

const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const BOARD_NAME = "抖音主播板块";
// The roster's display ID for 苏醒 was stale. Keep the submitted value for
// auditability, but use the ID returned by the same public profile endpoint
// that the daily collector verifies.
const VERIFIED_DOUYIN_ID_OVERRIDES = new Map([
  ["苏醒（三角洲行动）", "201013SX"],
]);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const databasePath = resolve(arg("--db", "data/douyin-monitor.sqlite"));
const rosterPath = resolve(arg("--roster", "/Users/tyke/skill-hub/data/douyin_monitor/roster.json"));
const latestPath = resolve(arg("--latest", "/Users/tyke/skill-hub/data/douyin_monitor/latest.json"));
const historyDir = resolve(arg("--history", "/Users/tyke/skill-hub/data/douyin_monitor/history"));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function cleanName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function snapshotDate(document, fileName) {
  const raw = String(document?.generated ?? fileName.replace(/\.json$/, ""));
  const date = new Date(raw.replace(" ", "T") + (raw.length <= 10 ? "T00:00:00" : ":00"));
  return Number.isNaN(date.getTime()) ? new Date(`${fileName.slice(0, 10)}T00:00:00`) : date;
}

function toIso(document, fileName) {
  return snapshotDate(document, fileName).toISOString();
}

function chooseHistoricalRecords(historyFiles) {
  const byLink = new Map();
  const all = [];
  for (const fileName of historyFiles) {
    const document = readJson(join(historyDir, fileName));
    const capturedAt = toIso(document, fileName);
    for (const talent of document.talents ?? []) {
      if (!SEC_UID_RE.test(String(talent.sec_uid ?? ""))) continue;
      const record = { ...talent, capturedAt, fileName, historyLink: talent.link };
      all.push(record);
      if (talent.link) byLink.set(String(talent.link), record);
    }
  }
  return { byLink, all };
}

function matchingHistory(rosterItem, records) {
  const exact = records.byLink.get(String(rosterItem.link ?? ""));
  if (exact) return { record: exact, matchedBy: "roster-link" };

  const target = cleanName(rosterItem.name);
  const candidates = records.all.filter((item) => {
    const candidate = cleanName(item.name);
    return target && candidate && (candidate === target || candidate.includes(target) || target.includes(candidate));
  });
  const bySec = [...new Map(candidates.map((item) => [item.sec_uid, item])).values()];
  if (bySec.length === 1) return { record: bySec[0], matchedBy: "historical-name" };
  if (bySec.length > 1) {
    // Prefer the candidate whose visible name has the greatest overlap with
    // the submitted name, then the newest public snapshot.
    bySec.sort((left, right) => {
      const leftScore = cleanName(left.name) === target ? 2 : 1;
      const rightScore = cleanName(right.name) === target ? 2 : 1;
      return rightScore - leftScore || right.capturedAt.localeCompare(left.capturedAt);
    });
    const bestScore = cleanName(bySec[0].name) === target ? 2 : 1;
    const tied = bySec.filter((item) => (cleanName(item.name) === target ? 2 : 1) === bestScore);
    if (tied.length === 1) return { record: tied[0], matchedBy: "historical-name" };
  }
  return { record: null, matchedBy: "unresolved" };
}

function sourceSnapshot(rosterItem, latest, historical) {
  const current = latest.talents?.find((item) => String(item.link ?? "") === String(rosterItem.link ?? ""));
  // Search-result pages are not account identities. Even if an older history
  // file contains a similarly named creator, do not join the row by fuzzy
  // name matching; the import must wait for a canonical profile/share link or
  // sec_uid from the source sheet.
  if (/^https?:\/\/(?:www\.)?douyin\.com\/search(?:\/|$)/i.test(String(rosterItem.link ?? "").trim())) {
    return {
      record: null,
      matchedBy: "unresolved",
      reason: "抖音搜索结果页不是稳定账号身份；需要官方主页、分享链接或 sec_uid",
    };
  }
  const matched = matchingHistory(rosterItem, historical);
  const record = current?.sec_uid && SEC_UID_RE.test(String(current.sec_uid))
    ? { ...current, capturedAt: toIso(latest, "latest.json"), fileName: "latest.json", historyLink: current.link }
    : matched.record;
  if (!record || !SEC_UID_RE.test(String(record.sec_uid ?? ""))) {
    // Keep the row visible in the import result instead of silently dropping
    // it or inventing an account identity from a search URL/name.  A search
    // page is not a stable account locator, so this row must remain outside
    // the monitor until a canonical profile/share link or sec_uid is supplied.
    return {
      record: null,
      matchedBy: "unresolved",
      reason: "极炫历史中未找到可验证 sec_uid；原始链接不是可直接监控的账号主页或分享链接",
    };
  }
  const stale = !current?.sec_uid || Boolean(current?.error) || matched.matchedBy !== "roster-link";
  return { record, matchedBy: current?.sec_uid ? "jixuan-latest" : matched.matchedBy, stale };
}

function sourceMetadata(rosterItem, source) {
  const record = source.record;
  const submittedDouyinId = String(rosterItem.dyid ?? "").trim();
  const verifiedDouyinId = VERIFIED_DOUYIN_ID_OVERRIDES.get(String(rosterItem.name ?? "").trim()) || submittedDouyinId;
  return {
    platform: "douyin",
    douyinId: verifiedDouyinId,
    accountIdMode: "sec_uid-primary",
    ...(submittedDouyinId ? { submittedDouyinId } : {}),
    rating: String(rosterItem.rating ?? "").trim(),
    baseFans: String(rosterItem.base_fans ?? "").trim(),
    source: "极炫工作台",
    sourceLink: String(rosterItem.link ?? "").trim(),
    importSource: {
      type: "jixuan-douyin-roster",
      fileName: "data/douyin_monitor/roster.json",
      importedAt: nowIso(),
    },
    resolution: {
      mode: "jixuan-public-profile-api",
      matchedBy: source.matchedBy,
      canonicalAccountId: String(record.sec_uid),
      canonicalAccountUrl: `https://www.douyin.com/user/${record.sec_uid}`,
      sourceEvidenceUrl: String(record.historyLink ?? rosterItem.link ?? ""),
      provenance: "public-ttwid-official-profile",
      resolvedAt: String(record.capturedAt),
      verificationPolicy: "historical-sec-uid-and-public-profile",
    },
  };
}

function boardEntry(rosterItem, source) {
  return {
    name: BOARD_NAME,
    category: "抖音主播",
    tier: String(rosterItem.rating ?? "").trim(),
    note: source.stale
      ? `极炫工作台历史基线导入；来源快照 ${source.record.fileName}，下一次每日采集更新`
      : "极炫工作台公开接口监控名单",
  };
}

function numeric(value) {
  return value === null || value === undefined || value === "" || Number.isNaN(Number(value)) ? null : Math.max(0, Math.round(Number(value)));
}

function insertBaseline(database, target, rosterItem, source) {
  const record = source.record;
  const capturedAt = String(record.capturedAt);
  const followers = numeric(record.fans);
  const totalLikes = numeric(record.likes);
  const totalPosts = numeric(record.works);
  const accountStatus = followers !== null && totalLikes !== null ? "available" : followers !== null || totalLikes !== null ? "partial" : "unavailable";
  const warnings = source.stale ? [`初始数据来自极炫工作台 ${record.fileName} 历史快照；下一次每日采集将刷新`] : [];
  const quality = warnings.length ? "warning" : "validated";
  const raw = { source: "jixuan-douyin-monitor", roster: rosterItem, snapshot: record, matchedBy: source.matchedBy };
  const sourceChecksum = checksum(raw);
  database.db.prepare(`
    INSERT OR IGNORE INTO snapshots(
      target_id,captured_at,followers,total_likes,total_posts,hashtag_views,hashtag_posts,author_count,
      quality_status,account_status,works_coverage,account_error,works_error,warnings_json,source_checksum,raw_json
    ) VALUES(?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?,?,?,?)
  `).run(
    target.id, capturedAt, followers, totalLikes, totalPosts, quality, accountStatus,
    totalPosts === null ? "unknown" : "complete", null, null, JSON.stringify(warnings), sourceChecksum, JSON.stringify(raw),
  );
  database.db.prepare(`
    UPDATE targets SET last_checked_at=?,last_status=?,last_error=?,updated_at=? WHERE id=? AND (last_checked_at IS NULL OR last_checked_at < ?)
  `).run(capturedAt, quality, warnings[0] ?? null, nowIso(), target.id, capturedAt);
  return { capturedAt, followers, totalLikes, totalPosts, quality, stale: source.stale };
}

const roster = readJson(rosterPath);
const latest = readJson(latestPath);
const historyFiles = readdirSync(historyDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
const history = chooseHistoricalRecords(historyFiles);
const rawSources = roster.map((item) => ({ item, source: sourceSnapshot(item, latest, history) }));
const unresolved = rawSources
  .filter(({ source }) => !source.record)
  .map(({ item, source }) => ({
    name: String(item.name ?? "").trim(),
    link: String(item.link ?? "").trim(),
    douyinId: String(item.dyid ?? "").trim(),
    reason: String(source.reason ?? "未找到可验证账号身份").trim(),
  }));
const dedupedSources = new Map();
for (const entry of rawSources) {
  if (!entry.source.record) continue;
  const key = entry.source.record.sec_uid;
  const previous = dedupedSources.get(key);
  if (!previous) {
    dedupedSources.set(key, { ...entry, duplicateRows: [] });
    continue;
  }
  previous.duplicateRows.push({ name: entry.item.name, link: entry.item.link });
}
const sources = [...dedupedSources.values()];
const uniqueSecUids = new Set(sources.map(({ source }) => source.record.sec_uid));

const database = new MonitorDatabase(databasePath);
try {
  const inputs = sources.map(({ item, source }) => ({
    label: String(item.name ?? source.record.name ?? "抖音主播").trim().slice(0, 120),
    locator: String(source.record.sec_uid),
    provider: "public-web",
    metadata: sourceMetadata(item, source),
    boards: [boardEntry(item, source)],
  }));
  const imported = inputs.length
    ? database.importAuthorTargets(inputs, {
      fileName: "data/douyin_monitor/roster.json",
      sheetName: BOARD_NAME,
      reviewedRows: roster.length,
      skippedCount: unresolved.length,
    })
    : { created: [], skipped: [], boardMembershipsAdded: 0, boardMembershipsUpdated: 0 };

  // importAuthorTargets intentionally preserves existing metadata. Merge the
  // Jixuan provenance on reruns while keeping any existing fields untouched.
  for (const input of inputs) {
    const target = database.db.prepare("SELECT * FROM targets WHERE type='account' AND locator=? AND provider='public-web'").get(input.locator);
    if (!target) throw new Error(`目标写入后无法回读：${input.label}`);
    const current = database.getTarget(Number(target.id));
    database.updateTarget(Number(target.id), {
      label: input.label,
      locator: input.locator,
      provider: "public-web",
      enabled: true,
      metadata: { ...(current.metadata ?? {}), ...input.metadata },
    });
  }

  const baseline = [];
  for (const { item, source } of sources) {
    const targetRow = database.db.prepare("SELECT id FROM targets WHERE type='account' AND locator=? AND provider='public-web'").get(source.record.sec_uid);
    const result = insertBaseline(database, database.getTarget(Number(targetRow.id)), item, source);
    baseline.push({ name: item.name, targetId: Number(targetRow.id), ...result, matchedBy: source.matchedBy, sourceFile: source.record.fileName });
  }

  const timestamp = nowIso();
  const staleCount = baseline.filter((item) => item.stale).length;
  database.db.prepare(`
    INSERT INTO runs(trigger_type,started_at,finished_at,status,target_count,success_count,error_count,details_json)
    VALUES('migration',?,?, ?,?,?,0,?)
  `).run(
    timestamp,
    timestamp,
    unresolved.length ? "partial" : "success",
    baseline.length,
    baseline.length,
    JSON.stringify([{
      source: "jixuan-douyin-monitor",
      board: BOARD_NAME,
      staleCount,
      rosterCount: roster.length,
      unresolvedCount: unresolved.length,
      unresolved: unresolved.slice(0, 100),
    }]),
  );
  if (unresolved.length) {
    database.db.prepare(`
      INSERT INTO audits(target_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message)
      VALUES(NULL,?,'public-web','warning',0,?,?,?)
    `).run(
      timestamp,
      JSON.stringify(unresolved.slice(0, 100)),
      checksum({ source: "jixuan-douyin-monitor", board: BOARD_NAME, rosterCount: roster.length, unresolved }),
      `极炫名单严格导入：${unresolved.length} 行缺少可验证账号身份，已保留在导入审查中，未创建监控目标`,
    );
  }

  console.log(JSON.stringify({
    ok: true,
    board: BOARD_NAME,
    rosterCount: roster.length,
    uniqueSecUidCount: uniqueSecUids.size,
    duplicateRosterRows: roster.length - uniqueSecUids.size,
    createdCount: imported.created.length,
    reusedCount: imported.skipped.length,
    boardMembershipsAdded: imported.boardMembershipsAdded,
    staleBaselineCount: staleCount,
    activeBoardTargets: database.listTargets({ board: BOARD_NAME }).filter((target) => target.enabled).length,
    latestSnapshotAt: baseline.map((item) => item.capturedAt).sort().at(-1) ?? null,
    unresolved,
  }, null, 2));
} finally {
  database.close();
}

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseAuthorSpreadsheet } from "../lib/author-spreadsheet.mjs";

const [sourcePath, importFileName, outputPath] = process.argv.slice(2);
if (!sourcePath || !importFileName || !outputPath) throw new Error("Provide source, exact import file name and receipt path");
const source = readFileSync(sourcePath, "utf8");
// This pasted roster has three named headers plus an unnamed video-ID column.
const normalized = source.replace(/^[^\r\n]+/, "作者名称\t抖音号\t视频链接\t作品ID");
const preview = await parseAuthorSpreadsheet({ buffer: Buffer.from(normalized), fileName: "roster.tsv" });
const database = new DatabaseSync("data/douyin-monitor.sqlite", { readOnly: true });
const key = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
database.exec("BEGIN");
const targets = database.prepare("SELECT * FROM targets").all().map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) }));
const queue = database.prepare("SELECT * FROM author_resolution_queue WHERE file_name=?").all(importFileName);
const blockers = database.prepare("SELECT resolved_target_id,last_error FROM author_resolution_queue WHERE suspended_target_enabled IS NOT NULL AND status<>'resolved'").all();
const snapshots = database.prepare(`SELECT * FROM snapshots WHERE id IN (SELECT max(id) FROM snapshots GROUP BY target_id)`).all();
database.exec("COMMIT");
database.close();
const groups = new Map();
for (const row of preview.rows) {
  const identity = row.douyinId ? `id:${key(row.douyinId)}` : `name:${key(row.name)}`;
  if (!groups.has(identity)) groups.set(identity, []);
  groups.get(identity).push(row);
}
const accounts = [...groups.values()].map((rows) => {
  const id = rows[0].douyinId;
  const evidence = id ? queue.filter((item) => key(item.douyin_id) === key(id)) : [];
  const resolvedIds = new Set(evidence.filter((item) => item.status === "resolved").map((item) => item.resolved_target_id));
  const matches = targets.filter((target) => resolvedIds.has(target.id) || (id && [target.metadata.douyinId,
    target.metadata.resolution?.publicDouyinId].filter(Boolean).some((value) => key(value) === key(id))));
  const target = matches.length === 1 ? matches[0] : null;
  const snapshot = target ? snapshots.find((item) => item.target_id === target.id) : null;
  const status = matches.length > 1 ? "多目标冲突"
    : target?.enabled ? (snapshot ? "监控中·已有数据" : "监控中·待首次数据")
      : target ? "已有账号记录·监控未启用"
        : evidence.some((item) => ["pending", "retry"].includes(item.status)) ? "后台继续核验"
          : evidence.length ? "未通过身份核验" : "缺少唯一账号信息";
  return { names: [...new Set(rows.map((row) => row.name))], douyinId: id, sourceRows: rows.map((row) => row.sourceRow),
    status, targetId: target?.id ?? null, enabled: Boolean(target?.enabled),
    firstImportedThisBatch: Boolean(target && target.created_at >= "2026-09-13T08:16:32.423Z"),
    capturedAt: snapshot?.captured_at ?? null, followers: snapshot?.followers ?? null,
    totalLikes: snapshot?.total_likes ?? null, totalPosts: snapshot?.total_posts ?? null,
    evidence: Object.fromEntries(["resolved", "pending", "retry", "rejected"].map((state) => [state, evidence.filter((item) => item.status === state).length])),
    issues: [...new Set([...evidence.filter((item) => item.status !== "resolved").map((item) => item.last_error),
      ...(target && !target.enabled ? blockers.filter((item) => item.resolved_target_id === target.id).map((item) => `历史证据：${item.last_error}`) : [])].filter(Boolean))] };
});
const countTargets = (predicate) => new Set(accounts.filter(predicate).map((item) => item.targetId).filter(Boolean)).size;
const aliases = [...new Set(accounts.map((item) => item.targetId).filter(Boolean))].map((targetId) => ({
  targetId, submittedIds: accounts.filter((item) => item.targetId === targetId).map((item) => item.douyinId),
})).filter((item) => item.submittedIds.length > 1);
const summary = { readAt: new Date().toISOString(), sourceSha256: createHash("sha256").update(source).digest("hex"),
  sourceRows: preview.rows.length, uniqueNonemptyAccountIds: accounts.filter((item) => item.douyinId).length,
  nicknameOnly: accounts.filter((item) => !item.douyinId).length,
  enabledSubmittedIds: accounts.filter((item) => item.enabled).length,
  enabled: countTargets((item) => item.enabled),
  enabledWithData: countTargets((item) => item.enabled && item.capturedAt),
  newlyCreatedEnabled: countTargets((item) => item.enabled && item.firstImportedThisBatch),
  reusedEnabled: countTargets((item) => item.enabled && !item.firstImportedThisBatch),
  statusCounts: Object.fromEntries([...new Set(accounts.map((item) => item.status))].map((status) => [status, accounts.filter((item) => item.status === status).length])),
  queue: Object.fromEntries(["resolved", "pending", "retry", "rejected"].map((status) => [status, queue.filter((item) => item.status === status).length])) };
const escape = (value) => String(value ?? "—").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const lines = ["# 本次抖音名单录入核对", "", `核对时间：${summary.readAt}`, "",
  `原始记录 ${summary.sourceRows} 条；${summary.uniqueNonemptyAccountIds} 个非空抖音号，另有 ${summary.nicknameOnly} 条仅昵称。`, "",
  `启用监控 ${summary.enabled} 个，其中新建 ${summary.newlyCreatedEnabled} 个、复用已有 ${summary.reusedEnabled} 个；已有数据 ${summary.enabledWithData} 个。`, "",
  `已启用的 ${summary.enabledSubmittedIds} 个提交账号标识实际对应 ${summary.enabled} 个独立账号；官方抖音号与旧数字号可指向同一账号，以下别名不重复计数：${aliases.map((item) => item.submittedIds.join(" = ")).join("；") || "无"}。`, "",
  "说明：后台证据核验次数不是作者数。某条作品无法核验不等于该账号没有其他有效证据；缺失数据保留为空，不填 0。新增账号的日增量须等后续有效快照形成基线。", "",
  "## 尚未启用", "", "| 原始作者名 | 抖音号 | 源行 | 当前状态 | 核对说明 |", "|---|---|---|---|---|"];
for (const item of accounts.filter((item) => !item.enabled)) lines.push(`| ${escape(item.names.join(" / "))} | ${escape(item.douyinId || "缺失")} | ${item.sourceRows.join(", ")} | ${item.status} | ${escape(item.issues.join("；").slice(0, 760) || (!item.douyinId ? "只有昵称，不能唯一确认账号" : "证据处理中"))} |`);
lines.push("", "## 全部账号回读", "", "| 原始作者名 | 抖音号 | 状态 | 粉丝 | 累计获赞 | 作品数 | 最近采集 |", "|---|---|---|---:|---:|---:|---|");
for (const item of accounts) lines.push(`| ${[item.names.join(" / "), item.douyinId || "缺失", item.status, item.followers, item.totalLikes, item.totalPosts, item.capturedAt].map(escape).join(" | ")} |`);
lines.push("", `原始附件 SHA-256：${summary.sourceSha256}`, "");
writeFileSync(outputPath, lines.join("\n"));
writeFileSync(`${outputPath}.json`, JSON.stringify({ summary, aliases, accounts }, null, 2));
console.log(JSON.stringify({ ...summary, receipt: outputPath }));

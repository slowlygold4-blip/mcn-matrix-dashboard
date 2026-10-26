import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";

const directory = "data/yuqilin-import-Nl4JQn";
const db = new DatabaseSync("data/douyin-monitor.sqlite", { readOnly: true });
const before = new DatabaseSync(`${directory}/before.sqlite`, { readOnly: true });
const source = JSON.parse(await readFile(`${directory}/source-audit.json`, "utf8"));
const originalNames = new Set(source.authors.flatMap(author => author.names).map(name => name.normalize("NFKC")));
const targets = db.prepare(`SELECT t.id,t.label,t.locator,t.enabled,t.last_checked_at,t.metadata_json,
  s.followers,s.total_likes,s.total_posts,s.captured_at,s.account_status,s.works_coverage
  FROM target_boards b JOIN targets t ON t.id=b.target_id
  LEFT JOIN snapshots s ON s.id=(SELECT id FROM snapshots WHERE target_id=t.id ORDER BY captured_at DESC,id DESC LIMIT 1)
  WHERE b.board_key=? ORDER BY t.id`).all("玉麒麟切片矩阵").map(target => {
  const metadata = JSON.parse(target.metadata_json);
  const { metadata_json, ...rest } = target;
  return { ...rest, publicDouyinId: metadata.resolution?.publicDouyinId || metadata.douyinId,
    submittedName: metadata.submittedName, source: metadata.importSource,
    identityVerification: metadata.identityVerification, nameVerification: metadata.nameVerification };
});
const outsideSource = targets.filter(target => !originalNames.has(String(target.submittedName || target.label).normalize("NFKC")));
const preservation = {};
for (const table of ["targets", "snapshots", "posts", "post_metrics"]) {
  const rows = before.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  const find = db.prepare(`SELECT * FROM ${table} WHERE id=?`);
  const changed = rows.filter(row => JSON.stringify(find.get(row.id)) !== JSON.stringify(row)).map(row => row.id);
  preservation[table] = { beforeCount: rows.length, unchanged: changed.length === 0, changedIds: changed };
}
const oldBoards = before.prepare("SELECT * FROM target_boards ORDER BY target_id,board_key").all();
const boardLookup = db.prepare("SELECT * FROM target_boards WHERE target_id=? AND board_key=?");
preservation.targetBoards = { beforeCount: oldBoards.length,
  unchanged: oldBoards.every(row => JSON.stringify(boardLookup.get(row.target_id,row.board_key)) === JSON.stringify(row)) };
const queues = db.prepare(`SELECT file_name,status,count(*) count FROM author_resolution_queue
  WHERE file_name IN (?,?) GROUP BY file_name,status`).all("玉麒麟寒川8月结算表.xlsx", "玉麒麟作者信息复核-20260913.xlsx");
const result = { readAt: new Date().toISOString(), source: { wikiUrl: source.wikiUrl, title: source.title,
  revision: source.revision, dataRange: "A1:H175", fullyReadRange: source.cloudMeta.actual_range,
  dataRows: source.dataRows, authorNameCount: source.authorNameCount, submittedAccountIdCount: source.submittedAccountIdCount },
  board: "玉麒麟切片矩阵", targetCount: targets.length, collectedCount: targets.filter(target => target.captured_at && target.followers != null && target.total_likes != null).length,
  outsideSource, preservation, queues, targets };
await writeFile(`${directory}/receipt.json`, JSON.stringify(result, null, 2));
const value = number => number == null ? "—" : Number(number).toLocaleString("zh-CN");
const report = ["# 玉麒麟切片矩阵 · 导入与监控核对", "",
  `核对时间：${result.readAt}（UTC）。`, "",
  `[打开指挥台本板块](http://127.0.0.1:4188/?v=20260913-yuqilin-evidence-1&board=${encodeURIComponent(result.board)}#targets)`, "",
  `来源：[${source.title}](${source.wikiUrl})，工作表「8月」，修订 ${source.revision}。完整读取 A1:T514；有效范围 A1:H175。`, "",
  `原表共 174 条结算记录、19 个作者名称、30 个提交抖音号值。现已接入 ${result.targetCount} 个独立监控账号，${result.collectedCount} 个已取得粉丝与累计获赞快照。`, "",
  "## 身份与最新公开数据", "",
  "| 作者 | 核实抖音号 | 粉丝 | 累计获赞 | 作品总数 | 快照时间（UTC） |",
  "|---|---|---:|---:|---:|---|",
  ...targets.map(target => `| ${target.label} | ${target.publicDouyinId || "—"} | ${value(target.followers)} | ${value(target.total_likes)} | ${value(target.total_posts)} | ${target.captured_at || "尚未采集"} |`), "",
  "## 来源差异与保留原则", "",
  "- 沐旬：原填 5936790498；两条不同作品均回显同名作者、同一主页与当前号 59367904987。",
  "- 枕川：原填 7397873473；两条不同作品均回显同名作者、同一主页与当前号 57397873473。",
  "- 这两位作者通过独立的账号信息复核名单重新严格核验，保留原号码、原行号、作品链接及原始导入记录；未改飞书原表。现有证据不用于断言历史号码是否变更。",
  "- 景晗、青勾、渡风有连续递增的提交号码，按实际作品发布者核对；不按这些不同号码重复建账号。",
  "- 第 93、104、106、116、117 行作品链接为空；名单保留，作者可通过同表其他有效作品确认。",
  "- 第 111–113 行的 /user/.../search 路径只代表搜索上下文，不作为星叙主页；保留 modal_id 反查作品作者。",
  "- 证据队列按作品记录计数，同一作者可有多条。未确认或未通过的作品证据不等于该作者未进入监控。未通过记录没有被强制改成通过。",
  "- 8月结算播放、点赞、评论、收藏及截图未作为实时数据写入。实时指标来自公开采集快照；每日涨粉、新增点赞需要两次可比快照。估算新增播放 = 新增点赞 × 100，不是平台实测播放。", "",
  "## 数据保全", "",
  ...Object.entries(preservation).map(([table, status]) => `- ${table}：原 ${status.beforeCount} 条${status.unchanged ? "逐条比对一致" : "存在变化，见 receipt.json"}。`),
  "- 原始云端单元格、导入预览与修订校验凭证、公开身份复核返回、导入前数据库备份均保存在本核对文件同目录。", "",
].join("\n");
await writeFile(`${directory}/玉麒麟导入核对.md`, report);
console.log(JSON.stringify({ targetCount: result.targetCount, collectedCount: result.collectedCount, outsideSource,
  preservation, queues, report: `${directory}/玉麒麟导入核对.md` }));
db.close();
before.close();

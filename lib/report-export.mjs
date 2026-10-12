import { csvEscape } from "./utils.mjs";
import { describeWorkPlays } from "./work-play-semantics.mjs";

export function reportCsv(report) {
  const scopeName = report.selectedBoard?.name || "全部板块";
  const scopeBasis = report.scopeBasis?.description;
  const scopeHeader = scopeBasis ? `报告筛选范围（${scopeName}）；${scopeBasis}` : `报告筛选范围（${scopeName}）`;
  const header = [scopeHeader, "作品ID", "监控目标", "作者", "发布时间", "点赞", "评论", "分享", "收藏", "来源播放字段（非估算）", "标题", "链接", "播放字段说明"];
  const rows = report.posts.map((post) => [scopeName, post.external_id, post.target_label, post.author_name,
    post.published_at, post.likes, post.comments, post.shares, post.collects, post.plays, post.caption, post.url,
    (post.playsEvidence ?? describeWorkPlays(post.plays)).note]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

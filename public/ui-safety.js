export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

export function safeHttpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function warningText(value) {
  const structured = value && typeof value === "object" && !Array.isArray(value)
    ? [value.reason, value.error, value.message, value.warning].find((item) => typeof item === "string" && item.trim())
    : null;
  return String(structured ?? (value && typeof value === "object" ? "结构化审查记录已保留" : value ?? "")).trim();
}

export function warningListText(values = []) {
  return (Array.isArray(values) ? values : [values]).map(warningText).filter(Boolean).join("；");
}

export const RETRY_WARNING_PATTERN = /未识别到作品列表|作品列表接口未通过|HTTP\s*403|限流|空内容|失败|受限|超时|连续/;

export function reviewStatus(status, warnings = []) {
  const text = warningListText(warnings);
  if (/历史多作品|逐项复核|全部作品逐项确认/.test(text) && status === "warning") return { key: "retry", label: "身份逐项复核" };
  if (/历史短链|原始路径大小写不可恢复/.test(text) && status === "rejected") return { key: "manual", label: "需重提原始短链" };
  if (status === "validated") return { key: "complete", label: "已完整采集" };
  if (status === "warning" && RETRY_WARNING_PATTERN.test(text)) return { key: "retry", label: "自动重试" };
  if (status === "warning") return { key: "limited", label: "范围受限" };
  if (status === "rejected") return { key: "manual", label: "需人工核验" };
  if (status === "error") return { key: "failed", label: "采集失败" };
  return { key: "pending", label: "待首次采集" };
}

export function humanizeWarning(value) {
  const warning = warningText(value);
  if (/ArgusSecurityPlugin|Uifid Not Found|HTTP\s*403/i.test(warning)) return "抖音当前限制了作品列表的匿名公开读取；主页快照仍已保存，本次未用空值覆盖历史。";
  if (/未识别到作品列表|作品列表接口未通过/i.test(warning)) return "本次没有取得完整作品列表；系统保留已有作品与历史指标，并按计划自动重试。";
  if (/images?_base/i.test(warning)) return "该作品类型的公开详情当前受限；系统未凭空补写作者或指标。";
  return warning || "未提供具体说明";
}

export function humanizedWarningHtml(value) {
  return escapeHtml(humanizeWarning(value));
}

export function httpLinkOrTextHtml(value, label) {
  const href = safeHttpUrl(value);
  if (!href) return `<span>${escapeHtml(label)}</span>`;
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

export function authorEvidenceHtml(item = {}) {
  const output = [];
  const videoIds = Array.isArray(item.videoIds) ? item.videoIds.slice(0, 3) : [];
  const shareUrls = Array.isArray(item.shareUrls) ? item.shareUrls.slice(0, 3) : [];
  for (const value of videoIds) {
    const evidence = String(value ?? "").trim();
    if (!evidence) continue;
    const href = /^\d{15,25}$/.test(evidence)
      ? `https://www.douyin.com/video/${evidence}`
      : safeHttpUrl(evidence);
    output.push(httpLinkOrTextHtml(href, `作品 ${evidence}`));
  }
  for (const value of shareUrls) {
    const evidence = String(value ?? "").trim();
    if (!evidence) continue;
    output.push(httpLinkOrTextHtml(evidence, `分享链接 ${evidence}`));
  }
  return output.length ? output.join("、") : escapeHtml("未返回可用作品证据");
}

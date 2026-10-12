import { RETRY_WARNING_PATTERN, authorEvidenceHtml, escapeHtml, httpLinkOrTextHtml, humanizeWarning, humanizedWarningHtml, reviewStatus, warningListText } from "./ui-safety.js";
import { BOARD_ALL, BOARD_UNASSIGNED, boardCounts, createBoardCatalog, filterTargetsByBoard, normalizeBoardSelection, rowsWithDefaultBoard, scopeReportToBoard, targetBoardLabels } from "./board-scope.js";
import { createProductDashboard } from "./product-dashboard.js?v=20261004-topic-target-metrics-verified-1";
import { createAccountDetail } from "./account-detail.js";
import { businessDateKey, businessTimeZoneLabel, formatBusinessTimestamp, resolveBusinessTimeZone } from "./business-time.js";
import { isPublicShareOrigin, managementOriginLabel, preferredShareOrigin as resolveShareOrigin, shareEntryHint } from "./access-sharing.js?v=20261004-fresh-tunnel-share-1";

function initialBoardSelection() {
  try { return new URL(location.href).searchParams.get("board") || BOARD_ALL; }
  catch { return BOARD_ALL; }
}

const state = {
  data: null,
  boardAutomation: null,
  auth: null,
  access: null,
  period: "day",
  dailyReportReference: null,
  dailyReportPinned: false,
  dailyReportCache: {},
  contributorMetric: "followers",
  busy: false,
  targetQuery: "",
  targetFilter: "all",
  targetSort: "attention",
  targetPage: 0,
  targetPageSize: 8,
  authorFile: null,
  authorFileBase64: null,
  authorPreview: null,
  authorDefaultBoard: "",
  authorSourceMode: null,
  authorLarkUrl: null,
  authorQueueStatus: "all",
  authorQueueBoard: BOARD_ALL,
  authorQueueRequest: 0,
  boardSelection: initialBoardSelection(),
  boardReportCache: {},
  boardReportLoading: new Set(),
  initialHashAligned: false,
  runtimeAudit: null,
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function openProductImport(board = state.boardSelection) {
  if (!state.auth?.permissions?.edit) return toast("当前账号为只读权限，请联系管理员开通编辑权限", "error");
  state.authorDefaultBoard = [BOARD_ALL, BOARD_UNASSIGNED].includes(board) ? "" : board;
  renderAuthorBoardChoices();
  if (state.authorPreview) renderAuthorReview(state.authorPreview);
  openDialog($("#authorSpreadsheetDialog"));
}

const accountDetail = createAccountDetail({
  api,
  canManage: () => Boolean(state.auth?.permissions?.edit),
  onAction: async ({ type, targetId, enabled }) => {
    if (type !== "set-enabled") throw new Error("不支持此操作");
    if (!state.auth?.permissions?.edit) throw new Error("当前账号为只读权限");
    await api(`/api/targets/${targetId}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    await refresh({ quiet: true });
  },
  onBoardSelect: (board) => { selectBoard(board); location.hash = "#boards"; },
});
const productDashboard = createProductDashboard({
  api,
  onAccount: (id, options) => accountDetail.open(id, options),
  onBoard: selectBoard,
  onImport: openProductImport,
  onSettings: () => {
    if (!state.auth?.permissions?.administer) return toast("需要管理员调整采集设置", "error");
    openDialog($("#settingsDialog")); renderSavedCollectorProbe();
  },
  onSource: async (source) => {
    openProductImport(source.defaultBoard || state.boardSelection);
    if (!state.auth?.permissions?.edit) return;
    $("#authorLarkUrl").value = source.sourceUrl;
    try { await previewAuthorLarkSpreadsheet(); } catch (error) { toast(error.message, "error"); }
  },
});

function formatNumber(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return "—";
  return new Intl.NumberFormat("zh-CN", { notation: Math.abs(number) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(number);
}

function formatSignedNumber(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return "—";
  return new Intl.NumberFormat("zh-CN", {
    notation: Math.abs(number) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(number);
}

function formatExactNumber(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(number);
}

function formatExactSignedNumber(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(number);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  if (!["number", "string"].includes(typeof value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function businessTimeZone() {
  return resolveBusinessTimeZone(state.data?.scheduler?.timeZone, state.data?.timeZone);
}

function formatDate(value, options = {}) {
  return formatBusinessTimestamp(value, { timeZone: businessTimeZone(), ...options });
}

function formatRunDuration(run) {
  const started = Date.parse(run?.started_at || "");
  const finished = Date.parse(run?.finished_at || "");
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return "时长未知";
  const seconds = Math.max(0, Math.round((finished - started) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

function scheduleStateLabel(scheduleState, scheduleTime = "10:00", { next = false } = {}) {
  const time = scheduleTime || "10:00";
  if (scheduleState === "running") return `正在执行 · ${next ? "下一次 " : "计划 "}${time}`;
  if (scheduleState === "completed") return `今日已完成 · ${time}`;
  if (scheduleState === "partial") return `今日部分完成 · ${time}`;
  if (scheduleState === "failed") return `今日采集失败 · ${time}`;
  if (scheduleState === "interrupted") return `今日批次中断 · ${time}`;
  if (scheduleState === "due") return `应已启动 · ${time}`;
  return `等待今日 ${time}`;
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const csrfHeaders = !["GET", "HEAD", "OPTIONS"].includes(method) && state.auth?.csrfToken ? { "X-CSRF-Token": state.auth.csrfToken } : {};
  let response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...csrfHeaders, ...(options.headers ?? {}) } });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const wrapped = new Error("网络连接暂时中断，请检查工作台服务是否运行，然后重试");
    wrapped.code = "network_error";
    wrapped.cause = error;
    throw wrapped;
  }
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    error.status = response.status; error.code = payload.code;
    error.payload = payload;
    throw error;
  }
  return payload;
}

let toastTimer;
function toast(message, type = "success") {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast visible ${type === "error" ? "error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 3600);
}

function renderCollectorProbe({ result = null, error = null, loading = false, checkedAt = null } = {}) {
  const element = $("#collectorProbeResult");
  if (!element) return;
  if (loading) {
    element.dataset.state = "loading";
    element.innerHTML = '<strong>公开链路自检 · 正在连接</strong><span>正在分别验证主页、作品窗口和热榜；不会打开个人浏览器，也不会保存登录态。</span>';
    return;
  }
  if (error) {
    element.dataset.state = "error";
    element.innerHTML = `<strong>公开链路自检 · 未完成</strong><span>${escapeHtml(error.message || "公开采集链路未完成")}</span>${checkedAt ? `<small>上次自检：${escapeHtml(formatDate(checkedAt))}</small>` : ""}`;
    return;
  }
  const profile = Boolean(result?.profileEndpoint);
  const posts = Boolean(result?.postsEndpoint);
  const hot = Boolean(result?.hotEndpoint);
  const overall = profile && hot && posts ? "success" : profile ? "warning" : "error";
  const overallLabel = overall === "success" ? "可用" : overall === "warning" ? "主页可用，作品窗口受限" : "不可用";
  const check = (label, ok, limited = false) => `<span class="collector-probe-chip ${ok ? "ok" : limited ? "limited" : "bad"}"><b>${escapeHtml(label)}</b>${ok ? "通过" : limited ? "受限" : "未通过"}</span>`;
  const warning = Array.isArray(result?.warnings) && result.warnings.length ? ` · ${escapeHtml(result.warnings.slice(0, 2).join("；"))}` : "";
  const identity = result?.nickname ? `自检作者：${escapeHtml(result.nickname)}${result.followerCount != null ? ` · 粉丝 ${escapeHtml(formatNumber(result.followerCount))}` : ""}` : "匿名公开端点未返回作者摘要";
  const scope = posts ? `作品窗口返回 ${escapeHtml(formatNumber(result?.postCount ?? 0))} 条样本，按公开窗口口径入库。` : "作品端点受当前风控限制；系统只保留历史，不把空响应写成 0。";
  element.dataset.state = overall;
  element.innerHTML = `<strong>公开链路自检 · ${overallLabel}</strong><span>${identity}${warning}</span><div class="collector-probe-grid">${check("主页", profile)}${check("作品窗口", posts, profile)}${check("热榜", hot)}</div><small>${scope} · 无密钥、无个人登录、无持久浏览器会话。</small>${checkedAt ? `<small>上次自检：${escapeHtml(formatDate(checkedAt))}</small>` : ""}`;
}

function renderSavedCollectorProbe() {
  const probe = state.data?.publicProbe;
  if (!probe) return;
  if (probe.ok && probe.result) renderCollectorProbe({ result: probe.result, checkedAt: probe.checkedAt });
  else renderCollectorProbe({ error: new Error(probe.error || "公开采集链路未完成"), checkedAt: probe.checkedAt });
}

function statusLabel(status) {
  return ({ validated: "已校验", warning: "有警告", error: "采集失败", rejected: "已拒绝", pending: "待首次自动采集", success: "成功", partial: "部分成功", running: "运行中", interrupted: "已中断" })[status] || status || "待首次自动采集";
}

function statusControl(status, warnings = [], attributes = "", reviewOverride = null) {
  const review = reviewOverride || reviewStatus(status, warnings);
  const actionable = Boolean(String(attributes).trim()) && status !== "pending";
  return actionable
    ? `<button class="status-pill status-pill-button ${escapeHtml(review.key)}" ${attributes} type="button">${escapeHtml(review.label)}</button>`
    : `<span class="status-pill ${escapeHtml(review.key)}">${escapeHtml(review.label)}</span>`;
}

function profileHealthReview(accountStatus, worksCoverage, status, warnings = [], { stale = false } = {}) {
  const profileUsable = ["available", "partial"].includes(String(accountStatus ?? ""));
  if (!profileUsable) return reviewStatus(status, warnings);
  if (stale) return { key: "stale", label: "沿用上次有效主页" };
  if (["retry", "unavailable"].includes(String(worksCoverage ?? ""))) return { key: "profile", label: "主页已更新 · 作品待补采" };
  if (["limited", "latest-public-window"].includes(String(worksCoverage ?? ""))) return { key: "profile", label: "主页已核验 · 最新作品窗口" };
  if (String(worksCoverage ?? "") === "unknown") return { key: "pending", label: "主页已更新 · 作品覆盖待判定" };
  return { key: "complete", label: "主页与作品已更新" };
}

function targetNeedsEvidence(target) {
  if (target?.last_status !== "error") return false;
  const text = [target?.last_error, ...(Array.isArray(target?.latestWarnings) ? target.latestWarnings : [])].filter(Boolean).join("；");
  return /身份|(?:账号|抖音号).{0,16}(?:不一致|未回显|缺失)|公开主页.{0,20}(?:不一致|未回显)|搜索结果页|合法(?: URL|链接|BV|账号)|无效重定向|非.{0,12}域名|提交目标不一致|证据|短链.{0,12}大小写|无法唯一/.test(text);
}

function targetReviewStatus(target) {
  if (targetNeedsEvidence(target)) return { key: "manual", label: "需补证据" };
  return profileHealthReview(target?.accountStatus, target?.worksCoverage, target?.last_status || "pending", target?.latestWarnings, { stale: target?.last_status === "error" });
}

function localDateKey(value = new Date()) {
  return businessDateKey(value, businessTimeZone());
}

function completedDailyRuns() {
  const batch = automaticRun("latestBatch");
  const completed = activeRecentRuns().filter((run) =>
    run.trigger_type === "scheduled"
    && run.finished_at
    && ["success", "partial"].includes(run.status),
  );
  if (batch && !completed.some((run) => Number(run.id) === Number(batch.id))) completed.push(batch);
  if (!batch || !completed.length) return completed;
  const batchCount = Math.max(1, Number(batch.target_count) || 1);
  const batchRuns = completed.filter((run) => Number(run.id) === Number(batch.id) || Number(run.target_count) < batchCount);
  return (batchRuns.length ? batchRuns : completed).sort((left, right) => new Date(right.finished_at).getTime() - new Date(left.finished_at).getTime());
}

function automaticRun(name = "latest") {
  const raw = (state.boardAutomation?.automation || state.data?.automation)?.[name];
  if (!raw) return null;
  return activeRecentRuns().find((run) => Number(run.id) === Number(raw.id)) || raw;
}

function activeRecentRuns() {
  return state.boardAutomation?.recentRuns || state.data?.recentRuns || [];
}

function automaticRunCounts(run) {
  if (run && Number.isFinite(Number(run.scopeLimitedCount ?? run.scope_limited_count)) && Number.isFinite(Number(run.scopeRetryCount ?? run.scope_retry_count))) {
    return { limited: Number(run.scopeLimitedCount ?? run.scope_limited_count), retry: Number(run.scopeRetryCount ?? run.scope_retry_count) };
  }
  const details = run?.details || [];
  return {
    limited: details.filter((item) => reviewStatus(item.status, item.warnings).key === "limited").length,
    retry: details.filter((item) => reviewStatus(item.status, item.warnings).key === "retry").length,
  };
}

function automaticRunKind(run) {
  const batch = automaticRun("latestBatch");
  return run && batch && Number(run.id) === Number(batch.id) && run.scopeComplete !== false
    ? "自动整批"
    : "局部自动补采";
}

function dailyRunOptionLabel(run, batchRun = automaticRun("latestBatch")) {
  const kind = batchRun && Number(run.id) === Number(batchRun.id) ? "整批" : "补采";
  const { limited, retry } = automaticRunCounts(run);
  const success = Number(run.success_count) || 0;
  const target = Number(run.target_count) || 0;
  const attention = limited || retry ? ` · ${limited} 范围 / ${retry} 待关注` : "";
  return `${formatDate(run.finished_at, { year: "numeric", second: "2-digit" })} · ${kind} · ${success}/${target} 成功${attention}`;
}

function syncDailyReportState() {
  const runs = completedDailyRuns();
  const latestReference = runs[0]?.finished_at || null;
  if (!state.dailyReportPinned || !runs.some((run) => run.finished_at === state.dailyReportReference)) {
    state.dailyReportReference = latestReference;
    state.dailyReportPinned = false;
  }
  if (latestReference && state.data?.reports?.latestCompletedDay) {
    state.dailyReportCache[latestReference] = state.data.reports.latestCompletedDay;
  }
}

function baseSelectedReport() {
  if (state.period !== "day") return state.data.reports[state.period];
  if (!state.dailyReportReference) return state.data.reports.day;
  return state.dailyReportCache[state.dailyReportReference]
    || state.data.reports.latestCompletedDay
    || state.data.reports.day;
}

function boardCatalog() {
  return createBoardCatalog(state.data?.boards || [], state.data?.targets || []);
}

function reportCacheKey(period, reference = "", selection = state.boardSelection) {
  return `${selection}:${period}:${reference || "current"}`;
}

function scopedReport(report, period, reference = "") {
  if (state.boardSelection === BOARD_ALL) return report;
  const completeReport = state.boardReportCache[reportCacheKey(period, reference)];
  if (completeReport) return completeReport;
  return scopeReportToBoard(completeReport || report, state.data.targets, boardCatalog(), state.boardSelection, {
    complete: Boolean(completeReport),
    viralLikeThreshold: state.data.settings?.viralLikeThreshold,
    viralRelativeMultiplier: state.data.settings?.viralRelativeMultiplier,
  });
}

function selectedReport() {
  return scopedReport(baseSelectedReport(), state.period, state.period === "day" ? state.dailyReportReference : "");
}

function overviewReport() {
  return scopedReport(state.data.reports.day, "day", "");
}

function persistBoardSelection() {
  const url = new URL(location.href);
  if (state.boardSelection === BOARD_ALL) url.searchParams.delete("board");
  else url.searchParams.set("board", state.boardSelection);
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function adoptPreferredBoardAfterLoad() {
  let hasExplicitBoard = false;
  try { hasExplicitBoard = new URL(location.href).searchParams.has("board"); } catch {}
  if (hasExplicitBoard || state.boardSelection !== BOARD_ALL) return false;
  const preferred = boardCatalog().find((board) => board.label === "抖音主播板块");
  if (!preferred) return false;
  state.boardSelection = preferred.key;
  persistBoardSelection();
  return true;
}

async function ensureBoardReport(period, reference = "") {
  if (state.boardSelection === BOARD_ALL) return;
  const key = reportCacheKey(period, reference);
  if (state.boardReportCache[key] || state.boardReportLoading.has(key)) return;
  state.boardReportLoading.add(key);
  try {
    const parameters = new URLSearchParams();
    if (period === "day" && reference) parameters.set("date", reference);
    parameters.set("board", state.boardSelection);
    state.boardReportCache[key] = await api(`/api/reports/${period}?${parameters}`);
  } catch (error) {
    toast(`板块数据读取失败：${error.message}`, "error");
  } finally {
    state.boardReportLoading.delete(key);
    if (state.data) render();
  }
}

function hydrateBoardReports() {
  if (state.boardSelection === BOARD_ALL) return;
  ensureBoardReport("day", "");
  if (state.period !== "day" || state.dailyReportReference) ensureBoardReport(state.period, state.period === "day" ? state.dailyReportReference : "");
}

function dailyCollectionState() {
  const scheduler = state.data?.scheduler || {};
  const live = scheduler.currentRun;
  if (live?.triggerType === "scheduled") return { key: "running", label: "今日自动采集中", live };
  const today = localDateKey();
  const todayRuns = activeRecentRuns().filter((run) => run.trigger_type === "scheduled" && localDateKey(run.started_at) === today);
  if (todayRuns.some((run) => run.finished_at && ["success", "partial"].includes(run.status))) return { key: "complete", label: "今日采集完成" };
  if (todayRuns.some((run) => ["error", "interrupted"].includes(run.status))) return { key: "retry", label: "今日任务自动补采中" };
  return { key: "pending", label: `等待 ${scheduler.scheduleTime || "10:00"}（或主机唤醒后）自动采集` };
}

function providerLabel(provider) {
  return ({ "public-web": "公开网页", manual: "手动导入" })[provider] || provider;
}

function platformLabel(platform) {
  return ({ douyin: "抖音", bilibili: "B站", xiaohongshu: "小红书" })[platform] || "抖音";
}

function platformForTarget(target) {
  if (target?.type === "hashtag") return "douyin";
  const explicit = String(target?.metadata?.platform ?? "").trim().toLowerCase();
  if (["douyin", "bilibili", "xiaohongshu"].includes(explicit)) return explicit;
  const locator = String(target?.locator ?? "").toLowerCase();
  if (locator.includes("bilibili.com") || locator.includes("b23.tv")) return "bilibili";
  if (locator.includes("xiaohongshu.com") || locator.includes("xhslink.com")) return "xiaohongshu";
  return "douyin";
}

function sourceProbeForPlatform(platform) {
  const probes = Array.isArray(state.data?.publicProbes) ? state.data.publicProbes : [];
  return probes.find((probe) => probe.provider === `${platform}-public`)
    || (platform === "douyin" ? state.data?.publicProbe : null)
    || null;
}

function sourceProbeStatusText(probe, platform) {
  if (!probe) return `${platformLabel(platform)}未执行`;
  const checkedAt = probe.checkedAt ? new Date(probe.checkedAt) : null;
  const age = checkedAt && Number.isFinite(checkedAt.getTime()) ? Date.now() - checkedAt.getTime() : null;
  const trigger = probe.trigger === "scheduled" ? "自动" : probe.trigger === "manual" ? "手动" : "历史";
  const status = !probe.ok ? "未通过" : probe.result?.postsEndpoint === false ? "主页通过 / 作品受限" : age !== null && age > 36 * 60 * 60 * 1000 ? "已过期" : "通过";
  const duration = Number.isFinite(Number(probe.durationMs)) && Number(probe.durationMs) >= 0
    ? ` · ${Number(probe.durationMs) >= 1000 ? `${(Number(probe.durationMs) / 1000).toFixed(1)}s` : `${Math.round(Number(probe.durationMs))}ms`}`
    : "";
  return `${platformLabel(platform)}${status} · ${trigger} · ${formatDate(probe.checkedAt)}${duration}`;
}

function renderSourceProbeHistory() {
  const element = $("#sourceProbeHistory");
  const summary = $("#sourceProbeHistorySummary");
  if (!element) return;
  const history = Array.isArray(state.data?.sourceProbeHistory) ? state.data.sourceProbeHistory.slice(0, 24) : [];
  if (!history.length) {
    if (summary) summary.textContent = "尚未执行";
    element.innerHTML = '<span class="source-probe-empty">尚未形成来源探针历史。</span>';
    return;
  }
  const labels = { douyin: "抖音", bilibili: "B站", xiaohongshu: "小红书" };
  const latest = history[0];
  const latestProvider = String(latest.provider ?? "");
  const latestPlatform = latestProvider.replace(/-public$/, "");
  const latestLabel = labels[latestPlatform] || latestProvider || "未知来源";
  const latestCheckedAt = latest.checkedAt ? new Date(latest.checkedAt) : null;
  const latestAge = latestCheckedAt && Number.isFinite(latestCheckedAt.getTime()) ? Date.now() - latestCheckedAt.getTime() : null;
  const latestStatus = !latest.ok ? "未通过" : latest.result?.postsEndpoint === false ? "主页通过 / 作品受限" : latestAge !== null && latestAge > 36 * 60 * 60 * 1000 ? "已过期" : "通过";
  const latestTrigger = latest.trigger === "scheduled" ? "自动" : latest.trigger === "manual" ? "手动" : "历史";
  const latestDuration = Number.isFinite(Number(latest.durationMs)) && Number(latest.durationMs) >= 0
    ? ` · ${Number(latest.durationMs) >= 1000 ? `${(Number(latest.durationMs) / 1000).toFixed(1)}s` : `${Math.round(Number(latest.durationMs))}ms`}`
    : "";
  if (summary) {
    summary.textContent = `最近：${latestLabel}${latestStatus} · ${latestTrigger} · ${formatDate(latest.checkedAt)}${latestDuration}`;
    summary.classList.toggle("error", latestStatus !== "通过");
  }
  element.innerHTML = history.map((probe) => {
    const provider = String(probe.provider ?? "");
    const platform = provider.replace(/-public$/, "");
    const label = labels[platform] || provider || "未知来源";
    const status = probe.ok ? "通过" : "未通过";
    const stateKey = probe.ok ? "ok" : "error";
    const trigger = probe.trigger === "scheduled" ? "自动" : probe.trigger === "manual" ? "手动" : "历史";
    const duration = Number.isFinite(Number(probe.durationMs)) && Number(probe.durationMs) >= 0
      ? `${Number(probe.durationMs) >= 1000 ? `${(Number(probe.durationMs) / 1000).toFixed(1)}s` : `${Math.round(Number(probe.durationMs))}ms`}`
      : "耗时未记录";
    const detail = probe.ok ? duration : String(probe.error || "未返回具体原因").slice(0, 120);
    return `<div class="source-probe-history-row"><span class="source-probe-history-state ${stateKey}">${escapeHtml(label)} · ${status}</span><span>${escapeHtml(trigger)} · ${escapeHtml(formatDate(probe.checkedAt))}</span><small>${escapeHtml(detail)}</small></div>`;
  }).join("");
}

function roleLabel(role) {
  return ({ admin: "管理员", editor: "编辑者", viewer: "查看者" })[role] || role;
}

function setAuthenticated(auth) {
  state.auth = auth;
  document.body.classList.remove("auth-pending", "auth-required");
  document.body.classList.add("auth-ready");
  $("#currentUserName").textContent = auth.user.displayName;
  $("#currentUserRole").textContent = roleLabel(auth.user.role);
  $("#userAvatar").textContent = auth.user.displayName.slice(0, 1);
  $$('[data-min-role="editor"]').forEach((element) => element.classList.toggle("hidden", !auth.permissions.edit));
  $$('[data-min-role="admin"]').forEach((element) => element.classList.toggle("hidden", !auth.permissions.administer));
}

function showAuthRequired(message = "请输入管理员提供的邀请码") {
  state.auth = null;
  document.body.classList.remove("auth-pending", "auth-ready");
  document.body.classList.add("auth-required");
  $("#joinStatus").textContent = message;
}

function renderBoardControls() {
  const catalog = boardCatalog();
  const targets = (state.data.targets || []).filter((target) => target.enabled !== false && Number(target.enabled) !== 0);
  const validSelection = normalizeBoardSelection(state.boardSelection, catalog);
  if (validSelection !== state.boardSelection) {
    state.boardSelection = validSelection;
    persistBoardSelection();
  }
  const counts = boardCounts(targets, catalog);
  const options = [
    [BOARD_ALL, "全部板块", targets.length],
    ...catalog.map((board) => [board.key, board.label, counts.get(board.key) || 0]),
    ...((counts.get(BOARD_UNASSIGNED) || state.boardSelection === BOARD_UNASSIGNED) ? [[BOARD_UNASSIGNED, "未分板块", counts.get(BOARD_UNASSIGNED) || 0]] : []),
  ];
  const selected = options.find(([key]) => key === state.boardSelection) || options[0];
  const optionHtml = options.map(([key, label, count]) => `<option value="${escapeHtml(key)}" ${key === state.boardSelection ? "selected" : ""}>${escapeHtml(label)} · ${formatExactNumber(count)}</option>`).join("");
  $$('[data-board-select]').forEach((control) => { control.innerHTML = optionHtml; control.value = state.boardSelection; });
  const choiceHtml = options.map(([key, label, count]) => {
    const queued = catalog.find((board) => board.key === key)?.queuedCount || 0;
    const note = queued ? `${formatExactNumber(queued)} 条证据未确认` : count === 0 && ![BOARD_ALL, BOARD_UNASSIGNED].includes(key) ? "暂无启用作者" : "";
    return `<button type="button" class="board-choice${key === state.boardSelection ? " active" : ""}" data-board-choice="${escapeHtml(key)}" aria-pressed="${key === state.boardSelection}"><span>${escapeHtml(label)}</span><b>${formatExactNumber(count)}</b>${note ? `<small>${note}</small>` : ""}</button>`;
  }).join("");
  $$('[data-board-choices]').forEach((element) => { element.innerHTML = choiceHtml; });
  $$('[data-board-current]').forEach((element) => { element.textContent = selected[1]; });
  const allMembers = filterTargetsByBoard(state.data.targets || [], state.boardSelection, catalog).length;
  const queuedCount = catalog.find((board) => board.key === state.boardSelection)?.queuedCount || 0;
  const emptyBoard = ![BOARD_ALL, BOARD_UNASSIGNED].includes(state.boardSelection) && allMembers === 0 && queuedCount === 0;
  $$('[data-board-summary]').forEach((element) => {
    element.textContent = emptyBoard ? "板块已创建 · 暂无作者，导入名单后显示对应数据" : `${formatExactNumber(selected[2])} 个启用监控账号${allMembers > selected[2] ? ` · ${formatExactNumber(allMembers - selected[2])} 个暂停账号` : ""}${queuedCount ? ` · ${formatExactNumber(queuedCount)} 条证据未确认` : ""} · 切换不影响后台采集`;
  });
  $$('[data-board-empty]').forEach((element) => { element.classList.toggle("hidden", !emptyBoard && !queuedCount); });
  $$('[data-board-empty-copy]').forEach((element) => { element.textContent = queuedCount ? `${formatExactNumber(queuedCount)} 条证据未确认（待核对或未通过）。按作品证据逐条统计，不等于未监控作者人数；同一作者可有多条记录。已启用监控账号数以上方统计为准。` : "这个板块暂无作者，可导入名单；不会显示其他板块的数据。"; });
  $$('[data-board-queue]').forEach((element) => { element.classList.toggle("hidden", !queuedCount); });
  renderAuthorBoardChoices();
}

function renderAuthorBoardChoices() {
  const control = $("#authorDefaultBoard");
  if (!control) return;
  const catalog = createBoardCatalog([...(state.data?.boards || []), ...(state.authorPreview?.boardCatalog || [])], state.data?.targets || []);
  if (state.authorDefaultBoard && !catalog.some((board) => board.key === state.authorDefaultBoard)) state.authorDefaultBoard = "";
  control.innerHTML = '<option value="">使用表格内板块；空白保持未分板块</option>' + catalog.map((board) => `<option value="${escapeHtml(board.key)}">${escapeHtml(board.label)}</option>`).join("");
  control.value = state.authorDefaultBoard;
  const label = catalog.find((board) => board.key === state.authorDefaultBoard)?.label;
  $("#authorDefaultBoardNote").textContent = label ? `仅把表格中未填写板块的行归入“${label}”；已有板块不覆盖。提交前请核对下方预览。` : "表格已有板块会保留；没有填写的作者保持未分板块，不按昵称猜测。";
}

function authorDefaultBoardName() {
  const catalog = createBoardCatalog([...(state.data?.boards || []), ...(state.authorPreview?.boardCatalog || [])], state.data?.targets || []);
  return catalog.find((board) => board.key === state.authorDefaultBoard)?.label || "";
}

async function selectBoard(value) {
  state.boardSelection = normalizeBoardSelection(value, boardCatalog());
  state.targetPage = 0;
  state.boardAutomation = null;
  persistBoardSelection();
  render();
  hydrateBoardReports();
  await refreshBoardAutomation({ quiet: true, skip: typeof location !== "undefined" && location.hash === "#topics" });
  syncDailyReportState();
  render();
}

function renderMetrics() {
  const report = overviewReport();
  const summary = report.summary;
  const collection = dailyCollectionState();
  const ready = collection.key === "complete";
  const boardReady = !summary.boardScoped || summary.boardDataComplete;
  const waitingValue = collection.key === "running" ? "…" : "—";
  $("#metricTargets").textContent = formatNumber(summary.targetCount);
  $("#metricPosts").textContent = ready && boardReady ? formatNumber(summary.postCount) : waitingValue;
  $("#metricPostsNote").textContent = ready && boardReady ? (summary.postCount ? `${summary.activeTargetCount} 个目标有发布` : "今日采集完成 · 0 条发布") : ready ? "正在读取板块作品证据" : collection.label;
  $("#metricFollowersDelta").textContent = ready ? formatSignedNumber(summary.followersDelta) : waitingValue;
  $("#metricAccountLikesDelta").textContent = ready ? formatSignedNumber(summary.accountLikesDelta) : waitingValue;
  $("#metricEstimatedPlays").textContent = ready ? formatSignedNumber(summary.estimatedPlaysDelta) : waitingValue;
  const targetCount = Number(summary.targetCount || 0);
  const profileKnown = summary.profileObservedTargetCount !== null && summary.profileObservedTargetCount !== undefined;
  const profileObserved = profileKnown ? Number(summary.profileObservedTargetCount) : null;
  $("#metricQuality").textContent = targetCount && profileKnown ? `${Math.round((profileObserved / targetCount) * 100)}%` : "—";
  $(".metric-quality small").textContent = profileKnown ? `${profileObserved}/${targetCount} 个对象已有主页快照 · 新鲜度见信息源审查` : "正在读取板块主页证据";
  const growthNotes = $$(".metric-growth small");
  growthNotes[0].textContent = ready
    ? (summary.followersComparableTargetCount ? `${summary.followersComparableTargetCount}/${summary.growthCurrentTargetCount} 个账号可比` : "暂无两份可比粉丝快照")
    : collection.label;
  growthNotes[1].textContent = ready
    ? (summary.likesComparableTargetCount ? `${summary.likesComparableTargetCount}/${summary.growthCurrentTargetCount} 个账号可比` : "暂无两份可比主页获赞快照")
    : collection.label;
  growthNotes[2].textContent = ready ? "新增点赞 × 100" : collection.label;
}

function renderInsights() {
  const summary = overviewReport().summary;
  const collection = dailyCollectionState();
  const queue = state.data.authorResolutionQueue || {};
  const targetCount = Number(summary.targetCount || 0);
  const profileKnown = summary.profileObservedTargetCount !== null && summary.profileObservedTargetCount !== undefined;
  const profileObserved = profileKnown ? Number(summary.profileObservedTargetCount) : null;
  const profileRate = targetCount && profileKnown ? Math.round((profileObserved / targetCount) * 100) : null;
  const complete = Number(summary.validatedTargetCount || 0);
  const limited = Number(summary.limitedTargetCount || 0);
  const retry = Number(summary.retryTargetCount || 0);
  const unknown = Number(summary.unknownTargetCount || 0);
  const pendingAuthors = Number(queue.pending || 0);
  const resolvedAuthors = Number(queue.resolved || 0);
  const rejectedAuthors = Number(queue.rejected || 0);
  const likesObserved = finiteNumberOrNull(summary.likesObservedPostCount);
  const likesMissing = finiteNumberOrNull(summary.likesMissingPostCount);
  const insights = [];

  insights.push({
    tone: profileRate === null ? "working" : profileRate === 100 && retry === 0 ? "good" : "warning",
    value: profileRate === null ? "—" : `${profileRate}%`,
    title: profileRate === null ? "正在读取板块主页证据" : "主页观测覆盖",
    body: profileRate === null ? "完整板块证据回读前保持空缺，不把缺失显示为 0。" : `${profileObserved}/${targetCount} 个主页已有粉丝或累计获赞；作品采集为 ${complete} 完整、${limited} 范围说明、${retry} 自动重试${unknown ? `、${unknown} 未判定` : ""}。`,
  });

  if (collection.key !== "complete") {
    const live = collection.live;
    insights.push({
      tone: collection.key === "running" ? "working" : collection.key === "retry" ? "warning" : "neutral",
      value: collection.key === "running" ? `${live.completedCount}/${live.targetCount}` : state.data.scheduler.scheduleTime,
      title: collection.label,
      body: collection.key === "running" ? "今日指标会在整批采集结束后统一出数，处理中不会把缺失显示成 0。" : "今日发布、涨粉和新增点赞尚未形成完整样本，当前显示“—”而不是 0。",
    });
  } else if (!summary.followersComparableTargetCount && !summary.likesComparableTargetCount) {
    insights.push({ tone: "neutral", value: "—", title: "今日暂无可比增长", body: "今日采集已完成，但还没有同时具备前后两份主页快照的账号；系统不会把缺失记成 0。" });
  } else {
    insights.push({
      tone: Number(summary.followersDelta || 0) >= 0 ? "good" : "warning",
      value: formatSignedNumber(summary.followersDelta),
      title: `${summary.followersComparableTargetCount} 个账号可计算涨粉`,
      body: `另有 ${summary.likesComparableTargetCount} 个账号可计算主页新增点赞；两项覆盖分开统计，不混用分母。`,
    });
  }

  if (state.boardSelection !== BOARD_ALL) {
    const currentBoard = boardCatalog().find((board) => board.key === state.boardSelection)?.label || "未分板块";
    insights.push({ tone: "working", value: formatNumber(targetCount), title: `当前只看：${currentBoard}`, body: "本页作者、增长指标和作品样本均按此板块计算；全局核验队列未混入当前解读。" });
  } else if (pendingAuthors) {
    insights.push({ tone: "working", value: formatNumber(pendingAuthors), title: "身份核验证据处理中", body: `已通过 ${formatNumber(resolvedAuthors)} 条；其余待处理证据会继续在后台核验。同一作者可有多条记录，记录数不是监控作者数。` });
  } else if (rejectedAuthors) {
    insights.push({ tone: "warning", value: formatNumber(rejectedAuthors), title: "部分身份核验证据未通过", body: "这些证据不足、身份不一致或已达到重试上限，具体原因见核验明细；记录数不等于未监控作者人数，系统不会猜测匹配。" });
  } else {
    insights.push({ tone: "good", value: formatNumber(resolvedAuthors), title: "身份核验记录已处理", body: "当前没有等待后台处理的证据；核验记录数不是监控作者数。" });
  }

  if (summary.boardScoped && !summary.boardDataComplete) {
    insights.push({ tone: "working", value: "—", title: "正在读取板块作品证据", body: "作者增长已按板块切换；作品明细回读完成前保持空缺，不会误显示为 0。" });
  } else if (collection.key === "complete" && summary.postCount) {
    const viralEvidence = likesObserved === 0
      ? "今日作品尚无点赞证据，暂时无法判断是否达到爆款阈值。"
      : `${formatNumber(summary.viralCount)} 条已知点赞作品达到 ${formatNumber(summary.viralThreshold)} 赞的动态爆款阈值${likesMissing ? `；另有 ${formatNumber(likesMissing)} 条缺少点赞，无法判断` : ""}。`;
    insights.push({ tone: summary.viralCount ? "good" : "neutral", value: formatNumber(summary.postCount), title: `今日有 ${formatNumber(summary.authorCount)} 位作者发布`, body: viralEvidence });
  } else if (collection.key === "complete") {
    insights.push({ tone: "neutral", value: "0", title: "今日采集确认暂无新增发布", body: "这是今日整批采集完成后的样本结果，不代表平台全网没有发布。" });
  }

  $("#decisionPanel").innerHTML = insights.map((item) => `
    <article class="decision-item ${item.tone}">
      <strong>${escapeHtml(item.value)}</strong>
      <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p></div>
    </article>`).join("");
}

function renderSourceRail() {
  const catalog = boardCatalog();
  const scopedTargets = filterTargetsByBoard(state.data?.targets || [], state.boardSelection, catalog);
  const enabledTargets = scopedTargets.filter((target) => target.enabled !== false && Number(target.enabled) !== 0);
  const accountTargets = enabledTargets.filter((target) => target.type === "account");
  const profileObserved = accountTargets.filter((target) => ["available", "partial"].includes(String(target.accountStatus ?? ""))).length;
  const staleProfile = accountTargets.filter((target) => target.last_status === "error" && ["available", "partial"].includes(String(target.accountStatus ?? ""))).length;
  const canonicalIds = accountTargets.filter((target) => /^MS4wLj/.test(String(target.locator || ""))).length;
  const works = { complete: 0, limited: 0, retry: 0, unavailable: 0, unknown: 0 };
  for (const target of accountTargets) {
    const coverage = String(target.worksCoverage || "");
    if (coverage === "latest-public-window") works.limited += 1;
    else if (Object.hasOwn(works, coverage)) works[coverage] += 1;
    else if (coverage === "unknown") works.unknown += 1;
    else works.complete += 1;
  }
  const publicCount = enabledTargets.filter((target) => target.provider === "public-web").length;
  const manualCount = enabledTargets.filter((target) => target.provider === "manual").length;
  const scheduler = state.data?.scheduler || {};
  const collection = dailyCollectionState();
  const boardLabel = state.boardSelection === BOARD_ALL
    ? "全部板块"
    : catalog.find((board) => board.key === state.boardSelection)?.label || "当前板块";
  const targetCount = enabledTargets.length;
  const retryCount = works.retry + works.unavailable;
  const issueCount = accountTargets.filter((target) => target.last_status === "error" || ["retry", "unavailable", "unknown"].includes(String(target.worksCoverage || ""))).length;
  const runText = collection.key === "running"
    ? "正在自动采集"
    : issueCount
      ? `${issueCount} 个对象需关注`
      : collection.key === "complete" ? "本日采集已完成" : "等待自动采集";
  const statusClass = collection.key === "running" ? "running" : issueCount ? "warning" : "ready";
  const scopeText = `${boardLabel} · ${targetCount} 个启用对象${state.boardSelection === BOARD_ALL ? "" : "（仅改变查看范围）"}`;
  const identityText = accountTargets.length
    ? `${canonicalIds}/${accountTargets.length} 个账号使用稳定 sec_uid 主键`
    : "尚未形成账号身份证据";
  const providerText = publicCount
    ? `匿名 HTTP 直连 ${publicCount} · 不打开浏览器页面 · 无密钥、无个人登录${manualCount ? `；手动 ${manualCount}` : ""}`
    : manualCount ? `手动导入 ${manualCount} · 不参与定时采集` : "尚未配置公开采集源";
  const evidenceText = `${profileObserved}/${accountTargets.length || targetCount} 个主页证据可用${staleProfile ? `（${staleProfile} 沿用历史）` : ""} · 作品 ${works.complete} 完整 / ${works.limited} 范围 / ${retryCount} 待补采${works.unknown ? ` / ${works.unknown} 未判定` : ""}`;
  const activePlatforms = [...new Set(accountTargets.filter((target) => target.provider === "public-web").map(platformForTarget))];
  const relevantProbeText = activePlatforms.length
    ? activePlatforms.map((platform) => sourceProbeStatusText(sourceProbeForPlatform(platform), platform)).join(" · ")
    : "尚未配置公开采集源";
  const probeText = relevantProbeText;
  const freshnessCounts = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  let latestTargetAt = null;
  let oldestTargetAt = null;
  for (const target of accountTargets) {
    // A failed attempt updates last_checked_at, but does not refresh the
    // stored public snapshot. Freshness must follow the persisted snapshot,
    // otherwise a carried historical value would look newly collected.
    const checkedAt = target.latestSnapshotAt || (target.last_status === "error" ? null : target.last_checked_at || null);
    const checkedDate = checkedAt ? new Date(checkedAt) : null;
    const checkedTime = checkedDate && Number.isFinite(checkedDate.getTime()) ? checkedDate.getTime() : null;
    if (checkedTime === null) {
      freshnessCounts.unknown += 1;
      continue;
    }
    if (!latestTargetAt || checkedTime > new Date(latestTargetAt).getTime()) latestTargetAt = checkedAt;
    if (!oldestTargetAt || checkedTime < new Date(oldestTargetAt).getTime()) oldestTargetAt = checkedAt;
    const age = Date.now() - checkedTime;
    if (age <= 36 * 60 * 60 * 1000) freshnessCounts.fresh += 1;
    else if (age <= 72 * 60 * 60 * 1000) freshnessCounts.aging += 1;
    else freshnessCounts.stale += 1;
  }
  const freshnessState = collection.key === "running"
    ? "running"
    : freshnessCounts.stale
      ? "stale"
      : freshnessCounts.unknown
        ? "unknown"
        : freshnessCounts.aging
          ? "aging"
          : freshnessCounts.fresh
            ? "fresh"
            : "unknown";
  const freshnessLabel = freshnessState === "fresh" ? "新鲜" : freshnessState === "aging" ? "偏旧" : freshnessState === "stale" ? "过期" : freshnessState === "unknown" ? "待补齐" : "新鲜度";
  const freshnessBreakdown = [
    freshnessCounts.fresh ? `新鲜 ${freshnessCounts.fresh}` : "",
    freshnessCounts.aging ? `偏旧 ${freshnessCounts.aging}` : "",
    freshnessCounts.stale ? `过期 ${freshnessCounts.stale}` : "",
    freshnessCounts.unknown ? `待补齐 ${freshnessCounts.unknown}` : "",
  ].filter(Boolean).join(" · ");
  const freshnessText = collection.key === "running"
    ? "数据新鲜度：本次批次采集中"
    : latestTargetAt
      ? `数据${freshnessLabel} · 截至 ${formatDate(latestTargetAt)}${freshnessBreakdown ? ` · ${freshnessBreakdown}` : ""}${oldestTargetAt && freshnessCounts.stale + freshnessCounts.aging ? ` · 最旧 ${formatDate(oldestTargetAt)}` : ""}${staleProfile ? ` · ${staleProfile} 个对象沿用历史` : ""}`
      : "数据新鲜度：尚未形成主页快照";
  const note = issueCount
    ? `${staleProfile ? `${staleProfile} 个对象本次未更新主页，` : ""}主页累计指标与作品覆盖分开统计；问题对象保留有效快照，并由后续自动任务重试。数据统计来自本地快照，不依赖打开网页。`
    : state.boardSelection === BOARD_ALL
      ? "页面只读本地快照；公开作品窗口会持续累积，不会被当成完整历史。每日采集走匿名 HTTP 直连，不拉起浏览器页面。"
      : `当前只解读“${boardLabel}”；切换板块不会改变后台每日采集范围。每日采集走匿名 HTTP 直连，不拉起浏览器页面。`;
  const scheduleStateText = scheduler.scheduleState
    ? scheduleStateLabel(scheduler.scheduleState, scheduler.scheduleTime, { next: scheduler.scheduleState === "running" })
    : collection.key === "running"
      ? `本次自动批次正在执行 · 下一次 ${scheduler.scheduleTime || "10:00"}`
      : collection.key === "complete"
        ? `今日自动批次已完成 · 下一次 ${scheduler.scheduleTime || "10:00"}`
        : `每天 ${scheduler.scheduleTime || "10:00"} 自动启动 · 主机可用时执行`;
  const inputText = `${boardLabel}读取 ${targetCount} 个启用对象 · ${canonicalIds}/${accountTargets.length || targetCount} 个稳定身份`;
  const requestText = publicCount
    ? `${publicCount} 个公开源匿名直连 · 不打开网页`
    : "尚未配置公开源 · 不执行猜测采集";
  const snapshotText = `${profileObserved}/${accountTargets.length || targetCount} 个主页快照可用${staleProfile ? ` · ${staleProfile} 个沿用历史` : ""}`;
  const deltaText = "只用两次可比快照 · 缺失不补 0 · 新增赞 × 100 为估算播放";
  $("#sourceRailStatus").className = `source-rail-status ${statusClass}`;
  $("#sourceRailStatus").textContent = `${runText} · 下一次 ${scheduler.scheduleTime || "10:00"}`;
  $("#sourceRailScope").textContent = scopeText;
  $("#sourceRailIdentity").textContent = identityText;
  $("#sourceRailProvider").textContent = providerText;
  $("#sourceRailEvidence").textContent = evidenceText;
  $("#sourceRailNote").textContent = note;
  $("#sourceRailProbe").textContent = probeText;
  const relevantProbes = activePlatforms.map(sourceProbeForPlatform).filter(Boolean);
  const anyProbeFailed = relevantProbes.some((item) => !item.ok);
  const anyProbeStale = relevantProbes.some((item) => item.ok && item.checkedAt && Date.now() - new Date(item.checkedAt).getTime() > 36 * 60 * 60 * 1000);
  $("#sourceRailProbe").dataset.state = !relevantProbes.length ? "idle" : anyProbeFailed ? "error" : anyProbeStale ? "warning" : "success";
  $("#sourceRailFreshness").textContent = freshnessText;
  $("#sourceRailFreshness").dataset.state = freshnessState;
  $("#sourceRailFreshness").title = "新鲜：最近 36 小时；偏旧：36–72 小时；过期：超过 72 小时。统计当前板块全部启用账号。";
  $("#sourceRailSchedule").textContent = scheduleStateText;
  $("#sourceRailInput").textContent = inputText;
  $("#sourceRailRequest").textContent = requestText;
  $("#sourceRailSnapshot").textContent = snapshotText;
  $("#sourceRailDelta").textContent = deltaText;
}

function renderPulse() {
  const boardReport = state.boardSelection === BOARD_ALL ? null : state.boardReportCache[reportCacheKey("day", "")];
  const sourcePosts = boardReport ? scopeReportToBoard(boardReport, state.data.targets, boardCatalog(), state.boardSelection, { complete: true, viralLikeThreshold: state.data.settings?.viralLikeThreshold }).posts : state.boardSelection === BOARD_ALL ? state.data.recentPosts : [];
  const datedPosts = sourcePosts.filter((post) => post.published_at).sort((left, right) => new Date(right.published_at) - new Date(left.published_at));
  const likesKnown = datedPosts.filter((post) => post.likes !== null && post.likes !== undefined && post.likes !== "" && Number.isFinite(Number(post.likes)));
  const posts = likesKnown.slice(0, 20).reverse();
  const canvas = $("#pulseCanvas");
  $("#pulseSampleCount").textContent = `${likesKnown.length}/${datedPosts.length} 条点赞可用`;
  if (!posts.length) {
    canvas.innerHTML = state.boardSelection !== BOARD_ALL && !boardReport
      ? '<div class="empty-inline">正在读取这个板块的作品样本；读取完成前不把缺失显示为 0。</div>'
      : datedPosts.length
        ? '<div class="empty-inline">当前作品尚无可核验点赞数据；缺失值保持为空，不绘制成 0 点赞柱。</div>'
        : '<div class="empty-inline">当前查看范围内暂无已采集作品样本。</div>';
    return;
  }
  const width = 1200;
  const height = 190;
  const pad = { left: 22, right: 22, top: 18, bottom: 34 };
  const maxLikes = Math.max(...posts.map((post) => Number(post.likes)), 1);
  const band = (width - pad.left - pad.right) / Math.max(posts.length, 1);
  const bars = posts.map((post, index) => {
    const barHeight = Math.max(3, Math.log1p(Number(post.likes)) / Math.log1p(maxLikes) * (height - pad.top - pad.bottom));
    const x = pad.left + index * band + band * .2;
    const y = height - pad.bottom - barHeight;
    return { x, y, width: Math.max(3, band * .6), height: barHeight, post, index };
  });
  const grid = [0, 1, 2, 3].map((index) => { const y = pad.top + index * ((height - pad.top - pad.bottom) / 3); return `<line class="pulse-grid" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"/>`; }).join("");
  const columns = bars.map((bar) => `<rect class="pulse-bar" x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" rx="3"><title>${escapeHtml(bar.post.author_name || bar.post.target_label)} · ${formatNumber(bar.post.likes)}赞 · ${formatDate(bar.post.published_at)}</title></rect>`).join("");
  const labels = bars.filter((bar) => bar.index === 0 || bar.index === bars.length - 1 || bar.index % Math.max(1, Math.floor(bars.length / 5)) === 0).map((bar) => `<text class="pulse-label" x="${bar.x + bar.width / 2}" y="${height - 9}" text-anchor="middle">${escapeHtml(formatDate(bar.post.published_at).slice(0, 5))}</text>`).join("");
  canvas.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="近期作品点赞分布图">${grid}${columns}${labels}</svg>`;
}

function renderTargets() {
  const catalog = boardCatalog();
  const targets = filterTargetsByBoard(state.data.targets, state.boardSelection, catalog);
  const enabledTargetCount = targets.filter((target) => target.enabled !== false && Number(target.enabled) !== 0).length;
  const canEdit = Boolean(state.auth?.permissions?.edit);
  const canAdminister = Boolean(state.auth?.permissions?.administer);
  const query = state.targetQuery.trim().toLocaleLowerCase("zh-CN");
  const targetReviewKey = (target) => {
    // A stale-but-usable snapshot is still an automatic collection failure.
    // Keep it in the attention filter instead of letting the older works
    // coverage label downgrade the failed homepage attempt to “limited”.
    if (targetNeedsEvidence(target)) return "manual";
    if (target.last_status === "error") return "failed";
    const accountStatus = String(target.accountStatus ?? "");
    const worksCoverage = String(target.worksCoverage ?? "");
    if (["available", "partial"].includes(accountStatus)) {
      if (["limited", "latest-public-window"].includes(worksCoverage)) return "limited";
      if (["retry", "unavailable"].includes(worksCoverage)) return "retry";
      if (worksCoverage === "unknown") return "pending";
      return "complete";
    }
    return reviewStatus(target.last_status || "pending", target.latestWarnings).key;
  };
  const requiresAttention = (target) => ["failed", "manual", "pending"].includes(targetReviewKey(target));
  const targetPlatform = (target) => target.type === "hashtag" ? "douyin" : (target.metadata?.platform || "douyin");
  const counts = {
    all: targets.length,
    douyin: targets.filter((target) => targetPlatform(target) === "douyin").length,
    bilibili: targets.filter((target) => targetPlatform(target) === "bilibili").length,
    xiaohongshu: targets.filter((target) => targetPlatform(target) === "xiaohongshu").length,
    limited: targets.filter((target) => targetReviewKey(target) === "limited").length,
    retry: targets.filter((target) => targetReviewKey(target) === "retry").length,
    manual: targets.filter((target) => targetReviewKey(target) === "manual").length,
    attention: targets.filter(requiresAttention).length,
  };
  $("#targetTotalCount").textContent = enabledTargetCount === targets.length
    ? formatNumber(targets.length)
    : `${formatNumber(targets.length)}（${formatNumber(enabledTargetCount)} 启用）`;
  $("#filterCountAll").textContent = counts.all;
  $("#filterCountDouyin").textContent = counts.douyin;
  $("#filterCountBilibili").textContent = counts.bilibili;
  $("#filterCountXiaohongshu").textContent = counts.xiaohongshu;
  $("#filterCountLimited").textContent = counts.limited;
  $("#filterCountRetry").textContent = counts.retry;
  $("#filterCountManual").textContent = counts.manual;
  $("#filterCountAttention").textContent = counts.attention;
  $$(".target-filter").forEach((button) => {
    const active = button.dataset.targetFilter === state.targetFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  let visibleTargets = targets.filter((target) => {
    const matchesQuery = !query || [target.label, target.locator, target.metadata?.douyinId, target.metadata?.bilibiliId, target.metadata?.xiaohongshuId]
      .filter(Boolean).some((value) => String(value).toLocaleLowerCase("zh-CN").includes(query));
    if (!matchesQuery) return false;
    if (state.targetFilter === "attention") return requiresAttention(target);
    if (["limited", "retry", "manual"].includes(state.targetFilter)) return targetReviewKey(target) === state.targetFilter;
    if (state.targetFilter !== "all") return targetPlatform(target) === state.targetFilter;
    return true;
  });

  const checkedTime = (target) => target.last_checked_at ? new Date(target.last_checked_at).getTime() : 0;
  const attentionRank = { failed: 0, stale: 0, manual: 1, pending: 2, retry: 3, limited: 4, complete: 5 };
  visibleTargets.sort((left, right) => {
    if (state.targetSort === "recent") return checkedTime(right) - checkedTime(left);
    if (state.targetSort === "works") return Number(right.known_posts || 0) - Number(left.known_posts || 0) || checkedTime(right) - checkedTime(left);
    if (state.targetSort === "name") return String(left.label || "").localeCompare(String(right.label || ""), "zh-CN");
    const leftState = targetReviewStatus(left).key;
    const rightState = targetReviewStatus(right).key;
    return (attentionRank[leftState] ?? 6) - (attentionRank[rightState] ?? 6) || checkedTime(right) - checkedTime(left);
  });

  const pageCount = Math.max(1, Math.ceil(visibleTargets.length / state.targetPageSize));
  state.targetPage = Math.min(Math.max(0, state.targetPage), pageCount - 1);
  const start = state.targetPage * state.targetPageSize;
  const pageTargets = visibleTargets.slice(start, start + state.targetPageSize);
  const hasAnyTargets = state.data.targets.length > 0;
  $("#targetsEmpty").classList.toggle("visible", !hasAnyTargets);
  $("#targetNoResults").classList.toggle("visible", hasAnyTargets && visibleTargets.length === 0);
  const queuedCount = catalog.find((board) => board.key === state.boardSelection)?.queuedCount || 0;
  $("#targetNoResults").textContent = targets.length === 0 && state.boardSelection !== BOARD_ALL
    ? queuedCount ? `本板块尚无监控账号；另有 ${formatExactNumber(queuedCount)} 条证据未确认，可在上方查看该板块证据核验明细；记录数不等于作者人数。` : "这个板块暂无监控对象；可导入这个板块的名单，或切换查看其他板块。"
    : "当前筛选条件下没有对象。";
  $("#targetPager").classList.toggle("hidden", !hasAnyTargets || visibleTargets.length === 0);
  $("#targetPageInfo").textContent = visibleTargets.length ? `显示 ${start + 1}–${Math.min(start + state.targetPageSize, visibleTargets.length)} / 共 ${visibleTargets.length} 个对象` : "没有符合条件的对象";
  $("#targetPrev").disabled = state.targetPage === 0;
  $("#targetNext").disabled = state.targetPage >= pageCount - 1;
  $("#targetsBody").innerHTML = pageTargets.map((target, index) => `
    <tr>
      <td class="rank-cell">${String(start + index + 1).padStart(2, "0")}</td>
      <td data-label="作者"><div class="object-cell"><span class="object-avatar">${escapeHtml((target.label || "?").trim().slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(target.label)}</strong><small title="${escapeHtml(target.locator)}">${escapeHtml(target.locator)}</small></div></div></td>
      <td data-label="平台"><span class="type-pill">${target.type === "account" ? escapeHtml(platformLabel(target.metadata?.platform)) : "抖音话题"}</span><small>${escapeHtml(providerLabel(target.provider))}</small></td>
      <td data-label="所属板块"><div class="board-chip-list">${targetBoardLabels(target, catalog).map((label) => `<span class="board-chip ${label === "未分板块" ? "unassigned" : ""}">${escapeHtml(label)}</span>`).join("")}</div></td>
      <td data-label="已收录作品">${formatNumber(target.known_posts)}</td>
      <td data-label="最近证据"><div>${escapeHtml(formatDate(target.latestSnapshotAt || (target.last_status === "error" ? null : target.last_checked_at)))}</div>${target.last_status === "error" && target.last_checked_at ? `<small>最后尝试 ${escapeHtml(formatDate(target.last_checked_at))}</small>` : ""}</td>
      <td data-label="审查状态">${statusControl(target.last_status || "pending", target.latestWarnings, `data-action="status" data-id="${target.id}" aria-label="查看 ${escapeHtml(target.label)} 的审查详情"`, targetReviewStatus(target))}<small class="status-subnote">${["available", "partial"].includes(String(target.accountStatus ?? "")) ? `主页 ${escapeHtml(formatDate(target.latestSnapshotAt || (target.last_status === "error" ? null : target.last_checked_at)))}${target.last_status === "error" ? " · 沿用历史" : target.worksCoverage === "limited" ? " · 作品最新窗口" : target.worksCoverage === "retry" || target.worksCoverage === "unavailable" ? " · 作品待补采" : ""}` : ""}</small></td>
      <td data-label="操作" class="align-right"><div class="row-actions">${canEdit ? target.strictIdentityStatus ? `<button class="mini-button" type="button" disabled title="请先查看审查详情并补齐证据">${target.strictIdentityStatus === "rejected" ? "需补证据" : "复核中"}</button>` : `<button class="mini-button" data-action="toggle" data-id="${target.id}" data-enabled="${target.enabled}" type="button">${target.enabled ? "暂停" : "启用"}</button>` : '<span class="form-note">只读</span>'}${canAdminister ? `<button class="mini-button" data-action="delete" data-id="${target.id}" type="button">删除</button>` : ""}</div></td>
    </tr>`).join("");
  const options = state.data.targets.map((target) => `<option value="${target.id}">${escapeHtml(target.label)} · ${target.type === "account" ? "账号" : "话题"}</option>`).join("");
  $("#importTargetSelect").innerHTML = options || '<option value="">请先添加监控对象</option>';
}

function authorJobSkippedList(result, limit = 20) {
  const skipped = Array.isArray(result?.skipped) ? result.skipped.slice(0, limit) : [];
  if (!skipped.length) return "";
  return `<ul>${skipped.map((item) => {
    const boardNames = [item.board, ...(Array.isArray(item.boards) ? item.boards : [])]
      .map((board) => typeof board === "object" ? board?.name : board)
      .filter(Boolean);
    const evidence = [
      item.platform ? platformLabel(item.platform) : "",
      ...new Set(boardNames),
      item.locator,
      item.douyinId ? `抖音号 ${item.douyinId}` : "",
      item.bilibiliId ? `B站 UID ${item.bilibiliId}` : "",
      item.xiaohongshuId ? `小红书 ID ${item.xiaohongshuId}` : "",
      item.contentId ? `作品 ID ${item.contentId}` : "",
      item.videoId && item.videoId !== item.contentId ? `核验作品 ${item.videoId}` : "",
      item.videoLink || item.shareUrl,
    ].filter(Boolean);
    const boardDetails = (Array.isArray(item.boards) ? item.boards : []).filter((board) => board && typeof board === "object");
    const relation = [
      ["机构", item.organization || boardDetails.find((board) => board.organization)?.organization],
      ["分层", item.tier || boardDetails.find((board) => board.tier)?.tier],
      ["赛道", item.category || boardDetails.find((board) => board.category)?.category],
      ["负责人", item.owner || boardDetails.find((board) => board.owner)?.owner],
      ["填写日期", item.filledDate || boardDetails.find((board) => board.filledDate)?.filledDate],
      ["备注", item.note || boardDetails.find((board) => board.note)?.note],
    ].filter(([, value]) => value).map(([label, value]) => `${label} ${value}`);
    return `<li>
      <div class="author-job-item-head"><strong>${escapeHtml(item.name || `第 ${item.sourceRow || "—"} 行`)}</strong><small>${item.sourceRow ? `第 ${escapeHtml(item.sourceRow)} 行` : ""}</small></div>
      <span class="author-job-reason">${escapeHtml(item.reason || item.identityConflict || "未提供原因")}</span>
      ${evidence.length ? `<small class="author-job-evidence">提交证据：${evidence.map((value) => escapeHtml(value)).join(" · ")}</small>` : ""}
      ${relation.length ? `<small class="author-job-evidence">板块资料：${relation.map((value) => escapeHtml(value)).join(" · ")}</small>` : ""}
      ${item.rejectedLink ? `<small class="author-job-security">${escapeHtml(item.rejectedLink)}；原始不安全链接未保存。</small>` : ""}
    </li>`;
  }).join("")}</ul>`;
}

function renderAuthorJobs() {
  const jobs = state.data.authorResolutionJobs || [];
  const panel = $("#authorJobPanel");
  const signature = JSON.stringify(jobs.map((job) => [
    job.id, job.status, job.phase, job.finishedAt, job.error,
    job.result?.createdCount, job.result?.skippedTotal, job.result?.reviewRequiredCount,
    job.result?.boardMembershipsAdded, job.result?.boardMembershipsUpdated, job.result?.boardFieldConflicts?.length,
  ]));
  if (panel.dataset.renderSignature === signature) return;
  const openDetails = new Set($$("details[open][data-detail-key]", panel).map((details) => details.dataset.detailKey));
  panel.dataset.renderSignature = signature;
  if (!jobs.length) {
    panel.classList.add("hidden");
    panel.dataset.status = "";
    return;
  }
  const latest = jobs[0];
  const active = ["queued", "running"].includes(latest.status);
  const statusText = latest.status === "queued" ? "等待后台核验"
    : latest.status === "running" && latest.phase === "importing" ? "正在写入监控名单"
    : latest.status === "running" ? "正在严格核验"
    : latest.status === "completed" ? "核验完成"
    : "核验失败";
  panel.classList.remove("hidden");
  panel.dataset.status = latest.status;
  $("#authorJobStatus").textContent = statusText;
  const result = latest.result || {};
  const resolution = result.resolution || {};
  const relationshipChanges = Number(result.boardMembershipsAdded || 0) + Number(result.boardMembershipsUpdated || 0);
  const summary = latest.status === "completed"
    ? `<div class="author-job-metrics">
        <div><span>严格核验通过</span><strong>${formatNumber(resolution.resolvedAuthors || 0)}</strong></div>
        <div><span>新增监控</span><strong>${formatNumber(result.createdCount || 0)}</strong></div>
        <div><span>板块归属 / 资料更新</span><strong>${formatNumber(relationshipChanges)}</strong></div>
        <div><span>板块资料冲突</span><strong>${formatNumber(result.boardFieldConflicts?.length || 0)}</strong></div>
        <div><span>转后台重试</span><strong>${formatNumber(result.queuedAuthors || 0)}</strong></div>
        <div><span>需修表复核</span><strong>${formatNumber(result.reviewRequiredCount ?? result.skippedCount ?? 0)}</strong></div>
        <div><span>复用已有监控</span><strong>${formatNumber(result.reusedExistingCount || 0)}</strong></div>
      </div>`
    : latest.status === "failed"
      ? `<p class="author-job-error">${escapeHtml(latest.error || "后台核验未完成；任务记录已保留。")}</p>`
      : `<p class="author-job-copy">任务已保存到本机数据库并在后台逐项核验。当前接口只提供阶段状态，因此不显示虚构百分比；你可以关闭页面，任务不会丢失。</p>`;
  const skipped = Array.isArray(result.skipped) ? result.skipped.slice(0, 20) : [];
  const skippedTotal = Number(result.skippedTotal ?? result.skippedCount ?? skipped.length);
  const reviewRequired = Number(result.reviewRequiredCount ?? result.skippedCount ?? 0);
  const nextStepCopy = reviewRequired
    ? `其中 ${formatNumber(reviewRequired)} 条需要处理：下载完整审查清单，在原表补充可唯一确认的主页 / 账号证据，或修正冲突、关系资料后重新读取；系统不会把证据不足或冲突的行自动写入监控。`
    : "这些记录均为复用已有监控或幂等处理，无需修表；可下载完整审查清单留档。";
  const bucketNote = latest.status === "completed"
    ? `提交记录共 ${formatNumber(latest.totalAuthors || 0)} 条；新增、复用、重试和复核是处理结果口径，板块归属与资料冲突是关系口径，不能直接相加。完整逐行证据以审查清单 CSV 为准。`
    : "";
  const details = skipped.length ? `<details class="author-job-details" data-detail-key="latest-${escapeHtml(latest.id)}"><summary>查看前 ${formatNumber(skipped.length)} / 共 ${formatNumber(skippedTotal)} 条未写入、需复核或复用记录</summary>${authorJobSkippedList(result)}<div class="author-job-next"><strong>下一步</strong><span>${escapeHtml(nextStepCopy)}</span><a class="author-job-download" href="/api/author-spreadsheet/jobs/${encodeURIComponent(latest.id)}/skipped?format=csv">下载完整审查清单 CSV</a></div></details>` : "";
  const history = jobs.slice(1, 5).map((job) => {
    const oldRelationshipChanges = Number(job.result?.boardMembershipsAdded || 0) + Number(job.result?.boardMembershipsUpdated || 0);
    const label = job.status === "completed" ? `完成 · 新增 ${formatNumber(job.result?.createdCount || 0)} · 板块更新 ${formatNumber(oldRelationshipChanges)}` : job.status === "failed" ? "失败" : job.status === "running" ? "处理中" : "等待中";
    const oldSkipped = Array.isArray(job.result?.skipped) ? job.result.skipped : [];
    const oldSkippedTotal = Number(job.result?.skippedTotal ?? job.result?.skippedCount ?? oldSkipped.length);
    return `<li class="author-job-history-item"><details data-detail-key="job-${escapeHtml(job.id)}" ${oldSkipped.length ? "" : "class=\"no-details\""}><summary><span>${escapeHtml(job.fileName || "未命名表格")}</span><small>${escapeHtml(label)} · ${escapeHtml(formatDate(job.finishedAt || job.createdAt))}${oldSkippedTotal ? ` · ${formatNumber(oldSkippedTotal)} 条记录` : ""}</small></summary>${authorJobSkippedList(job.result)}${oldSkippedTotal ? `<a class="author-job-download" href="/api/author-spreadsheet/jobs/${encodeURIComponent(job.id)}/skipped?format=csv">下载该任务完整审查清单</a>` : ""}</details></li>`;
  }).join("");
  $("#authorJobBody").innerHTML = `
    <div class="author-job-primary">
      <div class="author-job-meta"><strong>${escapeHtml(latest.fileName || "未命名表格")}</strong><span>${latest.sheetName ? `${escapeHtml(latest.sheetName)} · ` : ""}${formatNumber(latest.totalAuthors)} 条提交记录（可能包含重复作者） · ${escapeHtml(formatDate(latest.createdAt))}</span></div>
      ${active ? '<progress aria-label="名单核验进行中"></progress>' : '<progress value="1" max="1" aria-label="名单核验已结束"></progress>'}
    </div>
    ${summary}${bucketNote ? `<p class="author-job-copy author-job-copy--note">${escapeHtml(bucketNote)}</p>` : ""}${details}
    ${history ? `<details class="author-job-history" data-detail-key="history"><summary>最近任务记录（可展开回查）</summary><ul>${history}</ul></details>` : ""}`;
  for (const key of openDetails) panel.querySelector(`details[data-detail-key="${CSS.escape(key)}"]`)?.setAttribute("open", "");
  panel.setAttribute("aria-busy", active ? "true" : "false");
}

function statusImpactCopy(status, warnings = []) {
  const text = warningListText(warnings);
  if (/历史多作品|逐项复核|全部作品逐项确认/.test(text) && status === "warning") return { level: "身份复核中", title: "账号已暂停，后台正在逐项核对全部历史作品证据", body: "少一项、错一项或出现不同作者都不会恢复；全部证据确认同一作者后，此前已启用的账号才会自动恢复，原本关闭的账号仍保持关闭。" };
  if (/历史短链|原始路径大小写不可恢复/.test(text) && status === "rejected") return { level: "需要补证据", title: "旧短链无法安全恢复，账号保持暂停", body: "短链路径大小写会影响真实目标。请从原表重新复制完整原始分享链接，重新上传并通过严格核验后再恢复。" };
  if (status === "warning" && RETRY_WARNING_PATTERN.test(text)) return { level: "自动重试中", title: "作品列表未完整更新，系统将在下次定时任务重试", body: "主页粉丝与累计获赞仍保留；作品缺失字段不会写成 0，也不会制造虚假增量。" };
  if (status === "warning") return { level: "范围说明", title: "采集成功，但公开来源存在统计边界", body: "已保存可核验数据；请按具体说明理解覆盖范围，无需手动处理。" };
  if (status === "error") return { title: "本次采集没有更新数据", body: "历史数据仍然保留；系统会在下次定时任务自动重试。" };
  if (status === "rejected") return { title: "本次数据未写入", body: "系统发现身份、结构或范围不符合要求，因此拒绝写入，避免错误数据进入报告。" };
  return { title: "数据已通过结构校验", body: "本次采集没有发现需要提示的范围或字段问题。" };
}

function statusAdvice(warnings, status) {
  const text = warningListText(warnings);
  if (/历史多作品|逐项复核|全部作品逐项确认/.test(text) && status === "warning") return ["无需手动开启账号；后台会逐项重核，全部归属一致后只恢复此前已启用的账号，原本关闭的账号不会被擅自开启。若转为“需人工核验”，请按问题清单补充原始作品证据后重新读取。"];
  if (/历史短链|原始路径大小写不可恢复/.test(text) && status === "rejected") return ["请从原始名单重新复制区分大小写的完整分享链接，上传后重新核验；在此之前系统不会允许启用该账号。"];
  const advice = [];
  if (/最新公开作品窗口|完整历史/.test(text)) advice.push("无需手动处理；后续每日采集会继续累积。当前作品数不代表账号完整历史。");
  if (/推荐|非目标作者|sec_uid/.test(text)) advice.push("无需手动删除；系统已按作者身份自动剔除非目标内容。");
  if (/登录|账号池|全网/.test(text)) advice.push("请按“已监控账号池”范围解读，当前结果不代表抖音全网数据。");
  if (RETRY_WARNING_PATTERN.test(text) || status === "error") advice.push(`无需持续盯守；主机可用时，系统会在下次 ${state.data?.scheduler?.scheduleTime || "10:00"} 自动采集或同日退避补采时重试。`);
  if (status === "rejected") advice.push("请检查账号主页、作者身份或导入内容；在证据一致前不要强制写入。");
  if (!advice.length) advice.push(status === "warning" ? "当前数据可继续用于报告；结合上方具体信息理解其统计边界。" : "无需额外操作。");
  return [...new Set(advice)];
}

function renderStatusDialog({ target, audits }, growthEvidence = null) {
  const latest = audits?.[0] || null;
  const strictIdentityReview = Boolean(target?.strictIdentityStatus);
  const status = strictIdentityReview ? target.last_status : latest?.status || target?.last_status || "pending";
  const warnings = strictIdentityReview
    ? target.latestWarnings
    : latest?.warnings?.length
      ? latest.warnings
      : [latest?.message || target?.last_error || "尚未生成具体审查信息。"];
  const impact = statusImpactCopy(status, warnings);
  const needsEvidence = targetNeedsEvidence(target);
  const review = needsEvidence
    ? { key: "manual", label: "需补证据" }
    : profileHealthReview(target?.accountStatus, target?.worksCoverage, status, warnings, { stale: target?.last_status === "error" });
  if (["available", "partial"].includes(String(target?.accountStatus ?? ""))) {
    impact.level = review.label;
    impact.title = needsEvidence
      ? "身份证据未完成确认，暂沿用上次有效主页快照"
      : target?.last_status === "error"
        ? "本次更新未完成，但上次有效主页快照仍在使用"
      : target?.worksCoverage === "limited" || target?.worksCoverage === "latest-public-window"
        ? "主页指标已核验，作品数据按公开最新窗口统计"
        : target?.worksCoverage === "retry" || target?.worksCoverage === "unavailable"
          ? "主页指标已核验，作品列表将在自动任务中补采"
          : "主页与作品数据均已通过结构校验";
    impact.body = needsEvidence
      ? "报告继续使用最近一次带有账号身份和累计指标的快照；请补充官方主页、分享链接或一致的账号 ID，身份证据一致前不会强制写入。"
      : target?.last_status === "error"
        ? "报告继续使用最近一次带有账号身份和累计指标的快照；本次失败原因保留在下方审查记录中，不会被写成 0。"
      : "粉丝、主页累计获赞等账号级指标可以用于日报增长计算；作品覆盖边界单独记录，绝不冒充完整历史。";
  }
  $("#statusDialogTitle").textContent = target?.label || "审查记录";
  $("#statusImpact").className = `status-impact ${review.key}`;
  $("#statusImpact").innerHTML = `<span>${escapeHtml(impact.level || review.label)}</span><div><strong>${escapeHtml(impact.title)}</strong><p>${escapeHtml(impact.body)}</p></div>`;
  const checksum = latest?.source_checksum || "";
  $("#statusFacts").innerHTML = [
    ["最近审查", latest?.created_at ? formatDate(latest.created_at) : "暂无"],
    ["本次作品", latest ? `${formatNumber(latest.normalized_post_count)} 条` : "—"],
    ["主页快照", ["available", "partial"].includes(String(target?.accountStatus ?? "")) ? (target.accountStatus === "available" ? "已核验" : "部分指标") : "未取得"],
    ["作品覆盖", target?.worksCoverage === "limited" || target?.worksCoverage === "latest-public-window" ? "最新公开窗口" : target?.worksCoverage === "retry" || target?.worksCoverage === "unavailable" ? "待自动补采" : target?.worksCoverage === "unknown" ? "未判定" : target?.worksCoverage === "complete" ? "已更新" : "—"],
    ["数据来源", providerLabel(latest?.provider || target?.provider)],
    ["校验指纹", checksum ? `${checksum.slice(0, 12)}…` : "暂无"],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong title="${escapeHtml(checksum && label === "校验指纹" ? checksum : "")}">${escapeHtml(value)}</strong></div>`).join("");
  const readableWarnings = [...new Set(warnings.map(humanizeWarning))];
  $("#statusWarningList").innerHTML = readableWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const technicalWarnings = warnings.filter((warning, index) => typeof warning === "string" && humanizeWarning(warning) !== warning.trim() && warnings.indexOf(warning) === index);
  $("#statusTechnicalEvidence").classList.toggle("hidden", !technicalWarnings.length);
  $("#statusTechnicalList").innerHTML = technicalWarnings.map((warning) => `<li><code>${escapeHtml(warning)}</code></li>`).join("");
  $("#statusAdviceList").innerHTML = statusAdvice(warnings, status).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const growthSection = $("#statusGrowthSection");
  growthSection.classList.toggle("hidden", !growthEvidence);
  if (growthEvidence) {
    const modeLabel = (mode) => mode === "first-in-period" ? "从本期首条快照起算" : mode === "period-start" ? "期初前最近快照" : "不可比";
    const fingerprint = (value) => value ? `${String(value).slice(0, 12)}…` : "无";
    const rows = [
      ["涨粉", `${formatExactNumber(growthEvidence.followersBaseline)} → ${formatExactNumber(growthEvidence.followersCurrent)} = ${formatExactSignedNumber(growthEvidence.followersDelta)}`, `${formatDate(growthEvidence.followersBaselineAt)} 至 ${formatDate(growthEvidence.followersCurrentAt)} · ${modeLabel(growthEvidence.followersBaselineMode)}`, growthEvidence.followersBaselineChecksum, growthEvidence.followersCurrentChecksum],
      ["主页新增点赞", `${formatExactNumber(growthEvidence.accountLikesBaseline)} → ${formatExactNumber(growthEvidence.accountLikesCurrent)} = ${formatExactSignedNumber(growthEvidence.accountLikesDelta)}`, `${formatDate(growthEvidence.accountLikesBaselineAt)} 至 ${formatDate(growthEvidence.accountLikesCurrentAt)} · ${modeLabel(growthEvidence.accountLikesBaselineMode)}`, growthEvidence.accountLikesBaselineChecksum, growthEvidence.accountLikesCurrentChecksum],
      ["估算新增播放", `${formatExactSignedNumber(growthEvidence.accountLikesDelta)} × 100 = ${formatExactSignedNumber(growthEvidence.estimatedPlaysDelta)}`, "按用户指定换算规则推算，不是平台实测播放量", growthEvidence.accountLikesBaselineChecksum, growthEvidence.accountLikesCurrentChecksum],
    ];
    $("#statusGrowthEvidence").innerHTML = rows.map(([label, formula, range, baselineChecksum, currentChecksum]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(formula)}</strong><small>${escapeHtml(range)}</small><code title="基线 ${escapeHtml(baselineChecksum || "")} / 当前 ${escapeHtml(currentChecksum || "")}">指纹 ${escapeHtml(fingerprint(baselineChecksum))} → ${escapeHtml(fingerprint(currentChecksum))}</code></div>`).join("");
  }
  $("#statusHistory").innerHTML = audits?.length ? audits.slice(0, 5).map((audit) => `
    <div class="status-history-row"><span>${escapeHtml(formatDate(audit.created_at))}</span><strong>${escapeHtml(reviewStatus(audit.status, audit.warnings).label)}</strong><small>${escapeHtml(humanizeWarning(audit.warnings?.[0] || audit.message || "审查完成"))}</small></div>`).join("") : '<div class="empty-inline">暂无历史审查记录。</div>';
  const syncButton = $("#statusSyncButton");
  syncButton.dataset.id = target?.id || "";
  syncButton.classList.add("hidden");
  openDialog($("#statusDialog"));
}

async function openTargetStatus(targetId, growthEvidence = null) {
  try {
    renderStatusDialog(await api(`/api/targets/${targetId}/audits`), growthEvidence);
  } catch (error) { toast(error.message, "error"); }
}

function contributorIdentityLabel(item) {
  const target = state.data?.targets?.find((candidate) => Number(candidate.id) === Number(item.targetId));
  return String(item.label || target?.label || `目标 ${item.targetId}`).trim() || `目标 ${item.targetId}`;
}

function contributorBoardInfo(item) {
  const target = state.data?.targets?.find((candidate) => Number(candidate.id) === Number(item.targetId));
  const boards = Array.isArray(item.boards) && item.boards.length ? item.boards : target?.boards;
  const first = Array.isArray(boards) ? boards.find((board) => board && typeof board === "object") || boards[0] : null;
  if (first && typeof first === "object") {
    return {
      name: String(first.name || "未分板块").trim() || "未分板块",
      tier: String(first.tier || "未分层").trim() || "未分层",
      allNames: boards.filter((board) => board && typeof board === "object").map((board) => String(board.name || "").trim()).filter(Boolean),
    };
  }
  const names = Array.isArray(boards) ? boards.map((board) => String(board || "").trim()).filter(Boolean) : [];
  return { name: names[0] || "未分板块", tier: "未分层", allNames: names };
}

function contributorInitial(label) {
  const value = String(label || "?").trim();
  return value ? Array.from(value)[0].toUpperCase() : "?";
}

function contributorTrendGlyph(delta, baseline, current) {
  const change = finiteNumberOrNull(delta);
  const start = finiteNumberOrNull(baseline);
  const end = finiteNumberOrNull(current);
  if (change === null || start === null || end === null) return "<span class=\"contributor-sparkline-empty\">—</span>";
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const endY = direction === "up" ? 5 : direction === "down" ? 17 : 11;
  const label = direction === "up" ? "最近两次快照上涨" : direction === "down" ? "最近两次快照下降" : "最近两次快照无变化";
  return `<svg class="contributor-sparkline ${direction}" viewBox="0 0 64 22" role="img" aria-label="${label}"><path d="M2 14 L62 ${endY}"/><circle cx="62" cy="${endY}" r="2.2"/></svg>`;
}

function renderContributors(report) {
  const metric = state.contributorMetric;
  const specifications = {
    followers: { key: "followersDelta", label: "涨粉", current: "followersCurrent", baseline: "followersBaseline", currentAt: "followersCurrentAt", baselineAt: "followersBaselineAt", baselineMode: "followersBaselineMode", direction: -1, positiveOnly: true },
    likes: { key: "accountLikesDelta", label: "新增点赞", current: "accountLikesCurrent", baseline: "accountLikesBaseline", currentAt: "accountLikesCurrentAt", baselineAt: "accountLikesBaselineAt", baselineMode: "accountLikesBaselineMode", direction: -1, positiveOnly: true },
    loss: { key: "followersDelta", label: "掉粉", current: "followersCurrent", baseline: "followersBaseline", currentAt: "followersCurrentAt", baselineAt: "followersBaselineAt", baselineMode: "followersBaselineMode", direction: 1, negativeOnly: true },
    plays: { key: "estimatedPlaysDelta", label: "估算新增播放", current: "accountLikesCurrent", baseline: "accountLikesBaseline", currentAt: "accountLikesCurrentAt", baselineAt: "accountLikesBaselineAt", baselineMode: "accountLikesBaselineMode", direction: -1, estimated: true, positiveOnly: true },
  };
  const spec = specifications[metric] || specifications.followers;
  const comparable = (report.contributors || []).filter((item) => item[spec.key] !== null && item[spec.key] !== undefined && (!spec.negativeOnly || Number(item[spec.key]) < 0) && (!spec.positiveOnly || Number(item[spec.key]) > 0));
  comparable.sort((left, right) => spec.direction * (Number(left[spec.key]) - Number(right[spec.key])));
  const denominator = comparable.reduce((sum, item) => {
    const value = Number(item[spec.key]);
    return sum + (spec.negativeOnly ? Math.abs(value) : Math.max(0, value));
  }, 0);
  const totalComparable = metric === "likes" || metric === "plays" ? report.summary.likesComparableTargetCount : report.summary.followersComparableTargetCount;
  const fallbackCount = metric === "likes" || metric === "plays" ? report.summary.likesFallbackBaselineTargetCount : report.summary.followersFallbackBaselineTargetCount;
  $("#contributorCoverage").textContent = `${formatNumber(totalComparable)}/${formatNumber(report.summary.growthCurrentTargetCount)} 个账号可比${fallbackCount ? ` · ${formatNumber(fallbackCount)} 个从本期首条快照起算` : ""}`;
  const descriptor = $("#contributorDescriptor");
  if (descriptor) {
    const boardName = state.boardSelection === BOARD_ALL
      ? "全部板块"
      : state.boardSelection === BOARD_UNASSIGNED
        ? "未分板块"
        : (boardCatalog().find((board) => board.key === state.boardSelection)?.label || state.boardSelection);
    const metricLabel = metric === "followers" ? "涨粉 TOP" : metric === "likes" ? "新增赞 TOP" : metric === "loss" ? "掉粉 TOP" : "估算播放 TOP";
    descriptor.textContent = `实时追踪 ${formatNumber(report.summary.growthCurrentTargetCount)} 位作者 · ${boardName} · 按${metricLabel}排序；缺少两次可比快照的作者不参与排序。`;
  }
  const visible = comparable.slice(0, 10);
  $("#contributorList").innerHTML = comparable.length ? `<div class="contributor-table-head" aria-hidden="true"><span>#</span><span>作者 / 板块</span><span>分层</span><span class="align-right">粉丝</span><span>快照变化</span><span class="align-right">作品</span></div>${visible.map((item, index) => {
    const value = Number(item[spec.key]);
    const share = denominator ? Math.round((spec.negativeOnly ? Math.abs(value) : Math.max(0, value)) / denominator * 100) : 0;
    const review = profileHealthReview(item.accountStatus, item.worksCoverage, item.qualityStatus, item.warnings);
    const baselineNote = item[spec.baselineMode] === "first-in-period" ? "本期首条快照起算" : "期初前最近快照";
    const evidence = `${formatExactNumber(item[spec.baseline])} → ${formatExactNumber(item[spec.current])} · ${formatDate(item[spec.baselineAt])} 至 ${formatDate(item[spec.currentAt])}`;
    const shareLabel = spec.negativeOnly ? "掉粉占比" : "正向贡献";
    const target = state.data?.targets?.find((candidate) => Number(candidate.id) === Number(item.targetId));
    const label = contributorIdentityLabel(item);
    const board = contributorBoardInfo(item);
    const boardTitle = board.allNames.join("、") || board.name;
    const platform = platformLabel(item.platform || target?.metadata?.platform);
    const works = finiteNumberOrNull(target?.known_posts);
    const followerCurrent = finiteNumberOrNull(item.followersCurrent);
    const trend = contributorTrendGlyph(value, item[spec.baseline], item[spec.current]);
    const trendDirection = value > 0 ? "up" : value < 0 ? "down" : "flat";
    return `<button class="contributor-row" data-contributor-target="${item.targetId}" type="button" aria-label="查看 ${escapeHtml(label)} 的审查证据">
      <span class="contributor-rank">${String(index + 1).padStart(2, "0")}</span>
      <span class="contributor-identity"><span class="contributor-avatar avatar-tone-${index % 6}">${escapeHtml(contributorInitial(label))}</span><span class="contributor-identity-copy"><strong title="${escapeHtml(label)}">${escapeHtml(label)}</strong><small title="${escapeHtml(boardTitle)}">${escapeHtml(platform)} · ${escapeHtml(board.name)}</small><em class="contributor-status ${escapeHtml(review.key)}">${escapeHtml(review.label)}</em></span></span>
      <span class="contributor-tier" title="${escapeHtml(board.tier)}">${escapeHtml(board.tier)}</span>
      <span class="contributor-followers">${formatNumber(followerCurrent)}</span>
      <span class="contributor-evidence ${trendDirection}" title="${escapeHtml(evidence)}"><span class="contributor-trend-wrap">${trend}<strong>${formatExactSignedNumber(value)}</strong></span><small>${spec.estimated ? "估算 · " : ""}${share}% ${shareLabel}</small></span>
      <span class="contributor-works">${formatNumber(works)}</span>
    </button>`;
  }).join("")}<div class="contributor-footer"><span>显示 1–${formatNumber(visible.length)} / 共 ${formatNumber(comparable.length)} 个账号</span><span>缺少两次可比快照的作者不按 0 排名</span></div>` : `<div class="empty-list">${spec.negativeOnly ? "本期没有可比账号出现掉粉。" : `本期没有可比账号产生正向${spec.label}；缺失不会按 0 排名。`}</div>`;
  $$(".contributor-tabs button").forEach((button) => {
    const active = button.dataset.contributorMetric === metric;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

function renderReports() {
  const report = selectedReport();
  const summary = report.summary;
  const periodLabel = ({ day: "每日", week: "本周", month: "本月" })[state.period] || "区间";
  const dailyRuns = completedDailyRuns();
  const selectedRun = dailyRuns.find((run) => run.finished_at === state.dailyReportReference) || null;
  const latestRun = dailyRuns[0] || null;
  const picker = $("#dailyReportPicker");
  const pickerSelect = $("#dailyReportSelect");
  picker.classList.toggle("hidden", state.period !== "day" || !dailyRuns.length);
  if (state.period === "day" && dailyRuns.length) {
    const batchRun = automaticRun("latestBatch");
    pickerSelect.innerHTML = dailyRuns.map((run) => `<option value="${escapeHtml(run.finished_at)}">${escapeHtml(dailyRunOptionLabel(run, batchRun))}</option>`).join("");
    pickerSelect.value = state.dailyReportReference || latestRun.finished_at;
    const selectedDay = localDateKey(selectedRun?.started_at || report.end);
    const isToday = selectedDay === localDateKey();
    const isLatest = selectedRun?.finished_at === latestRun?.finished_at;
    const title = isToday ? "今日自动日报" : isLatest ? "最近完成日报" : "历史自动日报";
    const nextCopy = !isToday && isLatest ? ` · 今日任务将在 ${state.data.scheduler.scheduleTime} 自动执行` : "";
    const worksCoverage = `作品列表：${formatNumber(summary.validatedTargetCount)} 完整 / ${formatNumber(summary.limitedTargetCount)} 范围 / ${formatNumber(summary.retryTargetCount)} 重试${summary.unknownTargetCount ? ` / ${formatNumber(summary.unknownTargetCount)} 未判定` : ""}`;
    const reportTargetCount = summary.targetCount || 0;
    $("#reportContext").innerHTML = `<strong>${escapeHtml(title)} · ${escapeHtml(selectedDay)}</strong><span>${formatNumber(summary.profileSnapshotTargetCount)}/${formatNumber(reportTargetCount)} 份主页快照已保存 · ${escapeHtml(worksCoverage)} · 完成于 ${escapeHtml(formatDate(selectedRun?.finished_at, { second: "2-digit" }))}${escapeHtml(nextCopy)}</span>`;
  } else {
    const cutoff = summary.latestSnapshotAt ? `数据截至 ${formatDate(summary.latestSnapshotAt)}` : "尚无本期主页快照";
    $("#reportContext").innerHTML = `<strong>${escapeHtml(periodLabel)}进行中汇总</strong><span>${escapeHtml(cutoff)} · 当前周期尚未结束；按已保存的公开快照计算，缺失值不会按 0 计入。</span>`;
  }
  const collectionProof = [
    ["主页快照", summary.profileSnapshotTargetCount, "本期实际写入"],
    ["作品样本更新", summary.sampledPostCount, "已刷新指标记录"],
    ["首次收录作品", summary.newlyObservedPostCount, "首次进入本地证据库"],
    [state.period === "day" ? "当日发布作品" : "本期发布作品", summary.postCount, "按作品真实发布时间"],
  ];
  $("#collectionProof").innerHTML = collectionProof.map(([label, value, note]) => `<div><span>${escapeHtml(label)}</span><strong>${formatExactNumber(value)}</strong><small>${escapeHtml(note)}</small></div>`).join("");
  const growthCards = [
    ["followers", `${periodLabel}涨粉数`, summary.followersDelta, summary.followersComparableTargetCount, summary.followersFallbackBaselineTargetCount, "账号粉丝净变化"],
    ["likes", `${periodLabel}新增点赞数`, summary.accountLikesDelta, summary.likesComparableTargetCount, summary.likesFallbackBaselineTargetCount, "主页累计获赞净变化"],
    ["plays", `${periodLabel}估算新增播放量`, summary.estimatedPlaysDelta, summary.likesComparableTargetCount, summary.likesFallbackBaselineTargetCount, "估算口径 · 新增点赞 × 100（非平台实测播放）"],
  ];
  $("#growthLedger").innerHTML = growthCards.map(([tone, label, value, comparable, fallback, note]) => `
    <article class="growth-card ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(formatExactSignedNumber(value))}">${formatExactSignedNumber(value)}</strong>
      <small>${escapeHtml(note)} · ${comparable ? `${comparable}/${summary.growthCurrentTargetCount} 个账号可比${fallback ? `，${fallback} 个从本期首条快照起算` : ""}` : "暂无前后可比快照"}</small>
    </article>`).join("");
  renderContributors(report);
  const likesObservedPostCount = finiteNumberOrNull(summary.likesObservedPostCount);
  const likesMissingPostCount = finiteNumberOrNull(summary.likesMissingPostCount);
  const likesCoverageKnown = likesObservedPostCount !== null && likesMissingPostCount !== null;
  const likesCoverageTotal = likesCoverageKnown ? likesObservedPostCount + likesMissingPostCount : null;
  const likesCoverage = likesCoverageKnown ? `（${formatNumber(summary.likesObservedPostCount)}/${formatNumber(likesCoverageTotal)} 条有值）` : "";
  const stats = [
    ["本期发布作品", summary.postCount], ["本期发布作者", summary.authorCount], [`本期发布作品当前赞合计${likesCoverage}`, summary.likesCurrent],
    [`重复采样作品点赞变化（${formatNumber(summary.sampledDeltaPostCount)}条）`, summary.likesDelta], [`本期发布作品点赞中位数${likesCoverage}`, summary.medianLikes], ["爆款作品", summary.viralCount],
  ];
  $("#reportSummary").innerHTML = stats.map(([label, value]) => `<div class="report-stat"><span>${label}</span><strong>${formatNumber(value)}</strong></div>`).join("");
  $("#viralThresholdLabel").textContent = `本期阈值：${formatNumber(summary.viralThreshold)} 赞${likesCoverageKnown ? ` · ${formatNumber(summary.likesObservedPostCount)}/${formatNumber(likesCoverageTotal)} 条有点赞可判断` : ""}`;
  $("#viralList").innerHTML = report.viral.length ? report.viral.slice(0, 6).map((post, index) => `
    <div class="viral-item"><span class="viral-rank">${String(index + 1).padStart(2, "0")}</span><div class="viral-copy">${httpLinkOrTextHtml(post.url, post.caption || "无标题作品")}<small>${escapeHtml(post.author_name || "未知作者")} · ${escapeHtml(formatDate(post.published_at))}</small></div><span class="viral-likes">${formatNumber(post.likes)}<small>赞</small></span></div>`).join("") : '<div class="empty-list">本周期没有达到当前爆款阈值的已采集作品。</div>';
  if (summary.boardScoped && !summary.boardDataComplete) {
    $("#viralList").innerHTML = '<div class="empty-list">正在读取这个板块的作品证据，完成前不会把缺失记成 0。</div>';
  } else if (likesCoverageKnown && Number(summary.postCount) > 0 && Number(summary.likesObservedPostCount) === 0) {
    $("#viralList").innerHTML = '<div class="empty-list">本期作品均缺少点赞证据，暂时无法判断是否达到爆款阈值。</div>';
  } else if (!report.viral.length && likesCoverageKnown && Number(summary.likesMissingPostCount) > 0) {
    $("#viralList").innerHTML = `<div class="empty-list">已知点赞的 ${formatNumber(summary.likesObservedPostCount)} 条作品中没有达到阈值；另有 ${formatNumber(summary.likesMissingPostCount)} 条缺少点赞，无法判断。</div>`;
  }
  $("#reportRange").textContent = `${formatDate(report.start, { year: "numeric" })} — ${formatDate(report.end, { year: "numeric" })}`;
  const dateQuery = state.period === "day" && state.dailyReportReference ? `&date=${encodeURIComponent(state.dailyReportReference)}` : "";
  const boardQuery = state.boardSelection !== BOARD_ALL ? `&board=${encodeURIComponent(state.boardSelection)}` : "";
  const exports = [
    [$("#exportGrowthCsv"), `/api/export?period=${state.period}&format=csv&scope=growth${dateQuery}${boardQuery}`],
    [$("#exportCsv"), `/api/export?period=${state.period}&format=csv${dateQuery}${boardQuery}`],
    [$("#exportMd"), `/api/export?period=${state.period}&format=md${dateQuery}${boardQuery}`],
  ];
  exports.forEach(([link, href]) => {
    link.href = href;
    link.removeAttribute("aria-disabled");
    link.classList.remove("disabled");
    link.title = "";
  });
  if (state.boardSelection === BOARD_UNASSIGNED) $("#reportRange").textContent += " · 未分板块";
  $$(".report-tabs button").forEach((button) => {
    const active = button.dataset.period === state.period;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

function auditSubject(audit = {}) {
  if (audit.target_label) return audit.target_label;
  if (audit.target_id != null) return "已删除目标";
  return /作者|名单|核验/.test(audit.message || "") ? "批量作者核验" : "系统审查";
}

function renderAudit() {
  const audits = state.data.audits;
  $("#auditFeed").innerHTML = audits.length ? audits.slice(0, 10).map((audit, index) => `
    <div class="audit-item"><span class="audit-time">${escapeHtml(formatDate(audit.created_at))}</span><div class="audit-message"><strong>${escapeHtml(auditSubject(audit))} · ${escapeHtml(providerLabel(audit.provider))}</strong><small>${escapeHtml(audit.message || "校验完成")}${audit.normalized_post_count ? ` · ${audit.normalized_post_count} 条作品` : ""}${audit.warnings?.length ? ` · ${escapeHtml([...new Set(audit.warnings.map(humanizeWarning))].join("；"))}` : ""}</small></div>${statusControl(audit.status, audit.warnings, `data-audit-detail="${index}" aria-label="查看该审查记录详情"`)}</div>`).join("") : '<div class="empty-inline">首次同步后会生成审查记录和校验指纹。</div>';
  const live = state.data.scheduler.currentRun;
  const lastRun = automaticRun("latest") || activeRecentRuns().find((run) => run.finished_at) || activeRecentRuns()[0];
  const batchRun = automaticRun("latestBatch");
  const retryRun = automaticRun("latestRetry");
  const auditTargets = filterTargetsByBoard(state.data?.targets || [], state.boardSelection, boardCatalog())
    .filter((target) => target.enabled !== false && Number(target.enabled) !== 0 && target.provider === "public-web" && target.type === "account");
  const auditPlatforms = [...new Set(auditTargets.map(platformForTarget))];
  const summary = overviewReport().summary;
  const runtimeAudit = state.runtimeAudit || state.data.runtimeAudit;
  const { limited: limitedCount, retry: retryCount } = automaticRunCounts(lastRun);
  const runKind = automaticRunKind(lastRun);
  $("#lastRunStatus").textContent = live
    ? `${live.triggerType === "scheduled" ? "自动采集中" : "单项核验中"} · ${live.completedCount}/${live.targetCount}`
    : lastRun ? `${runKind} · ${lastRun.status === "success" ? "采集完成" : statusLabel(lastRun.status)} · ${limitedCount} 范围 / ${retryCount} 重试 · ${formatDate(lastRun.finished_at || lastRun.started_at)}` : "尚未运行";
  $("#healthBatchStatus").textContent = batchRun
    ? `${batchRun.success_count}/${batchRun.target_count} 成功 · ${formatRunDuration(batchRun)} · ${formatDate(batchRun.finished_at || batchRun.started_at)}`
    : "尚未运行";
  const scheduleState = state.data.scheduler.scheduleState;
  $("#healthScheduleStatus").textContent = scheduleStateLabel(scheduleState, state.data.scheduler.scheduleTime);
  $("#healthRetryStatus").textContent = retryRun
    ? `${retryRun.success_count}/${retryRun.target_count} 成功 · ${formatRunDuration(retryRun)} · ${formatDate(retryRun.finished_at || retryRun.started_at)}`
    : "无补采记录";
  $("#lastRunSuccess").textContent = live ? String(live.successCount) : lastRun ? String(lastRun.success_count) : "—";
  $("#lastRunWarning").textContent = live ? String(live.warningCount) : lastRun ? String(lastRun.warning_count ?? 0) : "—";
  const failedTargetCount = live ? Number(live.errorCount || 0) : lastRun ? Number(lastRun.error_count || 0) : 0;
  const failedTargetElement = $("#lastRunError");
  failedTargetElement.textContent = lastRun || live ? String(failedTargetCount) : "—";
  failedTargetElement.disabled = failedTargetCount <= 0;
  failedTargetElement.title = failedTargetCount > 0 ? "打开需关注对象，查看每个失败目标的审查证据" : "当前没有失败目标";
  failedTargetElement.setAttribute("aria-label", failedTargetCount > 0 ? `打开 ${failedTargetCount} 个失败目标` : "当前没有失败目标");
  $("#healthProbeStatus").textContent = auditPlatforms.length
    ? auditPlatforms.map((platform) => sourceProbeStatusText(sourceProbeForPlatform(platform), platform)).join(" · ")
    : "尚未配置公开采集源";
  $("#healthCollectionMode").textContent = "后台快照 · 网页仅阅读";
  $("#healthNextRun").textContent = live ? "当前正在执行" : formatDate(state.data.scheduler.nextRunAt, { weekday: "short" });
  $("#healthDataCutoff").textContent = summary.latestSnapshotAt ? formatDate(summary.latestSnapshotAt) : "尚未形成快照";
  const databaseAudit = runtimeAudit?.database;
  $("#healthDatabaseStatus").textContent = databaseAudit
    ? databaseAudit.status === "ok"
      ? `完整 · ${formatExactNumber(databaseAudit.counts?.targets ?? 0)} 个对象`
      : `需关注 · ${databaseAudit.missingTables?.length ? `缺少 ${databaseAudit.missingTables.length} 张表` : "校验未通过"}`
    : "尚未自检";
  const dataQuality = databaseAudit?.dataQuality;
  $("#healthDataQualityStatus").textContent = dataQuality?.status === "ok"
    ? `通过 · ${formatExactNumber(dataQuality.checkCount ?? 0)} 项检查`
    : dataQuality?.status === "error"
      ? `需关注 · ${formatExactNumber(dataQuality.violationCount ?? 0)} 个问题`
      : "尚未自检";
  const backupAudit = runtimeAudit?.backup;
  $("#healthBackupStatus").textContent = backupAudit?.status === "ok"
    ? `已生成 · ${backupAudit.verification === "sha256+sqlite" ? "哈希与 SQLite 已复核" : "清单已校验"} · ${formatDate(backupAudit.createdAt)}`
    : backupAudit?.status === "missing"
      ? "尚未生成"
      : backupAudit?.error
        ? `需关注 · ${backupAudit.error}`
        : "尚未自检";
  const scheduledTargetCount = Number(state.data.scheduler?.scheduledTargetCount);
  const scheduledCompletedTargetCount = Number(state.data.scheduler?.scheduledCompletedTargetCount);
  const scheduledPendingTargetCount = Number(state.data.scheduler?.scheduledPendingTargetCount);
  const scheduledExhaustedTargetCount = Number(state.data.scheduler?.scheduledExhaustedTargetCount);
  const scheduledManualTargetCount = Number(state.data.scheduler?.scheduledManualTargetCount);
  const scheduledProfileCompletedTargetCount = Number(state.data.scheduler?.scheduledProfileCompletedTargetCount);
  const scheduledWorksDeferredTargetCount = Number(state.data.scheduler?.scheduledWorksDeferredTargetCount);
  const planCopy = Number.isFinite(scheduledTargetCount) && scheduledTargetCount > 0
    ? Number.isFinite(scheduledProfileCompletedTargetCount)
      ? `主页三项指标 ${formatNumber(scheduledProfileCompletedTargetCount)}/${formatNumber(scheduledTargetCount)}${scheduledWorksDeferredTargetCount > 0 ? ` · ${formatNumber(scheduledWorksDeferredTargetCount)} 个作品接口延后到次日` : ""}${scheduledPendingTargetCount > 0 ? ` · ${formatNumber(scheduledPendingTargetCount)} 个作品覆盖待处理` : ""}`
      : `全量计划 ${formatNumber(scheduledCompletedTargetCount)}/${formatNumber(scheduledTargetCount)} 完成${scheduledExhaustedTargetCount > 0 ? ` · ${formatNumber(scheduledExhaustedTargetCount)} 个达到重试上限` : scheduledPendingTargetCount > 0 ? ` · ${formatNumber(scheduledPendingTargetCount)} 个待处理` : ""}${scheduledManualTargetCount > 0 ? ` · ${formatNumber(scheduledManualTargetCount)} 个需补证据` : ""}`
    : "全量计划尚未开始";
  $("#healthAutomationTrace").textContent = `每日 ${state.data.scheduler.scheduleTime || "10:00"} 自动整批（健康面板按全量计划统计）；${planCopy}；失败对象按 15 分钟、60 分钟、3 小时退避补采；页面关闭不会中断任务。`;
  renderSourceProbeHistory();
  const healthScheduleState = state.data?.scheduler?.scheduleState;
  const scheduleAttention = ["partial", "failed", "interrupted", "due"].includes(healthScheduleState);
  const sourceAuditLabel = runtimeAudit?.sourceStatus === "degraded" ? "公开源降级（主页可用 / 作品接口受限）" : runtimeAudit?.sourceStatus === "ok" ? "公开源通过" : "公开源状态未确认";
  $("#runtimeAuditStatus").textContent = runtimeAudit
    ? `${runtimeAudit.database?.status === "ok" ? "数据库完整性通过" : "数据库完整性需关注"} · ${runtimeAudit.database?.dataQuality?.status === "ok" ? "数据契约通过" : "数据契约需关注"} · ${runtimeAudit.database?.foreignKeyViolations ? `${runtimeAudit.database.foreignKeyViolations} 个外键问题` : "无外键孤儿"} · ${runtimeAudit.backup?.status === "ok" ? "自动备份可恢复" : "自动备份需关注"} · ${sourceAuditLabel} · ${scheduleAttention ? `自动计划需关注（${scheduleStateLabel(healthScheduleState, state.data.scheduler.scheduleTime)}）` : "自动计划状态正常"} · ${formatDate(runtimeAudit.checkedAt)}`
    : "本机完整性自检尚未完成";
  $("#providerKeyStatus").textContent = "不使用";
}

function renderAuthorQueueButton() {
  const board = boardCatalog().find((item) => item.key === state.boardSelection);
  const scopedQueue = state.boardSelection === BOARD_ALL ? state.data.authorResolutionQueue : state.boardAutomation?.authorResolutionQueue;
  const count = board ? Number(board.queuedCount || 0) : scopedQueue ? Number(scopedQueue.pending || 0) : null;
  const scope = board?.label || (state.boardSelection === BOARD_UNASSIGNED ? "未分板块" : "全部板块");
  const countLabel = board ? "条证据未确认（待核对或未通过）" : "条作者证据待处理";
  const description = count === null ? `${scope} · 查看当前板块证据核验明细` : `${scope} · ${formatExactNumber(count)} ${countLabel}；同一作者可有多条记录，不等于未监控作者人数；打开查看本范围全部核验记录（含已通过）`;
  $("#authorQueueButtonCount").textContent = count === null ? "" : formatExactNumber(count);
  $("#authorQueueButtonCount").classList.toggle("hidden", count === null);
  $("#authorQueueButton").title = description;
  $("#authorQueueButton").setAttribute("aria-label", description);
}

function renderSystem() {
  const scheduler = state.data.scheduler;
  const zone = businessTimeZone();
  const zoneLabel = businessTimeZoneLabel(zone);
  renderAuthorQueueButton();
  $("#runtimeBadgeText").textContent = scheduler.running ? "后台更新中" : "每日自动更新";
  const accountCount = state.data.targets.filter((target) => target.type === "account").length;
  const topicCount = state.data.targets.filter((target) => target.type === "hashtag").length;
  const currentOrigin = typeof location === "undefined" ? "" : String(location.origin || "");
  const runtimeLabel = managementOriginLabel(currentOrigin);
  $("#footerStatus").textContent = `历史数据保存在本机 · ${runtimeLabel} · ${accountCount} 个账号 · ${topicCount} 个话题 · 每天 ${scheduler.scheduleTime} · ${zoneLabel}自动采集`;
  $("#settingsTimeZoneLabel").textContent = `每天自动采集时间 · ${zoneLabel}`;
  const beijingReference = zone === "Asia/Shanghai" ? "" : `；北京时间 ${formatDate(scheduler.nextRunAt, { timeZone: "Asia/Shanghai" })}`;
  $("#settingsAutomationSummary").textContent = `统计与定时时区：${zoneLabel}；下次 ${formatDate(scheduler.nextRunAt)}${beijingReference}。主机休眠或关机无法准点执行；唤醒后会按计划补采，历史缺口不会造数回填。`;
  const form = $("#settingsForm");
  if (!$("#settingsDialog").open) {
    form.scheduleTime.value = state.data.settings.scheduleTime || "10:00";
    form.viralLikeThreshold.value = state.data.settings.viralLikeThreshold ?? "10000";
    form.viralRelativeMultiplier.value = state.data.settings.viralRelativeMultiplier ?? "3";
    form.publicPostsPerAccount.value = state.data.settings.publicPostsPerAccount ?? "30";
  }
}

function syncNavigation() {
  const currentHash = ["#overview", "#boards", "#topics", "#targets", "#updates", "#reports", "#audit"].includes(location.hash) ? location.hash : "#overview";
  $$(".nav-links a").forEach((link) => {
    link.classList.toggle("active", link.getAttribute("href") === currentHash);
    if (link.getAttribute("href") === currentHash) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  productDashboard.route();
}

function syncLocationState(behavior = "auto") {
  const nextSelection = state.data
    ? normalizeBoardSelection(initialBoardSelection(), boardCatalog())
    : initialBoardSelection();
  const boardChanged = nextSelection !== state.boardSelection;
  if (boardChanged) {
    state.boardSelection = nextSelection;
    state.targetPage = 0;
    state.boardReportCache = {};
  }
  syncNavigation();
  if (state.data && boardChanged) {
    render();
    hydrateBoardReports();
    refreshBoardAutomation({ quiet: true, skip: typeof location !== "undefined" && location.hash === "#topics" }).then(() => {
      syncDailyReportState();
      render({ skipProduct: true });
    });
  }
  requestAnimationFrame(() => alignCurrentHash(behavior));
}

function alignCurrentHash(behavior = "auto") {
  productDashboard.route();
  // A hash-only navigation must still reconcile the product dashboard's
  // internal board with the URL. This prevents a stale all-board table from
  // briefly appearing when a user opens a scoped account page directly.
  if (state.data) productDashboard.load({ bootstrap: state.data, board: location.hash === "#topics" ? BOARD_ALL : state.boardSelection });
  window.scrollTo({ top: 0, behavior });
}

function render({ skipProduct = false } = {}) {
  syncNavigation();
  renderBoardControls(); renderAuthorJobs(); renderReports(); renderAudit(); renderSystem();
  // Topics are an independent panel; a board query in the URL must not make
  // it request board-scoped automation or show a false board read error.
  if (skipProduct) return null;
  return productDashboard.load({ bootstrap: state.data, board: typeof location !== "undefined" && location.hash === "#topics" ? BOARD_ALL : state.boardSelection });
}

async function refresh({ quiet = false } = {}) {
  try {
    state.data = await api("/api/bootstrap");
    try { state.data.continuity = await api("/api/continuity"); } catch { state.data.continuity = null; }
    state.runtimeAudit = state.data.runtimeAudit || null;
    state.boardReportCache = {};
    adoptPreferredBoardAfterLoad();
    // Paint the saved bootstrap immediately. A board-scoped automation read
    // can be slow on a large roster; it must enrich the page rather than
    // block the first usable view (especially on mobile and public links).
    const boardAutomationPromise = refreshBoardAutomation({ quiet: true, skip: typeof location !== "undefined" && location.hash === "#topics" });
    syncDailyReportState();
    if (state.data.auth) setAuthenticated(state.data.auth);
    const productLoad = render();
    await boardAutomationPromise;
    syncDailyReportState();
    // Automation status is a secondary panel. Updating it must not start a
    // second insights request and abort the first one on a large roster.
    render({ skipProduct: true });
    await productLoad;
  } catch (error) {
    if (error.status === 401) return showAuthRequired("会话已失效，请重新使用邀请码进入");
    $("#footerStatus").textContent = `本地服务连接失败：${error.message}`;
    if (!state.data) {
      $("#productFeedback").innerHTML = `<div class="product-error">本地服务读取失败：${escapeHtml(error.message)}。<button type="button" class="text-button" data-bootstrap-retry>重新连接</button></div>`;
    }
    if (!quiet) toast(error.message, "error");
    return;
  }
  hydrateBoardReports();
  if (!state.initialHashAligned) {
    state.initialHashAligned = true;
    requestAnimationFrame(() => requestAnimationFrame(() => alignCurrentHash("auto")));
  }
}

async function refreshRuntimeAudit() {
  const button = $("#runtimeAuditButton");
  const status = $("#runtimeAuditStatus");
  if (button) button.disabled = true;
  if (status) status.textContent = "正在检查数据库完整性、外键和调度器状态…";
  try {
    state.runtimeAudit = await api("/api/system-audit");
    renderAudit();
    toast(state.runtimeAudit.ok ? "本机全链路自检通过" : "本机自检发现需要关注的状态", state.runtimeAudit.ok ? "success" : "error");
  } catch (error) {
    if (status) status.textContent = `本机自检失败：${error.message}`;
    toast(`本机自检失败：${error.message}`, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshBoardAutomation({ quiet = false, skip = false } = {}) {
  if (skip || !state.data || state.boardSelection === BOARD_ALL) {
    state.boardAutomation = null;
    return;
  }
  const selection = state.boardSelection;
  try {
    const scoped = await api(`/api/bootstrap?board=${encodeURIComponent(selection)}`);
    if (selection !== state.boardSelection) return;
    state.boardAutomation = {
      automation: scoped.automation,
      recentRuns: scoped.recentRuns,
      reports: scoped.reports,
      authorResolutionQueue: scoped.authorResolutionQueue,
    };
  } catch (error) {
    if (selection !== state.boardSelection) return;
    state.boardAutomation = null;
    if (!quiet) toast(`板块自动任务状态读取失败：${error.message}`, "error");
  }
}

async function sync(targetId) {
  if (!targetId) return toast("全量采集由每天上午自动任务执行", "error");
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await api("/api/sync", { method: "POST", body: JSON.stringify({ targetId }) });
    const message = result.errorCount ? `同步完成：${result.successCount} 成功，${result.errorCount} 失败` : `同步完成：${result.successCount} 个目标已更新${result.skippedCount ? `，${result.skippedCount} 个手动目标已跳过` : ""}`;
    toast(message, result.errorCount ? "error" : "success");
    await refresh({ quiet: true });
  } catch (error) { toast(error.message, "error"); }
  finally { state.busy = false; }
}

function openDialog(dialog) { if (!dialog.open) dialog.showModal(); }
function closeDialog(dialog) { if (dialog.open) dialog.close(); }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",").at(-1));
    reader.onerror = () => reject(new Error("浏览器无法读取该文件"));
    reader.readAsDataURL(file);
  });
}

function authorStatusLabel(status) {
  return ({ ready: "可导入", resolvable: "可自动核验", unresolved: "核验未通过", identity_conflict: "身份信息冲突", existing: "已在监控", duplicate: "表内重复", needs_locator: "缺少公开证据", skipped: "已跳过" })[status] || status;
}

function authorManualReviewLabel(needsLocatorRows, identityConflictAuthors) {
  return [
    needsLocatorRows ? `${formatNumber(needsLocatorRows)} 条待补主页 / 账号证据` : "",
    identityConflictAuthors ? `${formatNumber(identityConflictAuthors)} 位身份冲突` : "",
  ].filter(Boolean).join(" · ");
}

function resetAuthorReview() {
  state.authorPreview = null;
  $("#authorReview").classList.add("hidden");
  $("#authorReviewEmpty").classList.remove("hidden");
  $("#authorCommitButton").classList.add("hidden");
  $("#authorCommitButton").disabled = true;
  $("#authorUploadStatus").textContent = "尚未读取文件";
  $("#authorSheetSelect").innerHTML = '<option value="">上传后自动识别</option>';
  $("#authorSheetSelect").disabled = true;
  $("#authorPreviewButton").disabled = true;
  $("#authorPreviewButton").textContent = "选择文件后自动审查";
  $("#authorFileName").textContent = "尚未选择文件";
}

function renderAuthorReview(preview) {
  state.authorPreview = preview;
  renderAuthorBoardChoices();
  const reviewRows = rowsWithDefaultBoard(preview.rows || [], authorDefaultBoardName());
  $("#authorReviewEmpty").classList.add("hidden");
  $("#authorReview").classList.remove("hidden");
  const summary = preview.summary;
  const identityCountReady = summary.identityCountVersion === 2;
  const previewCatalog = createBoardCatalog([...(state.data?.boards || []), ...(preview.boardCatalog || []), ...(preview.boards || [])], [...(state.data?.targets || []), ...reviewRows]);
  const previewBoardNames = new Set(reviewRows.flatMap((row) => targetBoardLabels(row, previewCatalog)));
  const metrics = [
    ["读取数据行", summary.totalRows, "total"],
    ["已有账号身份线索", identityCountReady ? (summary.knownUniqueAuthors ?? 0) : "待更新", "recognized"],
    ["身份待核验行", identityCountReady ? (summary.unresolvedIdentityRows || 0) : "待更新", identityCountReady && summary.unresolvedIdentityRows ? "resolvable" : "recognized"],
    ["待提交核验线索", summary.autoMonitorAuthors || summary.importableRows, "ready"],
    ["已在监控", summary.existingRows || 0, "existing"],
    ["表内重复", summary.duplicateRows || 0, "duplicate"],
    ["身份信息冲突", summary.identityConflictRows || 0, "conflict"],
    ["待补主页 / 账号证据", summary.needsLocatorRows || 0, "skipped"],
    ["无有效身份数据 / 忽略", summary.skippedRows || 0, "skipped"],
    ["识别板块", summary.totalRows ? Math.max(previewBoardNames.size, 1) : 0, "boards"],
  ];
  $("#authorReviewSummary").innerHTML = metrics.map(([label, value, tone]) => `<div class="review-metric ${tone}"><span>${label}</span><strong>${typeof value === "number" ? formatNumber(value) : escapeHtml(value)}</strong></div>`).join("");
  const mappingLabels = { platform: "平台", name: "作者", locator: "主页链接", secUid: "sec_uid", douyinId: "抖音号", bilibiliId: "B站UID", xiaohongshuId: "小红书ID", contentId: "内容ID", videoLink: "视频链接", organization: "机构", tier: "分层", category: "赛道", owner: "负责人", filledDate: "填写日期", notes: "备注", note: "备注", board: "板块", boards: "板块" };
  const mappings = Object.entries(preview.mapping).map(([field, item]) => `<span><b>${escapeHtml(mappingLabels[field] || field)}</b> ← ${escapeHtml(item.header)}（第 ${item.column} 列）</span>`);
  const parserBadge = preview.parserMode === "compatible" ? '<span class="mapping-warning"><b>兼容模式</b> · 未执行公式</span>' : "";
  const sourceBadge = preview.source?.type === "lark-sheet" ? `<span class="mapping-source"><b>飞书云表格</b> · ${escapeHtml(preview.source.title || preview.fileName)}</span>` : '<span class="mapping-source"><b>本地文件</b></span>';
  $("#authorMappingLine").innerHTML = `<strong>识别表头：第 ${preview.headerRow} 行</strong>${sourceBadge}${mappings.join("")}${parserBadge}`;
  const visibleRows = reviewRows.slice(0, 300);
  $("#authorReviewBody").innerHTML = visibleRows.map((row) => {
    const platformAccount = row.platform === "bilibili" ? (row.bilibiliId ? `B站 UID ${row.bilibiliId}` : "") : row.platform === "xiaohongshu" ? (row.xiaohongshuId ? `小红书 ID ${row.xiaohongshuId}` : "") : (row.douyinId ? `抖音号 ${row.douyinId}` : "");
    const relationFields = [
      ["平台", platformLabel(row.platform)], ["机构", row.organization], ["分层", row.tier], ["赛道", row.category],
      ["负责人", row.owner], ["填写日期", row.filledDate], ["备注", row.notes ?? row.note],
    ].filter(([, value]) => value);
    const evidenceFields = [
      ["主页 / 强身份", row.locator], ["平台账号", platformAccount], ["作品 ID", row.contentId || row.videoId],
      ["作品链接", row.videoLink], ["分享链接", row.shareUrl],
    ].filter(([, value], index, items) => value && items.findIndex(([, candidate]) => candidate === value) === index);
    const evidence = evidenceFields.length
      ? `<div class="review-evidence-list">${evidenceFields.map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`).join("")}</div>`
      : "—";
    const extra = relationFields.length
      ? `<div class="review-relation-list">${relationFields.map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`).join("")}</div>`
      : "—";
    const boards = targetBoardLabels(row, previewCatalog);
    return `<tr>
      <td data-label="源行">${row.sourceRow}</td>
      <td data-label="作者"><strong>${escapeHtml(row.name || "—")}</strong></td>
      <td data-label="主页 / 作品证据">${evidence}</td>
      <td data-label="板块"><div class="board-chip-list">${boards.map((label) => `<span class="board-chip ${label === "未分板块" ? "unassigned" : ""}">${escapeHtml(label)}</span>`).join("")}</div></td>
      <td data-label="作者信息">${extra}</td>
      <td data-label="审查结果"><span class="review-status ${escapeHtml(row.status)}">${escapeHtml(authorStatusLabel(row.status))}</span><small>${escapeHtml(row.reason)}</small></td>
    </tr>`;
  }).join("");
  const defaultCount = reviewRows.filter((row, index) => row !== preview.rows[index]).length;
  const boardNote = state.authorDefaultBoard ? `本次选择已补充 ${defaultCount} 行的空白板块；表格已有归属保持不变。` : "空白板块保留为“未分板块”。";
  $("#authorReviewFootnote").textContent = `${preview.rows.length > visibleRows.length ? `预览显示前 ${visibleRows.length} 行；全部 ${preview.rows.length} 行会重新校验。` : `共 ${preview.rows.length} 行；服务器会再次校验。`}${boardNote}板块不改变作者身份、启用状态和采集，缺失数据不会记成 0。`;
  const sheetSelect = $("#authorSheetSelect");
  sheetSelect.innerHTML = preview.sheets.map((sheet) => `<option value="${escapeHtml(sheet.name)}" ${sheet.name === preview.selectedSheet ? "selected" : ""}>${escapeHtml(sheet.name)} · ${sheet.rowCount} 行</option>`).join("");
  sheetSelect.disabled = preview.sheets.length <= 1;
  const commitButton = $("#authorCommitButton");
  commitButton.classList.remove("hidden");
  const autoMonitorAuthors = summary.autoMonitorAuthors || summary.importableRows;
  const identityConflictAuthors = summary.identityConflictAuthors || summary.identityConflictRows || 0;
  const needsLocatorRows = summary.needsLocatorRows || 0;
  const manualReviewLabel = authorManualReviewLabel(needsLocatorRows, identityConflictAuthors);
  commitButton.disabled = autoMonitorAuthors === 0 && !manualReviewLabel;
  commitButton.textContent = autoMonitorAuthors
    ? `提交 ${autoMonitorAuthors} 条身份核验线索${manualReviewLabel ? ` · 保存审查：${manualReviewLabel}` : ""}`
    : manualReviewLabel ? `保存审查：${manualReviewLabel}` : "没有可核验或保存审查的作者";
  $("#authorPreviewButton").disabled = false;
  $("#authorPreviewButton").textContent = "重新读取并审查";
  const sourceProof = preview.source?.type === "lark-sheet" ? ` · 修订 ${preview.source.revision || "—"} · ${preview.source.dataRange || "范围待确认"}${preview.source.contentSha256 ? ` · 内容指纹 ${preview.source.contentSha256.slice(0, 12)}…` : ""}` : "";
  const identitySummary = !identityCountReady
    ? "作者身份数待确认；当前服务版本尚未提供严格身份计数"
    : summary.unresolvedIdentityRows
    ? `${formatNumber(summary.knownUniqueAuthors || 0)} 个已有账号身份线索 · ${formatNumber(summary.unresolvedIdentityRows)} 行身份待核验；仅凭昵称或作品不能确认真实作者总数`
    : `${formatNumber(summary.uniqueAuthors ?? 0)} 位可按账号身份去重`;
  $("#authorUploadStatus").textContent = `${preview.source?.type === "lark-sheet" ? "飞书 · " : "本地 · "}${preview.fileName} · ${preview.selectedSheet}${sourceProof} · 完整读取 ${summary.totalRows} 行 · ${identitySummary}${summary.resolvableAuthors ? ` · ${summary.resolvableAuthors} 条进入公开证据核验` : ""}${summary.identityConflictRows ? ` · ${summary.identityConflictRows} 行身份冲突将保留审查记录` : ""}${summary.existingRows ? ` · ${summary.existingRows} 行已在监控` : ""}${summary.needsLocatorRows ? ` · ${summary.needsLocatorRows} 行只有名称或缺少可唯一确认的主页 / 账号证据：仅保存审查，绝不加入监控` : ""}${preview.validationWarnings?.length ? ` · ${preview.validationWarnings.join("；")}` : ""}`;
}

async function previewAuthorSpreadsheet(sheetName = "") {
  const file = $("#authorSpreadsheetFile").files[0];
  if (!file) throw new Error("请先选择 XLSX、CSV 或 TSV 文件");
  if (file.size > 8_000_000) throw new Error("文件超过 8MB 限制");
  const extension = file.name.toLowerCase().split(".").at(-1);
  if (!["xlsx", "xls", "xlsm", "xlsb", "csv", "tsv"].includes(extension)) throw new Error("仅支持 XLSX、XLS、XLSM、XLSB、CSV、TSV 文件");
  $("#authorFileName").textContent = `${file.name} · ${Math.max(1, Math.ceil(file.size / 1024))} KB`;
  const button = $("#authorPreviewButton");
  button.disabled = true; button.textContent = "正在读取…";
  $("#authorUploadStatus").textContent = "正在本机解析并审查字段…";
  try {
    if (state.authorFile !== file) {
      state.authorFile = file;
      state.authorFileBase64 = await fileToBase64(file);
    }
    const preview = await api("/api/author-spreadsheet/preview", {
      method: "POST",
      body: JSON.stringify({ fileName: file.name, contentBase64: state.authorFileBase64, ...(sheetName ? { sheetName } : {}) }),
    });
    state.authorSourceMode = "file";
    state.authorLarkUrl = null;
    renderAuthorReview(preview);
    return preview;
  } catch (error) {
    state.authorPreview = null;
    $("#authorCommitButton").classList.add("hidden");
    $("#authorReview").classList.add("hidden");
    $("#authorReviewEmpty").classList.remove("hidden");
    $("#authorUploadStatus").textContent = `读取失败：${error.message}`;
    throw error;
  } finally {
    button.disabled = false; button.textContent = "重新读取并审查";
  }
}

async function previewAuthorLarkSpreadsheet(sheetName = "") {
  const input = $("#authorLarkUrl");
  const url = input.value.trim();
  if (!url) throw new Error("请先粘贴飞书云表格链接");
  const button = $("#authorLarkPreviewButton");
  button.disabled = true; button.textContent = "正在完整读取…";
  $("#authorUploadStatus").textContent = "正在从飞书完整读取工作簿，并识别作者身份字段…";
  try {
    const preview = await api("/api/author-spreadsheet/lark-preview", {
      method: "POST",
      body: JSON.stringify({ url, ...(sheetName ? { sheetName } : {}) }),
    });
    state.authorSourceMode = "lark";
    state.authorLarkUrl = preview.source?.url || url;
    renderAuthorReview(preview);
    return preview;
  } catch (error) {
    state.authorPreview = null;
    $("#authorCommitButton").classList.add("hidden");
    $("#authorReview").classList.add("hidden");
    $("#authorReviewEmpty").classList.remove("hidden");
    $("#authorUploadStatus").textContent = `读取失败：${error.message}`;
    throw error;
  } finally {
    button.disabled = false; button.textContent = "读取并严格审查";
  }
}

function updateTargetFormMode() {
  const form = $("#targetForm");
  const type = form.type.value;
  const provider = form.provider.value;
  const platform = form.platform.value;
  $("#platformField").classList.toggle("hidden", type !== "account");
  form.platform.disabled = type !== "account";
  $("#locatorLabel").textContent = type !== "account" ? "话题标签" : platform === "bilibili" ? "B站 UID / 官方主页" : platform === "xiaohongshu" ? "小红书官方主页" : "完整主页 / 分享链接 / sec_uid";
  form.locator.placeholder = type !== "account" ? "例如：三角洲行动（# 可省略）" : platform === "bilibili" ? "数字 UID 或 https://space.bilibili.com/UID" : platform === "xiaohongshu" ? "https://www.xiaohongshu.com/user/profile/用户ID" : "粘贴抖音主页或分享链接";
  $("#locatorHelp").textContent = type !== "account" ? "只记录抖音公开返回的官方参与人数与播放量；接口没有字段时保留为空，不把账号池样本当作话题统计。" : platform === "bilibili" ? "使用 B站公开卡片、粉丝、WBI 投稿与作品详情接口，按 UID 校验身份。" : platform === "xiaohongshu" ? "只读取小红书官方主页公开数据并按内部用户 ID 校验；受限时自动重试，不借用个人登录态。" : "游客接口不能只靠昵称或纯抖音号稳定找人；请优先使用主页、作品 ID 或分享链接。";
  $("#providerNote").textContent = provider === "public-web" ? (type !== "account" ? "话题面板只显示官方参与人数、播放量及变化；公开接口未返回时显示—，不使用账号池命中作品/作者替代。" : platform === "bilibili" ? "B站使用公开 API 与本地 WBI 纯算签名；无需 Cookie、密钥、付费 API 或 AI。" : platform === "xiaohongshu" ? "小红书只解析官方主页公开初始数据；无需 API 密钥或付费服务，也不会复用个人浏览器会话。" : "抖音使用匿名 HTTP 公开接口与本地签名；每日监控和自动作者核验默认不启动浏览器，不读取个人登录 Cookie，不调用付费 API 或 AI。") : "手动目标不会参加定时采集，可随时通过“导入标准 JSON”写入。";
}

function authorQueueStateLabel(status) {
  return ({ pending: "本条证据正在核验", retry: "本条证据等待自动重试", resolved: "本条证据已通过", rejected: "本条证据未通过" })[status] || status;
}

function renderAuthorQueue(data) {
  const summary = data.summary || {};
  const scopeLabel = state.authorQueueBoard === BOARD_ALL ? "全部板块" : state.authorQueueBoard === BOARD_UNASSIGNED ? "未分板块" : boardCatalog().find((board) => board.key === state.authorQueueBoard)?.label || state.authorQueueBoard;
  const truncated = state.authorQueueStatus === "all" && Number(summary.total || 0) > Number(data.items?.length || 0)
    ? ` 当前显示前 ${formatNumber(data.items.length)} / ${formatNumber(summary.total)} 条。`
    : "";
  $("#authorQueueSummary").innerHTML = `<strong>${escapeHtml(scopeLabel)} · 身份与作品证据核验明细</strong><span>自动处理中（含重试）${formatNumber(summary.pending || 0)} 条 · 已通过 ${formatNumber(summary.resolved || 0)} 条 · 未通过 ${formatNumber(summary.rejected || 0)} 条。按作品证据逐条统计，不等于未监控作者人数；同一作者可有多条记录。每条都显示来源行、证据、下一步和原因，账号启用状态以监控列表为准。${escapeHtml(truncated)}</span>`;
  $$("[data-author-queue-status]").forEach((button) => {
    const active = button.dataset.authorQueueStatus === state.authorQueueStatus;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#authorQueueList").innerHTML = data.items?.length ? data.items.map((item) => {
    const evidenceHtml = authorEvidenceHtml(item);
    const platform = item.platform || "douyin";
    const accountLabel = item.submittedAccountId
      ? `${platform === "bilibili" ? "B站 UID" : platform === "xiaohongshu" ? "小红书 ID" : "抖音号"} ${item.submittedAccountId}`
      : item.accountLocator ? `强身份 ${item.accountLocator}` : "";
    const accountHtml = accountLabel ? escapeHtml(accountLabel) : "";
    const boardDetails = (item.boardDetails || []).map((board) => {
      const relation = [["机构", board.organization], ["分层", board.tier], ["赛道", board.category], ["负责人", board.owner], ["填写日期", board.filledDate], ["备注", board.note]]
        .filter(([, value]) => value).map(([label, value]) => `${label} ${value}`).join(" · ");
      return `${board.name}${relation ? `（${relation}）` : ""}`;
    });
    const source = [item.fileName, item.sheetName, item.sourceRows?.length ? `第 ${item.sourceRows.join("、")} 行` : ""].filter(Boolean).join(" · ");
    const reasonHtml = item.lastError
      ? humanizedWarningHtml(item.lastError)
      : escapeHtml(item.status === "resolved" ? "本条公开证据与账号身份一致；账号启用状态以监控列表为准。" : "后台正在读取官方公开证据。");
    const next = ["pending", "retry"].includes(item.status) ? `下次自动处理：${formatDate(item.nextAttemptAt)}` : `最后更新：${formatDate(item.updatedAt)}`;
    const classificationChips = (item.classification?.labels || []).map((label) => `<span class="product-classification-chip product-classification-chip--${escapeHtml(label.color || "slate")}">${escapeHtml(label.label)}</span>`).join("") || '<span class="product-classification-chip product-classification-chip--slate">待分类</span>';
    return `<article class="author-queue-item ${escapeHtml(item.status)}">
      <div class="author-queue-main"><strong>${escapeHtml(item.name || item.submittedAccountId || "未命名作者")}</strong><div class="product-classification-chips">${classificationChips}</div><small>${escapeHtml(platformLabel(platform))}${accountHtml ? ` · ${accountHtml}` : ""}</small><small>${evidenceHtml}</small>${boardDetails.length ? `<small>板块：${boardDetails.map(escapeHtml).join("；")}</small>` : ""}<span>来源：${escapeHtml(source || "未记录")}</span></div>
      <div class="author-queue-result"><b>${escapeHtml(authorQueueStateLabel(item.status))}</b><p>${reasonHtml}</p><small>${escapeHtml(next)} · 已尝试 ${formatNumber(item.attempts)} 次</small></div>
    </article>`;
  }).join("") : '<div class="empty-inline">当前筛选状态下没有证据核验记录。</div>';
}

async function openAuthorQueueDialog(status = state.authorQueueStatus, board = state.authorQueueBoard) {
  state.authorQueueStatus = status;
  state.authorQueueBoard = board;
  const requestId = ++state.authorQueueRequest;
  const dialog = $("#authorQueueDialog");
  openDialog(dialog);
  $("#authorQueueList").innerHTML = '<div class="empty-inline">正在读取每条核验记录…</div>';
  try {
    const result = await api(`/api/author-resolution-queue?status=${encodeURIComponent(status)}&limit=500${board !== BOARD_ALL ? `&board=${encodeURIComponent(board)}` : ""}`);
    if (requestId === state.authorQueueRequest) renderAuthorQueue(result);
  } catch (error) {
    if (requestId !== state.authorQueueRequest) return;
    $("#authorQueueList").innerHTML = `<div class="empty-inline">读取失败：${escapeHtml(error.message)}</div>`;
  }
}

function actionLabel(action) {
  return ({
    "session.local": "本机管理员建立会话", "session.logout": "退出账号", "invite.join": "通过邀请码加入",
    "invite.create": "创建邀请码", "invite.revoke": "撤销邀请码", "member.update": "更新成员权限",
    "target.create": "新增监控对象", "target.update": "更新监控对象", "target.delete": "删除监控与历史",
    "authors.import": "导入作者表格", "authors.auto-monitor.start": "启动作者自动核验", "authors.auto-monitor.complete": "完成作者自动核验并监控", "board.create": "新建板块", "data.ingest": "导入标准数据", "sync.run": "执行采集同步", "settings.update": "更新系统设置",
  })[action] || action;
}

function renderAccess(accessData) {
  state.access = accessData;
  $("#onlineCount").textContent = `${accessData.onlineCount} 人在线`;
  const shareOrigin = preferredShareOrigin();
  const isPublicOrigin = Boolean(shareOrigin && isPublicShareOrigin(shareOrigin));
  const shareHint = shareEntryHint({ origin: shareOrigin, publicEntry: accessData.publicEntry });
  $("#lanUrlList").innerHTML = shareOrigin
    ? `<code>${escapeHtml(shareOrigin)}</code><small class="form-note access-share-hint">${escapeHtml(shareHint)}</small>${!isPublicOrigin && accessData.lanUrls.length ? `<details class="access-lan-fallback"><summary>查看本机局域网地址（仅同一网络可用）</summary>${accessData.lanUrls.map((url) => `<code>${escapeHtml(url)}</code>`).join("")}</details>` : ""}`
    : '<span class="form-note">当前页面没有可分享的地址，请从管理员分享的 HTTPS 入口打开。</span>';
  $("#memberList").innerHTML = accessData.members.map((member) => {
    const isOwner = member.authSource === "local-owner";
    return `<div class="access-row"><div class="access-row-copy"><strong><span class="member-presence ${member.activeSessionCount ? "online" : ""}"></span>${escapeHtml(member.displayName)}</strong><small>${isOwner ? "本机管理员 · 不可停用" : `${roleLabel(member.role)} · ${member.enabled ? "已启用" : "已停用"}`} · ${member.lastSeenAt ? `最近 ${escapeHtml(formatDate(member.lastSeenAt))}` : "尚未活动"}</small></div><div class="access-row-actions">${isOwner ? '<span class="status-pill validated">管理员</span>' : `<select data-member-role="${member.id}" ${member.enabled ? "" : "disabled"}><option value="viewer" ${member.role === "viewer" ? "selected" : ""}>查看者</option><option value="editor" ${member.role === "editor" ? "selected" : ""}>编辑者</option></select><button class="mini-button" data-member-toggle="${member.id}" data-enabled="${member.enabled}" type="button">${member.enabled ? "停用" : "启用"}</button>`}</div></div>`;
  }).join("") || '<div class="empty-inline">暂无成员</div>';
  $("#inviteList").innerHTML = accessData.invites.map((invite) => {
    const ended = invite.revoked || invite.expired || invite.useCount >= invite.maxUses;
    const stateText = invite.revoked ? "已撤销" : invite.expired ? "已过期" : invite.useCount >= invite.maxUses ? "已用完" : "有效";
    return `<div class="access-row"><div class="access-row-copy"><strong>${escapeHtml(invite.label || `${roleLabel(invite.role)}邀请`)}</strong><small>${roleLabel(invite.role)} · ${invite.useCount}/${invite.maxUses} 人 · ${stateText} · 到期 ${escapeHtml(formatDate(invite.expiresAt))}</small></div><div class="access-row-actions">${ended ? `<span class="form-note">${stateText}</span>` : `<button class="mini-button" data-invite-revoke="${invite.id}" type="button">撤销</button>`}</div></div>`;
  }).join("") || '<div class="empty-inline">尚未生成邀请码</div>';
  $("#activityList").innerHTML = accessData.activity.map((item) => `<div class="activity-row"><time>${escapeHtml(formatDate(item.created_at))}</time><span><strong>${escapeHtml(item.actor_name)}</strong> · ${escapeHtml(actionLabel(item.action))}</span></div>`).join("") || '<div class="empty-inline">暂无操作记录</div>';
}

async function openAccessDialog() {
  const dialog = $("#accessDialog");
  $("#logoutButton").classList.toggle("hidden", Boolean(state.auth?.localOwner));
  if (!state.auth?.permissions?.administer) {
    $("#accessAdminPanel").classList.add("hidden");
    $("#accessMemberSummary").classList.remove("hidden");
    $("#onlineCount").textContent = "受保护的协作会话";
    $("#memberRoleSummary").textContent = roleLabel(state.auth.user.role);
    $("#memberPermissionSummary").textContent = state.auth.permissions.edit ? "可以查看报告、上传作者表格，并对异常对象发起单项核验；不能删除历史数据、调整设置或管理成员。" : "可以查看看板、报告与导出数据；不能发起采集或修改任何内容。";
    return openDialog(dialog);
  }
  $("#accessAdminPanel").classList.remove("hidden");
  $("#accessMemberSummary").classList.add("hidden");
  const optimisticOrigin = preferredShareOrigin();
  if (optimisticOrigin) {
    $("#lanUrlList").innerHTML = `<code>${escapeHtml(optimisticOrigin)}</code><small class="form-note access-share-hint">正在确认成员权限；这是当前页面地址，远程成员请使用 HTTPS 入口。</small>`;
  }
  openDialog(dialog);
  try {
    renderAccess(await api("/api/access"));
  } catch (error) {
    const fallback = preferredShareOrigin();
    $("#lanUrlList").innerHTML = fallback
      ? `<code>${escapeHtml(fallback)}</code><small class="form-note access-share-hint">成员列表暂时读取失败：${escapeHtml(error.message)}。这是局域网备用地址，公网分享前请重新确认 HTTPS 入口。</small>`
      : `<small class="form-note access-share-hint">成员列表暂时读取失败：${escapeHtml(error.message)}。请关闭后重试。</small>`;
    toast(error.message, "error");
  }
}

function preferredShareOrigin() {
  return resolveShareOrigin({ currentOrigin: location.origin, publicBaseUrl: state.access?.publicBaseUrl,
    publicEntry: state.access?.publicEntry, lanUrls: state.access?.lanUrls });
}

async function initializeAuth() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (hash.get("invite")) $("#joinForm").elements.code.value = hash.get("invite");
  try {
    const session = await api("/api/auth/session");
    if (!session.authenticated) return showAuthRequired("请输入管理员提供的邀请码");
    setAuthenticated(session);
    await refresh();
  } catch (error) {
    if (error.status === 401) showAuthRequired("请输入管理员提供的邀请码");
    else showAuthRequired(`连接身份服务失败：${error.message}`);
  }
}

function bindEvents() {
  const targetDialog = $("#targetDialog");
  const settingsDialog = $("#settingsDialog");
  const importDialog = $("#importDialog");
  const authorSpreadsheetDialog = $("#authorSpreadsheetDialog");
  window.addEventListener("hashchange", () => syncLocationState("smooth"));
  window.addEventListener("popstate", () => syncLocationState("auto"));
  $("#userAccessButton").addEventListener("click", openAccessDialog);
  $("#teamAccessCard")?.addEventListener("click", openAccessDialog);
  $("#joinForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true; button.textContent = "正在验证…";
    try {
      const values = Object.fromEntries(new FormData(form));
      setAuthenticated(await api("/api/auth/join", { method: "POST", body: JSON.stringify(values) }));
      const preservedHash = ["#overview", "#boards", "#topics", "#targets", "#updates", "#reports", "#audit"].includes(location.hash) ? location.hash : "#overview";
      history.replaceState(null, "", `${location.pathname}${location.search}${preservedHash}`);
      await refresh();
      toast("已安全进入工作台");
    } catch (error) {
      $("#joinStatus").textContent = error.message;
    } finally { button.disabled = false; button.textContent = "验证并进入 →"; }
  });
  ["#addTargetButton", "#addTargetSecondary"].forEach((selector) => $(selector)?.addEventListener("click", () => openDialog(targetDialog)));
  ["#settingsButton", "#healthSettingsButton"].forEach((selector) => $(selector)?.addEventListener("click", () => { openDialog(settingsDialog); renderSavedCollectorProbe(); }));
  $("#runtimeAuditButton")?.addEventListener("click", refreshRuntimeAudit);
  $("#productFeedback")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-bootstrap-retry]")) refresh({ quiet: false });
  });
  $("#lastRunError")?.addEventListener("click", () => {
    if ($("#lastRunError").disabled) return;
    state.targetFilter = "attention";
    state.targetPage = 0;
    productDashboard.filter("missing");
    if (location.hash !== "#targets") location.hash = "#targets";
    else alignCurrentHash("smooth");
  });
  $("#importButton")?.addEventListener("click", () => openDialog(importDialog));
  ["#authorSpreadsheetButton", "#authorSpreadsheetHeaderButton", "#emptyAddButton"].forEach((selector) => $(selector)?.addEventListener("click", () => openProductImport()));
  $("#authorQueueButton").addEventListener("click", () => openAuthorQueueDialog("all", state.boardSelection));
  $$("[data-author-queue-status]").forEach((button) => button.addEventListener("click", () => openAuthorQueueDialog(button.dataset.authorQueueStatus)));
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => closeDialog(button.closest("dialog"))));
  $$("input[name=type]", $("#targetForm")).forEach((input) => input.addEventListener("change", updateTargetFormMode));
  $("#providerSelect").addEventListener("change", updateTargetFormMode);
  $("#platformSelect").addEventListener("change", updateTargetFormMode);
  $$('[data-board-select]').forEach((control) => control.addEventListener("change", (event) => selectBoard(event.currentTarget.value)));
  $$('[data-board-choices]').forEach((element) => element.addEventListener("click", (event) => {
    const button = event.target.closest("[data-board-choice]");
    if (button) selectBoard(button.dataset.boardChoice);
  }));
  $$('[data-board-import]').forEach((button) => button.addEventListener("click", () => {
    state.authorDefaultBoard = [BOARD_ALL, BOARD_UNASSIGNED].includes(state.boardSelection) ? "" : state.boardSelection;
    renderAuthorBoardChoices();
    if (state.authorPreview) renderAuthorReview(state.authorPreview);
    openDialog(authorSpreadsheetDialog);
  }));
  $$('[data-board-queue]').forEach((button) => button.addEventListener("click", () => openAuthorQueueDialog("all", state.boardSelection)));
  $$('[data-create-board]').forEach((button) => button.addEventListener("click", () => {
    $("#createBoardStatus").textContent = "创建后立即显示；作者名单和历史数据保持不变。";
    openDialog($("#createBoardDialog"));
  }));
  $("#createBoardForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#createBoardSubmit");
    button.disabled = true;
    try {
      const result = await api("/api/boards", { method: "POST", body: JSON.stringify({ name: $("#createBoardName").value.trim() }) });
      state.data.boards = result.boards;
      if (authorSpreadsheetDialog.open) state.authorDefaultBoard = result.board.key;
      renderBoardControls();
      if (state.authorPreview) renderAuthorReview(state.authorPreview);
      closeDialog($("#createBoardDialog"));
      event.target.reset();
      if (!authorSpreadsheetDialog.open) await selectBoard(result.board.key);
      toast(`已创建板块“${result.board.name}”`);
    } catch (error) {
      $("#createBoardStatus").textContent = `创建失败：${error.message}`;
    } finally { button.disabled = false; }
  });
  $$(".report-tabs button").forEach((button) => button.addEventListener("click", () => { state.period = button.dataset.period; renderReports(); hydrateBoardReports(); }));
  $("#dailyReportSelect").addEventListener("change", async (event) => {
    const control = event.currentTarget;
    const reference = control.value;
    if (!reference || reference === state.dailyReportReference) return;
    control.disabled = true;
    try {
      if (!state.dailyReportCache[reference]) {
        const boardQuery = state.boardSelection !== BOARD_ALL ? `&board=${encodeURIComponent(state.boardSelection)}` : "";
        state.dailyReportCache[reference] = await api(`/api/reports/day?date=${encodeURIComponent(reference)}${boardQuery}`);
      }
      state.dailyReportReference = reference;
      state.dailyReportPinned = true;
      renderReports();
      hydrateBoardReports();
    } catch (error) {
      toast(`日报读取失败：${error.message}`, "error");
      renderReports();
    } finally {
      control.disabled = false;
    }
  });
  $$(".contributor-tabs button").forEach((button) => button.addEventListener("click", () => { state.contributorMetric = button.dataset.contributorMetric; renderReports(); }));
  $("#contributorList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-contributor-target]");
    if (button) {
      const targetId = Number(button.dataset.contributorTarget);
      const growthEvidence = selectedReport().contributors?.find((item) => Number(item.targetId) === targetId) || null;
      accountDetail.open(targetId, productDashboard.options());
    }
  });
  $$(".nav-links a").forEach((link) => link.addEventListener("click", () => {
    $$(".nav-links a").forEach((item) => item.classList.toggle("active", item.getAttribute("href") === link.getAttribute("href")));
  }));
  $("#targetSearch")?.addEventListener("input", (event) => {
    state.targetQuery = event.currentTarget.value;
    state.targetPage = 0;
    renderTargets();
  });
  $$(".target-filter").forEach((button) => button.addEventListener("click", () => {
    state.targetFilter = button.dataset.targetFilter;
    state.targetPage = 0;
    renderTargets();
  }));
  $("#targetSort")?.addEventListener("change", (event) => {
    state.targetSort = event.currentTarget.value;
    state.targetPage = 0;
    renderTargets();
  });
  $("#targetPrev")?.addEventListener("click", () => {
    state.targetPage = Math.max(0, state.targetPage - 1);
    renderTargets();
  });
  $("#targetNext")?.addEventListener("click", () => {
    state.targetPage += 1;
    renderTargets();
  });

  $("#targetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      await api("/api/targets", { method: "POST", body: JSON.stringify({ type: values.type, label: values.label, locator: values.locator, provider: values.provider, metadata: { platform: values.type === "account" ? values.platform : "douyin" } }) });
      form.reset(); updateTargetFormMode(); closeDialog(targetDialog); toast("监控对象已保存"); await refresh({ quiet: true });
    } catch (error) { toast(error.message, "error"); }
  });

  $("#targetsBody")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const id = Number(button.dataset.id);
    if (button.dataset.action === "status") return openTargetStatus(id);
    if (button.dataset.action === "sync") return sync(id);
    if (button.dataset.action === "toggle") {
      try { await api(`/api/targets/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: button.dataset.enabled !== "true" }) }); toast("监控状态已更新"); await refresh({ quiet: true }); } catch (error) { toast(error.message, "error"); }
    }
    if (button.dataset.action === "delete") {
      const target = state.data.targets.find((item) => item.id === id);
      if (!confirm(`确认删除“${target?.label || "该目标"}”及其本地历史数据？此操作不可撤销。`)) return;
      try { await api(`/api/targets/${id}`, { method: "DELETE" }); toast("监控对象及本地历史已删除"); await refresh({ quiet: true }); } catch (error) { toast(error.message, "error"); }
    }
  });

  $("#auditFeed").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-audit-detail]");
    if (!button) return;
    const audit = state.data.audits[Number(button.dataset.auditDetail)];
    if (!audit) return;
    if (audit.target_id) return openTargetStatus(audit.target_id);
    renderStatusDialog({ target: { label: "批量作者导入", provider: audit.provider, last_status: audit.status }, audits: [audit] });
  });

  $("#statusSyncButton").addEventListener("click", () => {
    const id = Number($("#statusSyncButton").dataset.id);
    closeDialog($("#statusDialog"));
    if (id) sync(id);
  });

  $("#settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api("/api/settings", { method: "POST", body: JSON.stringify(values) }); closeDialog(settingsDialog); toast("设置已保存"); await refresh({ quiet: true }); } catch (error) { toast(error.message, "error"); }
  });

  $("#testPublicCollectorButton").addEventListener("click", async () => {
    const button = $("#testPublicCollectorButton");
    button.disabled = true; button.textContent = "正在连接…";
    renderCollectorProbe({ loading: true });
    try {
      const response = await api("/api/providers/public-web/test", { method: "POST", body: "{}" });
      const result = response.result || {};
      state.data.publicProbe = response.probe || { ok: true, result, checkedAt: new Date().toISOString() };
      renderCollectorProbe({ result, checkedAt: state.data.publicProbe.checkedAt });
      const hotStatus = result.hotEndpoint ? "热榜通过" : "热榜未通过";
      toast(result.postsEndpoint ? `公开链路可用：${result.nickname}，主页、作品、${hotStatus}` : `主页与${hotStatus}；作品接口当前受限，已启用历史保护`, result.postsEndpoint ? "success" : "error");
    } catch (error) {
      if (error.payload?.probe) {
        state.data.publicProbe = error.payload.probe;
        renderSavedCollectorProbe();
      } else renderCollectorProbe({ error });
      toast(error.message, "error");
    }
    finally { button.disabled = false; button.textContent = "测试公开采集链路"; }
  });

  $("#importForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      const payload = JSON.parse(values.payload);
      const result = await api("/api/ingest", { method: "POST", body: JSON.stringify({ targetId: Number(values.targetId), data: payload }) });
      closeDialog(importDialog); form.reset(); toast(`已校验并写入 ${result.postCount} 条作品${result.warnings.length ? `，${result.warnings.length} 条警告` : ""}`); await refresh({ quiet: true });
    } catch (error) { toast(`导入失败：${error.message}`, "error"); }
  });

  $("#authorSpreadsheetFile").addEventListener("change", async () => {
    state.authorFile = null; state.authorFileBase64 = null; state.authorSourceMode = "file"; resetAuthorReview();
    try { await previewAuthorSpreadsheet(); } catch (error) { toast(error.message, "error"); }
  });
  $("#authorChooseFileButton").addEventListener("click", () => {
    const input = $("#authorSpreadsheetFile");
    $("#authorUploadStatus").textContent = "请选择本地作者表格；选择后会自动读取并严格审查。";
    input.click();
  });
  $("#authorDefaultBoard").addEventListener("change", (event) => {
    state.authorDefaultBoard = event.currentTarget.value;
    renderAuthorBoardChoices();
    if (state.authorPreview) renderAuthorReview(state.authorPreview);
  });
  $("#authorLarkPreviewButton").addEventListener("click", async () => {
    try { await previewAuthorLarkSpreadsheet(); } catch (error) { toast(error.message, "error"); }
  });
  $("#authorLarkUrl").addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    try { await previewAuthorLarkSpreadsheet(); } catch (error) { toast(error.message, "error"); }
  });
  $("#authorPreviewButton").addEventListener("click", async () => {
    try {
      if (state.authorSourceMode === "lark") await previewAuthorLarkSpreadsheet($("#authorSheetSelect").value);
      else await previewAuthorSpreadsheet($("#authorSheetSelect").value);
    } catch (error) { toast(error.message, "error"); }
  });
  $("#authorSheetSelect").addEventListener("change", async (event) => {
    try {
      if (state.authorSourceMode === "lark") await previewAuthorLarkSpreadsheet(event.currentTarget.value);
      else await previewAuthorSpreadsheet(event.currentTarget.value);
    } catch (error) { toast(error.message, "error"); }
  });
  $("#authorSpreadsheetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const preview = state.authorPreview;
    const autoMonitorAuthors = preview?.summary?.autoMonitorAuthors || preview?.summary?.importableRows || 0;
    const identityConflictAuthors = preview?.summary?.identityConflictAuthors || preview?.summary?.identityConflictRows || 0;
    const needsLocatorRows = preview?.summary?.needsLocatorRows || 0;
    const manualReviewLabel = authorManualReviewLabel(needsLocatorRows, identityConflictAuthors);
    if (!preview || (!autoMonitorAuthors && !manualReviewLabel)) return;
    const button = $("#authorCommitButton");
    button.disabled = true;
    button.textContent = autoMonitorAuthors
      ? `正在提交 ${autoMonitorAuthors} 条身份核验线索…`
      : `正在保存审查：${manualReviewLabel}…`;
    try {
      const job = await api("/api/author-spreadsheet/auto-monitor", {
        method: "POST",
        body: JSON.stringify({
          fileName: preview.fileName,
          sheetName: preview.selectedSheet,
          rows: preview.rows,
          defaultBoard: authorDefaultBoardName(),
          boardCatalog: preview.boardCatalog || [],
          ...(preview.source?.type === "lark-sheet" ? {
            sourceType: "lark-sheet",
            sourceUrl: preview.source.url,
            sourceTitle: preview.source.title,
            sourceRevision: preview.source.revision,
            sourceSheetId: preview.source.selectedSheetId,
            sourceRange: preview.source.dataRange,
            sourceSha256: preview.source.contentSha256,
            sourceExportSha256: preview.source.exportSha256,
            sourceReadAt: preview.source.readAt,
          } : {}),
        }),
      });
      closeDialog(authorSpreadsheetDialog);
      $("#authorSpreadsheetForm").reset();
      state.authorFile = null; state.authorFileBase64 = null; state.authorSourceMode = null; state.authorLarkUrl = null; state.authorDefaultBoard = ""; resetAuthorReview();
      await refresh({ quiet: true });
      toast(autoMonitorAuthors
        ? `已提交 ${autoMonitorAuthors} 条公开身份核验线索；只有核验到明确账号身份的作者才会加入监控${manualReviewLabel ? `；${manualReviewLabel}仅保存审查` : ""}。`
        : `已保存审查：${manualReviewLabel}；这些行不会加入监控。请下载完整问题清单，补充主页、账号 ID 或可核验作品后重新读取。`);
    } catch (error) {
      toast(`自动核验失败：${error.message}`, "error");
      $("#authorUploadStatus").textContent = `自动核验失败：${error.message}`;
      button.disabled = false;
      button.textContent = autoMonitorAuthors
        ? `提交 ${autoMonitorAuthors} 条身份核验线索${manualReviewLabel ? ` · 保存审查：${manualReviewLabel}` : ""}`
        : `保存审查：${manualReviewLabel}`;
    }
  });

  $("#inviteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      // Read the access record before creating the code: a Quick Tunnel can
      // rotate while this dialog is open, and links must use a fresh matching
      // heartbeat rather than a stale origin in the page or cached state.
      let latestAccess = await api("/api/access");
      renderAccess(latestAccess);
      const initialOrigin = resolveShareOrigin({ currentOrigin: location.origin,
        publicBaseUrl: latestAccess.publicBaseUrl, publicEntry: latestAccess.publicEntry, lanUrls: latestAccess.lanUrls });
      if (!initialOrigin) throw new Error("当前没有可用的分享入口；请先确认管理员 HTTPS 入口或重新启动临时公网入口，再创建邀请码");
      const invite = await api("/api/access/invites", { method: "POST", body: JSON.stringify(values) });
      try { latestAccess = await api("/api/access"); renderAccess(latestAccess); } catch { /* retain the one-time code in the link field */ }
      const origin = resolveShareOrigin({ currentOrigin: location.origin,
        publicBaseUrl: latestAccess?.publicBaseUrl || state.access?.publicBaseUrl,
        publicEntry: latestAccess?.publicEntry || state.access?.publicEntry,
        lanUrls: latestAccess?.lanUrls || state.access?.lanUrls });
      if (!origin) throw new Error("邀请码已生成，但当前没有可用的入口地址；请先启动公网 HTTPS 入口后重试复制链接");
      const link = `${origin}/#invite=${encodeURIComponent(invite.code)}`;
      $("#inviteShareLink").value = link;
      $("#inviteResult").classList.remove("hidden");
      await refresh({ quiet: true });
      toast(isPublicShareOrigin(origin) ? "邀请码已生成；链接使用最新公网 HTTPS 入口，原始码只在这里显示一次" : "邀请码已生成；当前链接仅限局域网，原始码只在这里显示一次");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#copyInviteButton").addEventListener("click", async () => {
    const input = $("#inviteShareLink");
    try { await navigator.clipboard.writeText(input.value); toast("邀请链接已复制"); }
    catch { input.select(); document.execCommand("copy"); toast("邀请链接已复制"); }
  });
  $("#memberList").addEventListener("change", async (event) => {
    const select = event.target.closest("select[data-member-role]");
    if (!select) return;
    try { await api(`/api/access/members/${select.dataset.memberRole}`, { method: "PATCH", body: JSON.stringify({ role: select.value }) }); renderAccess(await api("/api/access")); toast("成员权限已更新"); }
    catch (error) { toast(error.message, "error"); }
  });
  $("#memberList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-member-toggle]");
    if (!button) return;
    const enabled = button.dataset.enabled === "true";
    try { await api(`/api/access/members/${button.dataset.memberToggle}`, { method: "PATCH", body: JSON.stringify({ enabled: !enabled }) }); renderAccess(await api("/api/access")); toast(enabled ? "成员已停用，现有会话已失效" : "成员已启用"); }
    catch (error) { toast(error.message, "error"); }
  });
  $("#inviteList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-invite-revoke]");
    if (!button) return;
    try { await api(`/api/access/invites/${button.dataset.inviteRevoke}`, { method: "DELETE" }); renderAccess(await api("/api/access")); toast("邀请码已撤销"); }
    catch (error) { toast(error.message, "error"); }
  });
  $("#logoutButton").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); closeDialog($("#accessDialog")); showAuthRequired("已退出，请使用邀请码重新进入"); }
    catch (error) { toast(error.message, "error"); }
  });
}

bindEvents();
updateTargetFormMode();
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const activeJobs = state.data?.authorResolutionJobs?.some((job) => ["queued", "running"].includes(job.status));
  const active = Boolean(state.data?.scheduler?.running || state.data?.authorResolutionQueue?.pending || activeJobs);
  refreshTimer = setTimeout(async () => {
    await refresh({ quiet: true });
    scheduleRefresh();
  }, active ? 15_000 : 60_000);
}
initializeAuth().finally(scheduleRefresh);

export const BOARD_ALL = "__all__";
export const BOARD_UNASSIGNED = "__unassigned__";

function clean(value) {
  return value === null || value === undefined ? "" : String(value).normalize("NFKC").trim();
}

function alias(value) {
  return clean(value).toLocaleLowerCase("zh-CN");
}

function isEnabledTarget(target) {
  return target?.enabled !== false && Number(target?.enabled) !== 0;
}

// Hashtag targets are rendered in the independent topic dashboard. They must
// never inflate account-board membership counts or leak into board reports.
function isAccountTarget(target) {
  return target?.type !== "hashtag";
}

function boardValues(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return [value.id, value.boardId, value.board_id, value.key, value.slug, value.name, value.label, value.title]
      .map(clean).filter(Boolean);
  }
  const text = clean(value);
  return text ? [text] : [];
}

export function rawTargetBoards(target = {}) {
  const candidates = [target.boards, target.board, target.boardNames, target.board_names, target.metadata?.boards, target.metadata?.board];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const values = candidate.filter((item) => boardValues(item).length);
      if (values.length) return values;
      continue;
    }
    if (boardValues(candidate).length) return [candidate];
  }
  return [];
}

// A batch choice fills blank source cells; it never replaces an explicit row membership.
export function rowsWithDefaultBoard(rows = [], defaultBoard = "") {
  const fallback = clean(defaultBoard);
  if (!fallback || [BOARD_ALL, BOARD_UNASSIGNED].includes(fallback)) return [...rows];
  return rows.map((row) => rawTargetBoards(row).length ? row : { ...row, board: fallback, boards: [fallback] });
}

export function createBoardCatalog(boards = [], targets = []) {
  const catalog = [];
  const byAlias = new Map();
  const add = (value) => {
    const values = boardValues(value);
    if (!values.length) return;
    const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const preferredKey = clean(object.id ?? object.boardId ?? object.board_id ?? object.key ?? object.slug ?? values[0]);
    const preferredLabel = clean(object.name ?? object.label ?? object.title ?? object.slug ?? values.at(-1));
    let item = values.map((entry) => byAlias.get(alias(entry))).find(Boolean);
    if (!item) {
      let key = preferredKey;
      let suffix = 2;
      while (catalog.some((entry) => entry.key === key)) key = `${preferredKey}-${suffix++}`;
      item = { key, label: preferredLabel || preferredKey, aliases: [] };
      catalog.push(item);
    }
    if (Number.isFinite(Number(object.queuedCount))) item.queuedCount = Math.max(0, Number(object.queuedCount));
    for (const entry of [...values, item.key, item.label]) {
      const normalized = alias(entry);
      if (!normalized) continue;
      if (!item.aliases.includes(normalized)) item.aliases.push(normalized);
      byAlias.set(normalized, item);
    }
  };
  (Array.isArray(boards) ? boards : []).forEach(add);
  (Array.isArray(targets) ? targets : []).filter((target) => isEnabledTarget(target) && isAccountTarget(target)).forEach((target) => rawTargetBoards(target).forEach(add));
  return catalog;
}

function resolveBoard(value, catalog) {
  const tokens = boardValues(value).map(alias);
  return catalog.find((board) => tokens.some((token) => board.aliases.includes(token))) || null;
}

export function targetBoardKeys(target, catalog = []) {
  const values = rawTargetBoards(target);
  if (!values.length) return [BOARD_UNASSIGNED];
  return [...new Set(values.map((value) => resolveBoard(value, catalog)?.key || boardValues(value)[0]).filter(Boolean))];
}

export function targetBoardLabels(target, catalog = []) {
  const keys = targetBoardKeys(target, catalog);
  return keys.map((key) => key === BOARD_UNASSIGNED ? "未分板块" : catalog.find((board) => board.key === key)?.label || key);
}

export function normalizeBoardSelection(value, catalog = []) {
  const text = clean(value);
  if (!text || text === BOARD_ALL) return BOARD_ALL;
  if (text === BOARD_UNASSIGNED) return BOARD_UNASSIGNED;
  return catalog.find((board) => board.key === text || board.aliases.includes(alias(text)))?.key || BOARD_ALL;
}

export function filterTargetsByBoard(targets = [], selection = BOARD_ALL, catalog = []) {
  const resolvedSelection = normalizeBoardSelection(selection, catalog);
  const accounts = targets.filter(isAccountTarget);
  if (resolvedSelection === BOARD_ALL) return [...accounts];
  return accounts.filter((target) => targetBoardKeys(target, catalog).includes(resolvedSelection));
}

export function boardCounts(targets = [], catalog = []) {
  const counts = new Map([[BOARD_UNASSIGNED, 0]]);
  catalog.forEach((board) => counts.set(board.key, 0));
  targets.filter((target) => isEnabledTarget(target) && isAccountTarget(target)).forEach((target) => targetBoardKeys(target, catalog).forEach((key) => counts.set(key, (counts.get(key) || 0) + 1)));
  return counts;
}

function numeric(value) {
  return value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
}

function sumKnown(values) {
  const known = values.map(numeric).filter((value) => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function targetId(value) {
  return clean(value?.targetId ?? value?.target_id ?? value?.id);
}

function reviewKey(target) {
  const status = target?.latestSnapshot?.status || target?.last_status || target?.status || "pending";
  const warnings = target?.latestSnapshot?.warnings || target?.latestWarnings || target?.warnings || [];
  const worksCoverage = target?.latestSnapshot?.worksCoverage || target?.worksCoverage || target?.works_coverage || "unknown";
  const text = Array.isArray(warnings) ? warnings.join("；") : clean(warnings);
  if (worksCoverage === "complete" && ["available", "partial", "unknown"].includes(String(target?.accountStatus || target?.latestSnapshot?.accountStatus || "unknown"))) return "validated";
  if (worksCoverage === "unknown") return "pending";
  if (status === "validated") return "validated";
  if (status === "warning" && /未识别到作品列表|作品列表接口未通过|HTTP\s*403|限流|空内容|失败|受限|超时|连续/.test(text)) return "retry";
  if (status === "warning") return "limited";
  if (status === "rejected") return "manual";
  if (status === "error") return "failed";
  return "pending";
}

function median(values) {
  const numbers = values.map(numeric).filter((value) => value !== null).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function percentile(values, quantile) {
  const numbers = values.map(numeric).filter((value) => value !== null).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const position = (numbers.length - 1) * Math.max(0, Math.min(1, Number(quantile) || 0));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return numbers[lower];
  return numbers[lower] + (numbers[upper] - numbers[lower]) * (position - lower);
}

export function scopeReportToBoard(report = {}, targets = [], catalog = [], selection = BOARD_ALL, options = {}) {
  const resolvedSelection = normalizeBoardSelection(selection, catalog);
  if (resolvedSelection === BOARD_ALL) return report;
  const scopedTargets = filterTargetsByBoard(targets.filter(isEnabledTarget), resolvedSelection, catalog);
  const ids = new Set(scopedTargets.map(targetId).filter(Boolean));
  const contributors = (report.contributors || []).filter((item) => ids.has(targetId(item)));
  const complete = options.complete !== false;
  const posts = complete ? (report.posts || []).filter((post) => ids.has(targetId(post))) : [];
  const statuses = scopedTargets.map(reviewKey);
  const followerDeltas = contributors.map((item) => item.followersDelta);
  const likeDeltas = contributors.map((item) => item.accountLikesDelta ?? item.likesDelta);
  const followersDelta = sumKnown(followerDeltas);
  const accountLikesDelta = sumKnown(likeDeltas);
  const fixedThreshold = numeric(options.viralLikeThreshold ?? report.summary?.viralThreshold) ?? 10_000;
  const relativeMultiplier = numeric(options.viralRelativeMultiplier) ?? 3;
  const observedPostLikes = complete ? posts.map((post) => numeric(post.likes)).filter((value) => value !== null) : [];
  const baseline = observedPostLikes.length ? Math.max(median(observedPostLikes), percentile(observedPostLikes, 0.6)) : 0;
  const relativeThreshold = observedPostLikes.length >= 5 ? Math.round(baseline * relativeMultiplier) : 0;
  const viralThreshold = Math.max(fixedThreshold, relativeThreshold);
  const viral = complete ? posts.filter((post) => {
    const likes = numeric(post.likes);
    return likes !== null && likes >= viralThreshold;
  }).sort((a, b) => numeric(b.likes) - numeric(a.likes)) : [];
  const activeIds = new Set(posts.map(targetId).filter(Boolean));
  const targetCount = scopedTargets.length;
  const worksCompleteRate = targetCount ? Math.round((statuses.filter((value) => value === "validated").length / targetCount) * 1000) / 10 : null;
  const worksUsableRate = targetCount ? Math.round((statuses.filter((value) => ["validated", "limited"].includes(value)).length / targetCount) * 1000) / 10 : null;
  const summary = {
    ...(report.summary || {}),
    targetCount,
    postCount: complete ? posts.length : null,
    authorCount: complete ? activeIds.size : null,
    activeTargetCount: complete ? activeIds.size : null,
    followersDelta,
    accountLikesDelta,
    estimatedPlaysDelta: accountLikesDelta === null ? null : accountLikesDelta * 100,
    followersComparableTargetCount: followerDeltas.map(numeric).filter((value) => value !== null).length,
    likesComparableTargetCount: likeDeltas.map(numeric).filter((value) => value !== null).length,
    growthCurrentTargetCount: contributors.length,
    followersFallbackBaselineTargetCount: contributors.filter((item) => item.followersBaselineMode === "first-in-period").length,
    likesFallbackBaselineTargetCount: contributors.filter((item) => item.accountLikesBaselineMode === "first-in-period" || item.likesBaselineMode === "first-in-period").length,
    profileObservedTargetCount: complete ? contributors.filter((item) => numeric(item.followersCurrent) !== null || numeric(item.accountLikesCurrent ?? item.likesCurrent) !== null).length : null,
    profileSnapshotTargetCount: complete ? contributors.length : null,
    validatedTargetCount: statuses.filter((value) => value === "validated").length,
    limitedTargetCount: statuses.filter((value) => value === "limited").length,
    retryTargetCount: statuses.filter((value) => value === "retry").length,
    manualTargetCount: statuses.filter((value) => value === "manual").length,
    manualActionTargetCount: statuses.filter((value) => value === "manual").length,
    failedTargetCount: statuses.filter((value) => value === "failed").length,
    pendingTargetCount: statuses.filter((value) => value === "pending").length,
    worksCompleteRate,
    worksUsableRate,
    // Compatibility alias retained for the report header and older exports.
    worksSuccessRate: worksUsableRate,
    successRateGate: worksUsableRate === null ? "unknown" : worksUsableRate >= Number(report.summary?.successRateFloor ?? 94) ? "pass" : "attention",
    likesCurrent: complete ? sumKnown(posts.map((post) => post.likes)) : null,
    likesObservedPostCount: complete ? observedPostLikes.length : null,
    likesMissingPostCount: complete ? posts.length - observedPostLikes.length : null,
    medianLikes: complete ? median(posts.map((post) => post.likes)) : null,
    viralCount: complete && observedPostLikes.length ? viral.length : null,
    viralThreshold,
    snapshotCount: null,
    sampledPostCount: null,
    newlyObservedPostCount: null,
    likesDelta: null,
    sampledDeltaPostCount: null,
    boardScoped: true,
    boardDataComplete: complete,
  };
  return { ...report, summary, contributors, posts, viral };
}

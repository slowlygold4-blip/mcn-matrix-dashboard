/**
 * Deterministic, explainable author classification.
 *
 * This intentionally does not call an AI service or infer a business category
 * from a nickname alone. Explicit spreadsheet category fields are strongest,
 * then board/source text, and finally the account label as a weak signal for
 * legacy content labels only (never AI/remix production or IP ownership). An
 * author can carry multiple labels; the UI may choose a primary label for
 * navigation while preserving all evidence.
 */

const RULES = Object.freeze([
  { key: "slice", label: "切片", color: "violet", terms: ["切片", "剪辑", "切片作者", "切片矩阵", "作品登记"] },
  { key: "original", label: "原创", color: "blue", terms: ["原创", "创作激励", "原创授权", "原创作者", "创作计划"] },
  { key: "ai-remix", label: "AI二创", color: "amber", terms: ["ai二创", "ai作者", "即梦", "aigc", "ai"] },
  { key: "remix", label: "二创", color: "violet", terms: ["二创", "二次创作"] },
  { key: "live-hotspot", label: "直播热点", color: "rose", terms: ["直播", "热点", "直播效果", "直播切片", "热榜"] },
  { key: "game", label: "游戏内容", color: "green", terms: ["游戏", "游戏解说", "三角洲", "吃鸡", "电竞"] },
]);

const CUSTOM_CATEGORY_RE = /[^\s,，、/|｜;；]+/g;
const CONTENT_CLAUSE_RE = /[,，、/|｜;；。]+/;
const AI_TERMS = RULES.find(rule => rule.key === "ai-remix").terms;
const KNOWN_CONTENT_TERMS = new Set(RULES.flatMap(rule => rule.terms));
const NON_CONTENT_LABELS = new Set([
  "未细分", "新人新号", "新人不是新号", "抖音主播", "团团", "杨齐家", "老飞宇", "玉麒麟", "安澜", "极煌", "7jia", "奶团",
]);

// Keep ownership, management tier, and future intent out of the content-type
// filter. Those facts remain in their source roster fields as separate axes.
export function isContentClassificationLabel(value) {
  const label = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  if (!label || NON_CONTENT_LABELS.has(label)
    || /^(?:超?头部|中腰部|腰部|尾部|腰尾部|长尾)$/.test(label)
    || /^(?:账号名称|作者名称|主播名称)[:：]/.test(label)
    || /^(?:未来|后续|以后|将来|计划|打算|准备|考虑|可能|希望|拟|想做|想学)/.test(label)) return false;
  return true;
}

// Only explicit category/tier answers may have layout spaces inside a whole
// known token ("切 片+A I"). Do not globally collapse prose or English words:
// negation/plans remain intact and must still pass the evidence guards below.
function explicitContentMatchText(value) {
  return value.split(/([+,，、/|｜;；。]+)/).map(segment => {
    const compact = segment.replace(/\s+/g, "").toLowerCase();
    return KNOWN_CONTENT_TERMS.has(compact) ? compact : segment;
  }).join("");
}

function aiEvidenceTerms(value) {
  const hits = new Set();
  for (const clause of value.split(CONTENT_CLAUSE_RE)) {
    for (const term of AI_TERMS) {
      for (let index = clause.indexOf(term); index !== -1; index = clause.indexOf(term, index + term.length)) {
        // An English substring (daily/email/chair) is not an AI declaration.
        if (/^[a-z]/.test(term) && /[a-z0-9]/.test(clause[index - 1] || "")) continue;
        if (/[a-z]$/.test(term) && /[a-z0-9]/.test(clause[index + term.length] || "")) continue;
        const before = clause.slice(0, index);
        // Source text can describe an intention, not current production.
        // Keep the original field as evidence; do not turn it into an AI tag.
        if (/(?:未来|后续|以后|将来|计划|打算|准备|考虑|可能|希望|拟|想做|想学).{0,24}$/.test(before)) continue;
        if (/(?:非|不是|不做|不用|不使用|不采用|未做|未使用|没有做|没有使用|尚未做|尚未使用|暂无)\s*$/.test(before)) continue;
        hits.add(term);
      }
    }
  }
  return [...hits];
}

const NON_AI_TERMS = [...new Set(RULES.filter(rule => rule.key !== "ai-remix").flatMap(rule => rule.terms))].sort((a, b) => b.length - a.length);
const CONTENT_NEGATION_RE = new RegExp(`(?:不是|不属于|没有做|尚未做|不做|未做|暂无|非)\\s*(?:${NON_AI_TERMS.join("|")})`, "g");

function negatedContentOccurrence(clause, index, term) {
  // Only explicit, adjacent denials of a known label. Include the whole
  // compound, so “不是直播切片” cannot leak through its shorter “切片”.
  return [...clause.matchAll(CONTENT_NEGATION_RE)].some(match => index >= match.index
    && index + term.length <= match.index + match[0].length);
}

function nonAiEvidenceTerms(rule, value, negated = false) {
  return rule.terms.filter(term => value.split(CONTENT_CLAUSE_RE).some(clause => {
    if (!negated && rule.key === "remix" && aiEvidenceTerms(clause).length) return false;
    for (let index = clause.indexOf(term); index !== -1; index = clause.indexOf(term, index + term.length)) {
      if (negatedContentOccurrence(clause, index, term) === negated) return true;
    }
    return false;
  }));
}

function contentEvidenceTerms(rule, value) {
  if (rule.key === "ai-remix") return aiEvidenceTerms(value);
  return nonAiEvidenceTerms(rule, value);
}

// Business ownership is a separate dimension from content type. In
// particular, every confirmed 团团 source belongs to the same major theme;
// 切片 / 原创 / AI二创 remain secondary labels, not competing top-level groups.
const THEME_RULES = Object.freeze([
  { key: "tuantuan", label: "团团", terms: ["一条小团团", "小团团", "团团"] },
  { key: "yangqijia", label: "杨齐家", terms: ["杨齐家"] },
  { key: "laofeiyu", label: "老飞宇", terms: ["老飞宇"] },
  { key: "yuqilin", label: "玉麒麟", terms: ["玉麒麟"] },
  { key: "anlan", label: "安澜", terms: ["安澜"] },
  { key: "jihuang", label: "极煌", terms: ["极煌"] },
  { key: "7jia", label: "7jia", terms: ["7jia"] },
  { key: "naituan", label: "奶团", terms: ["奶团"] },
  { key: "douyin-streamers", label: "抖音主播", terms: ["抖音主播板块", "抖音主播"] },
]);

const THEME_SOURCE_PRIORITY = Object.freeze({
  "所属板块": 5, "表格分类": 4, "表格分层": 4,
  "来源工作表": 3, "来源名称": 2, "来源文件": 1,
});

function text(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function lower(value) { return text(value).toLowerCase(); }

function themeFieldsFor(input = {}) {
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const boards = [...(Array.isArray(input.memberships) ? input.memberships : []), ...(Array.isArray(input.boards) ? input.boards : [])];
  const fields = [];
  const add = (value, source) => {
    const clean = text(value);
    if (clean) fields.push({ value: clean, source });
  };
  const addSource = (source) => {
    if (!source || typeof source !== "object") return;
    add(source.fileName ?? source.source_file_name, "来源文件");
    add(source.sheetName ?? source.source_sheet_name, "来源工作表");
    add(source.sourceName ?? source.title, "来源名称");
  };
  for (const board of boards) {
    if (typeof board === "string") { add(board, "所属板块"); continue; }
    if (!board || typeof board !== "object") continue;
    add(board.name ?? board.board_name, "所属板块");
    add(board.category, "表格分类");
    add(board.tier, "表格分层");
    addSource(board);
    addSource(board.source);
  }
  add(input.category, "表格分类");
  add(input.tier, "表格分层");
  add(typeof input.board === "string" ? input.board : input.board?.name, "所属板块");
  addSource(metadata.importSource);
  addSource(metadata.sourceMetadata);
  for (const source of [...(Array.isArray(metadata.importSources) ? metadata.importSources : []),
    ...(Array.isArray(input.sources) ? input.sources : [])]) addSource(source);
  return [...new Map(fields.map((field) => [`${field.source}\u0000${field.value}`, field])).values()];
}

export function classifyAuthorTheme(input = {}) {
  const fields = themeFieldsFor(input);
  const excludedEvidence = [];
  const matches = THEME_RULES.map((rule) => {
    const exclusions = fields.filter((field) => {
      const value = lower(field.value);
      return rule.terms.some((term) => [`非${term}`, `不是${term}`, `不属于${term}`, `不含${term}`, `不包括${term}`, `${term}无关`].some((phrase) => value.includes(phrase)));
    });
    const exclusionPriority = exclusions.length ? Math.max(...exclusions.map((field) => THEME_SOURCE_PRIORITY[field.source] ?? 0)) : -1;
    excludedEvidence.push(...exclusions.map((field) => ({ theme: rule.label, ...field, excluded: true })));
    const evidence = fields.flatMap((field) => {
      const value = lower(field.value);
      if ((THEME_SOURCE_PRIORITY[field.source] ?? 0) <= exclusionPriority) return [];
      const term = rule.terms.find((candidate) => {
        if (!value.includes(candidate)) return false;
        if (/^[a-z0-9]+$/.test(candidate)) return new RegExp(`(?:^|[^a-z0-9])${candidate}(?:$|[^a-z0-9])`, "i").test(value);
        return true;
      });
      return term ? [{ ...field, term }] : [];
    });
    return evidence.length ? { key: rule.key, label: rule.label, evidence } : null;
  }).filter(Boolean);
  // The generic monitored-streamer roster must not compete with a known IP.
  const labels = matches.some((item) => item.key !== "douyin-streamers")
    ? matches.filter((item) => item.key !== "douyin-streamers") : matches;
  // A mixed workbook title must not override a row's explicit ownership.
  // Equally strong conflicting IP evidence stays unresolved instead of
  // silently choosing whichever IP happens to come first in THEME_RULES.
  const priorityOf = (item) => Math.max(...item.evidence.map((field) => THEME_SOURCE_PRIORITY[field.source] ?? 0));
  const highestPriority = labels.length ? Math.max(...labels.map(priorityOf)) : 0;
  const strongest = labels.filter((item) => priorityOf(item) === highestPriority);
  const conflicting = strongest.length > 1;
  const primary = strongest.length === 1 ? strongest[0] : null;
  return {
    key: primary?.key ?? "unassigned",
    label: primary?.label ?? "待归属",
    confirmed: Boolean(primary),
    mode: primary ? "source-confirmed" : conflicting ? "conflicting-source" : "unassigned",
    labels,
    evidence: [...labels.flatMap((item) => item.evidence.map((evidence) => ({ theme: item.label, ...evidence }))), ...excludedEvidence],
  };
}

export function summarizeThemes(items = []) {
  const counts = new Map();
  for (const item of items) {
    const theme = item?.classification?.theme ?? item?.theme ?? classifyAuthorTheme(item);
    counts.set(theme.key, (counts.get(theme.key) ?? 0) + 1);
  }
  const unassigned = counts.get("unassigned") ?? 0;
  return {
    total: items.length,
    assigned: items.length - unassigned,
    unassigned,
    items: [
      { key: "all", label: "全部主题", count: items.length },
      ...THEME_RULES.map(({ key, label }) => ({ key, label, count: counts.get(key) ?? 0 })),
      { key: "unassigned", label: "待归属", count: unassigned },
    ],
  };
}

// Form questions are not affirmative answers. Only recognize a narrow,
// numbered content-type menu; ordinary multi-label answers remain untouched.
function contentAnswer(value) {
  const answerMarker = /(?:^|[;；。\s])\s*(?:已选(?:择)?(?:内容类型)?|所选(?:内容类型)?|选择结果|答案|填写结果)\s*[:：]\s*/g;
  const answer = [...value.matchAll(answerMarker)][0];
  const promptValue = answer?.index === 0
    ? value.slice(answer[0].length).replace(/^[\s\S]*?(?=(?:\d+[.、]\s*)?(?:内容类型|内容分类|作品类型)\s*[:：])/, "")
    : value;
  const heading = /(?:^|\n)[\t ]*(?:\d+[.、][\t ]*)?(?:内容类型|内容分类|作品类型)[\t ]*[:：]\s*/.exec(promptValue);
  if (!heading) return { value };
  const menu = promptValue.slice(heading.index + heading[0].length);
  const menuAnswer = [...menu.matchAll(answerMarker)][0];
  const menuOnly = menuAnswer ? menu.slice(0, menuAnswer.index) : menu;
  const options = [...menuOnly.matchAll(/\((\d{1,2})\)\s*/g)];
  if (options.length < 3 || options.some((option, index) => Number(option[1]) !== index + 1)
    || menuOnly.slice(0, options[0].index).trim()) return { value };
  const prefixAnswer = answer?.index === 0 && promptValue !== value
    ? value.slice(answer[0].length, value.length - promptValue.length).replace(/[;；。\s]+$/, "")
    : "";
  let selected = prefixAnswer || (menuAnswer ? menu.slice(menuAnswer.index + menuAnswer[0].length).trim() : "");
  let selectedFromOptions = false;
  // A clearly marked numeric answer selects only the corresponding options.
  if (/^\(?\d{1,2}\)?(?:\s*[,，、/]\s*\(?\d{1,2}\)?)*[。.]?$/.test(selected)) {
    const indexes = selected.match(/\d+/g).map(Number);
    selectedFromOptions = indexes.every((index) => index >= 1 && index <= options.length);
    selected = selectedFromOptions
      ? indexes.map((index) => menuOnly.slice(options[index - 1].index + options[index - 1][0].length, options[index]?.index ?? menuOnly.length).replace(/[。;；\s]+$/, "")).join("、")
      : "";
  }
  return { value: selected, selectedFromOptions, excluded: { reason: "form-option-prompt-not-answer", value, selectedAnswer: selected || null } };
}

function fieldsFor(input = {}) {
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const memberships = Array.isArray(input.memberships) ? input.memberships : [];
  const boards = Array.isArray(input.boards) ? input.boards : memberships;
  const explicit = [];
  const contextual = [];
  const weak = [];
  const excludedEvidence = [];
  const add = (bucket, value, source) => {
    const raw = String(value ?? "").normalize("NFKC").trim();
    if (!raw) return;
    // Preserve line boundaries while distinguishing prompts from answers.
    const answer = bucket === weak ? { value: raw } : contentAnswer(raw);
    if (answer.excluded) excludedEvidence.push({ source, ...answer.excluded, value: String(value) });
    const fieldText = text(answer.value);
    if (fieldText) {
      const matchText = bucket === explicit ? explicitContentMatchText(fieldText) : fieldText;
      bucket.push({ text: fieldText, source,
        ...(matchText !== fieldText ? { matchText, evidenceText: answer.excluded ? answer.value : String(value).trim() } : {}),
        ...(answer.selectedFromOptions ? { selectedFromOptions: true } : {}) });
    }
  };
  for (const board of boards) {
    const name = typeof board === "string" ? board : board?.name ?? board?.board_name;
    add(contextual, name, "所属板块");
    add(explicit, typeof board === "object" ? board?.category : "", "表格分类");
    add(contextual, typeof board === "object" ? board?.note : "", "来源备注");
    add(contextual, typeof board === "object" ? board?.source_file_name : "", "来源文件");
    add(contextual, typeof board === "object" ? board?.source_sheet_name : "", "来源工作表");
  }
  add(explicit, input.category, "表格分类");
  add(contextual, metadata.importSource?.fileName, "导入文件");
  add(contextual, metadata.importSource?.sheetName, "导入工作表");
  add(contextual, metadata.importSource?.sourceName, "导入来源");
  add(weak, input.label ?? input.name ?? metadata.submittedName, "作者名称");
  return { explicit, contextual, weak, excludedEvidence };
}

function matchRule(rule, fields) {
  const hits = [];
  const inspect = (bucket, weight) => {
    for (const field of bucket) {
      const value = lower(field.matchText ?? field.text);
      for (const term of contentEvidenceTerms(rule, value)) {
        hits.push({ term, source: field.source, value: field.evidenceText ?? field.text, weight });
      }
    }
  };
  inspect(fields.explicit, 1);
  inspect(fields.contextual, 0.82);
  if (!["ai-remix", "remix"].includes(rule.key)) inspect(fields.weak, 0.55);
  const unique = new Map(hits.map((hit) => [`${hit.term}\u0000${hit.source}\u0000${hit.value}`, hit]));
  const evidence = [...unique.values()];
  if (!evidence.length) return null;
  const explicitHit = evidence.some((hit) => hit.weight === 1);
  const contextualHit = evidence.some((hit) => hit.weight >= 0.8);
  const score = Math.min(1, (explicitHit ? 0.72 : contextualHit ? 0.52 : 0.32) + Math.min(0.25, evidence.length * 0.06));
  return { ...rule, score, explicitHit, contextualHit, evidence: evidence.slice(0, 5) };
}

function customLabels(fields) {
  const seen = new Set();
  const result = [];
  for (const field of fields.explicit) {
    const matchText = field.matchText ?? field.text;
    const candidates = field.selectedFromOptions ? matchText.split(/[,，、/|｜;；]+/) : matchText.match(CUSTOM_CATEGORY_RE) ?? [];
    for (const candidate of candidates) {
      const value = candidate.replace(/^#+/, "").trim();
      if (value.length < 2 || value.length > 40 || !isContentClassificationLabel(value) || RULES.some((rule) => contentEvidenceTerms(rule, lower(value)).length
        || (rule.key !== "ai-remix" && nonAiEvidenceTerms(rule, lower(value), true).length))) continue;
      // Do not turn pasted URLs, short-link hostnames or opaque IDs into
      // business facets. Chinese labels and intentionally short all-caps
      // labels such as BGM remain available as explicit custom facets.
      if (/^(?:https?:\/\/|www\.|v\.)/i.test(value) || (!/[\u3400-\u9fff]/.test(value) && !/^[A-Z0-9 _-]{2,12}$/.test(value))) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ key: `custom:${key}`, label: value, color: "slate", score: 0.9, explicitHit: true, contextualHit: false, evidence: [{ term: value, source: field.source, value: field.text }] });
    }
  }
  return result.slice(0, 4);
}

export function classifyAuthor(input = {}) {
  const fields = fieldsFor(input);
  for (const field of [...fields.explicit, ...fields.contextual, ...fields.weak]) {
    for (const rule of RULES.filter(rule => rule.key !== "ai-remix")) {
      for (const term of nonAiEvidenceTerms(rule, lower(field.text), true)) {
        fields.excludedEvidence.push({ reason: "explicit-content-negation", label: rule.label,
          term, source: field.source, value: field.text });
      }
    }
  }
  const matches = RULES.map((rule) => matchRule(rule, fields)).filter(Boolean);
  const custom = customLabels(fields);
  const rankedLabels = [...matches, ...custom].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, "zh-CN"));
  // A named “切片矩阵” is the source-confirmed business matrix. Spreadsheet
  // answers such as AI二创、原创 or free-form production descriptions are
  // useful secondary tags, but must never replace the matrix as the primary
  // classification merely because an explicit answer receives a higher
  // scoring weight than the board name.
  const matrixSlice = fields.contextual.some((field) => field.source === "所属板块"
      && lower(field.text).includes("切片矩阵"))
    ? matches.find((item) => item.key === "slice") ?? null
    : null;
  const labels = matrixSlice
    ? [matrixSlice, ...rankedLabels.filter((item) => item.key !== matrixSlice.key)]
    : rankedLabels;
  const primary = matrixSlice ?? labels[0] ?? null;
  const mode = custom.length || matches.some((item) => item.explicitHit)
    ? "explicit" : matches.length ? "inferred" : "unclassified";
  const needsReview = !primary || fields.excludedEvidence.some((item) => !item.selectedAnswer) || (labels.length > 1 && primary.score - labels[1].score < 0.08);
  return {
    theme: classifyAuthorTheme(input),
    primaryKey: primary?.key ?? "unclassified",
    primaryLabel: primary?.label ?? "待分类",
    labels: labels.map(({ key, label, color, score }) => ({ key, label, color, confidence: Number(score.toFixed(2)) })),
    mode,
    confidence: primary ? Number(primary.score.toFixed(2)) : 0,
    needsReview,
    evidence: labels.flatMap((item) => item.evidence.map((evidence) => ({ label: item.label, ...evidence }))).slice(0, 12),
    ...(fields.excludedEvidence.length ? { excludedEvidence: fields.excludedEvidence } : {}),
  };
}

export function classificationCatalog(extraItems = []) {
  const custom = new Map();
  for (const item of Array.isArray(extraItems) ? extraItems : []) {
    const key = text(item?.key).toLowerCase();
    const label = text(item?.label);
    if (!key.startsWith("custom:") || !label || custom.has(key)) continue;
    custom.set(key, { key, label, color: "slate" });
  }
  return [
    { key: "all", label: "全部内容" },
    ...RULES.map(({ key, label, color }) => ({ key, label, color })),
    { key: "unclassified", label: "待分类", color: "slate" },
    ...[...custom.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
  ];
}

export function summarizeClassifications(items = [], catalog = null) {
  const effectiveCatalog = Array.isArray(catalog) ? catalog : classificationCatalog(items.flatMap((item) => item?.classification?.labels ?? []));
  const counts = new Map(effectiveCatalog.map((item) => [item.key, 0]));
  let classified = 0;
  for (const item of items) {
    const classification = item?.classification ?? item;
    const labels = Array.isArray(classification?.labels) ? classification.labels : [];
    if (labels.length) classified += 1;
    else counts.set("unclassified", counts.get("unclassified") + 1);
    for (const label of labels) counts.set(label.key, (counts.get(label.key) ?? 0) + 1);
  }
  return {
    total: items.length,
    classified,
    unclassified: items.length - classified,
    items: effectiveCatalog.map((item) => ({ ...item, count: item.key === "all" ? items.length : counts.get(item.key) ?? 0 })),
  };
}

export const AUTHOR_CLASSIFICATION_RULE_VERSION = "rules-v10-tuantuan-matrix-primary-secondary-content";

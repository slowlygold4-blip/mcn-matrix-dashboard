import { readAccountSnapshotComparisons } from './account-report-comparisons.mjs';
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildReport, periodBounds, reviewState } from "./analytics.mjs";
import { authorQueuePlatform, explicitAccountLocatorFromIdentityKey, queuedAuthorAccountLocator } from "./author-queue-identity.mjs";
import {
  asIsoDate,
  businessDateKey,
  businessDateStartUtc,
  checksum,
  isCalendarDate,
  nowIso,
  parseTimeOfDay,
  safeJson,
  shiftCalendarDate,
} from "./utils.mjs";
import { classifyAuthor } from "./author-classification.mjs";
import { authorEvidenceSourceFingerprint, uniqueRoutineAuthorEvidence, verifiedExistingRoutineAuthorEvidence } from "./author-evidence-reuse.mjs";
import { sameResolvedAuthorEvidence } from "./author-evidence-equivalence.mjs";
import { verifyHistoricalSourceWorkIdentity, verifySourceWorkIdentity } from "./source-work-identity.mjs";
import { normalizeCollection } from "./providers/normalize.mjs";
import { browserWorksObservation } from "./official-profile-evidence.mjs";
import { bilibiliWorkObservation } from './bilibili-work-observation.mjs';
import { assertPostHistoryIdentity, persistPosts } from "./post-persistence.mjs";
import { initializeWorksOnlyObservations } from "./works-only-observation.mjs";
import { BROWSER_WORKS_SETTING_DEFAULTS, validateBrowserWorksSettingsUpdate } from "./browser-works-settings.mjs";
import { validateTopicSnapshot } from "./topic-snapshot-integrity.mjs";

export function normalizeBoardName(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function normalizeBoardKey(value) {
  return normalizeBoardName(value).toLowerCase();
}

const UNASSIGNED_BOARD_KEY = "__unassigned__";

function topicHistoryDateKeys(startDate, endDate) {
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || startDate > endDate) {
    throw new Error("话题历史日期必须是有效且不倒序的 YYYY-MM-DD");
  }
  const dates = [];
  for (let cursor = startDate; cursor <= endDate; cursor = shiftCalendarDate(cursor, 1)) dates.push(cursor);
  if (dates.length > 366) throw new Error("话题历史最多支持 366 天");
  return {
    dates,
    start: businessDateStartUtc(startDate),
    end: businessDateStartUtc(endDate),
  };
}

function validatedBoardName(value) {
  if (typeof value !== "string") throw new Error("板块名称必须是文本");
  const name = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("请填写板块名称");
  if (name.length > 120) throw new Error("板块名称不能超过 120 个字符");
  if (["__all__", UNASSIGNED_BOARD_KEY].includes(name.toLowerCase())) {
    throw new Error("该板块名称为系统保留名称，请换一个名称");
  }
  return name;
}

function registerBoard(db, name, sourceType, timestamp) {
  db.prepare(`
    INSERT INTO board_catalog(board_key,board_name,enabled,source_type,created_at,updated_at)
    VALUES(?,?,1,?,?,?)
    ON CONFLICT(board_key) DO UPDATE SET enabled=1,updated_at=excluded.updated_at
      WHERE board_catalog.enabled<>1
  `).run(normalizeBoardKey(name), name, sourceType, timestamp, timestamp);
}

function targetBoardScopeSql(targetAlias, boardKey) {
  if (!boardKey) return { clause: "1=1", params: [] };
  if (boardKey === UNASSIGNED_BOARD_KEY) {
    return { clause: `NOT EXISTS (SELECT 1 FROM target_boards scoped WHERE scoped.target_id=${targetAlias}.id)`, params: [] };
  }
  return {
    clause: `EXISTS (SELECT 1 FROM target_boards scoped WHERE scoped.target_id=${targetAlias}.id AND scoped.board_key=?)`,
    params: [boardKey],
  };
}

export function targetEnabledAtSql(targetAlias, reference) {
  const timestamp = new Date(reference);
  if (Number.isNaN(timestamp.getTime())) throw new Error("报表范围时点无效");
  const asOf = `'${timestamp.toISOString().replaceAll("'", "''")}'`;
  const recordedEnabled = `(SELECT CASE WHEN json_valid(state.details_json)
      THEN json_extract(state.details_json,'$.enabled') END FROM activity_log state
    WHERE state.resource_type='target' AND state.resource_id=CAST(${targetAlias}.id AS TEXT)
      AND state.action IN ('target.create','target.update','target.state') AND state.created_at<=${asOf}
      AND CASE WHEN json_valid(state.details_json) THEN json_type(state.details_json,'$.enabled') END IN ('true','false','integer')
    ORDER BY state.created_at DESC,state.id DESC LIMIT 1)`;
  return `COALESCE(${recordedEnabled}, CASE WHEN julianday(${targetAlias}.updated_at)<=julianday(${asOf})
    THEN ${targetAlias}.enabled ELSE 1 END)`;
}

function targetBoardScopeAsOfSql(targetAlias, boardKey, reference) {
  const timestamp = new Date(reference);
  if (Number.isNaN(timestamp.getTime())) throw new Error("报表范围时点无效");
  const asOf = `'${timestamp.toISOString().replaceAll("'", "''")}'`;
  const targetExistsAt = `${targetAlias}.created_at<=${asOf}`;
  const enabledAt = `${targetEnabledAtSql(targetAlias, reference)}=1`;
  if (!boardKey) return { clause: `${targetExistsAt} AND ${enabledAt}`, params: [] };
  const membershipAt = `scoped.created_at<=${asOf}`;
  if (boardKey === UNASSIGNED_BOARD_KEY) {
    return {
      clause: `${targetExistsAt} AND ${enabledAt} AND NOT EXISTS (SELECT 1 FROM target_boards scoped WHERE scoped.target_id=${targetAlias}.id AND ${membershipAt})`,
      params: [],
    };
  }
  return {
    clause: `${targetExistsAt} AND ${enabledAt} AND EXISTS (SELECT 1 FROM target_boards scoped WHERE scoped.target_id=${targetAlias}.id AND scoped.board_key=? AND ${membershipAt})`,
    params: [boardKey],
  };
}

function authorQueueBoardScopeSql(queueAlias, board) {
  const key = normalizeBoardKey(board);
  if (!key || key === "__all__") return { clause: "1=1", params: [] };
  const boardArray = `CASE WHEN json_valid(${queueAlias}.boards_json)
    THEN CASE WHEN json_type(${queueAlias}.boards_json)='array' THEN ${queueAlias}.boards_json ELSE '[]' END
    ELSE '[]' END`;
  const boardName = `CASE queued_board.type
    WHEN 'text' THEN queued_board.value
    WHEN 'object' THEN json_extract(queued_board.value,'$.name')
    ELSE '' END`;
  const hasBoard = `EXISTS (SELECT 1 FROM json_each(${boardArray}) queued_board
    WHERE normalize_board_key(${boardName}) ${key === UNASSIGNED_BOARD_KEY ? "<> ''" : "= ?"})`;
  return key === UNASSIGNED_BOARD_KEY
    ? { clause: `NOT ${hasBoard}`, params: [] }
    : { clause: hasBoard, params: [key] };
}

const BOARD_METADATA_FIELDS = Object.freeze([
  ["organization", 200],
  ["tier", 120],
  ["category", 120],
  ["owner", 120],
  ["filledDate", 40],
  ["note", 500],
]);

// Primary-theme conflicts are review evidence, not relationship metadata.
// Keeping the field out of BOARD_METADATA_FIELDS prevents a rejected IP
// assignment from ever being copied into a target_boards column.
const BOARD_CONFLICT_FIELDS = Object.freeze([
  ...BOARD_METADATA_FIELDS,
  ["primaryTheme", 500],
]);

function compactBoardValue(value, maxLength) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function boardValueKey(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function boardFieldValue(value, field, maxLength) {
  if (!value || typeof value !== "object") return "";
  if (field === "filledDate") return compactBoardValue(value.filledDate ?? value.filled_date, maxLength);
  if (field === "note") return compactBoardValue(value.note ?? value.notes ?? value.remark ?? value.remarks, maxLength);
  return compactBoardValue(value[field], maxLength);
}

function boardConflictFingerprint(conflict) {
  return `${String(conflict?.field ?? "")}\u0000${boardValueKey(conflict?.storedValue)}\u0000${boardValueKey(conflict?.incomingValue)}`;
}

function sanitizeBoardConflict(value) {
  if (!value || typeof value !== "object") return null;
  const definition = BOARD_CONFLICT_FIELDS.find(([field]) => field === value.field);
  if (!definition) return null;
  const [field, maxLength] = definition;
  const storedValue = compactBoardValue(value.storedValue, maxLength);
  const incomingValue = compactBoardValue(value.incomingValue, maxLength);
  if (!storedValue || !incomingValue || boardValueKey(storedValue) === boardValueKey(incomingValue)) return null;
  const cleanSource = (source) => source && typeof source === "object" ? {
    type: compactBoardValue(source.type, 40),
    fileName: compactBoardValue(source.fileName, 240),
    sheetName: compactBoardValue(source.sheetName, 120),
    sourceRow: source.sourceRow == null ? null : Math.max(1, Math.trunc(Number(source.sourceRow) || 1)),
  } : null;
  return {
    field,
    storedValue,
    incomingValue,
    ...(value.recordedAt && !Number.isNaN(new Date(value.recordedAt).getTime()) ? { recordedAt: new Date(value.recordedAt).toISOString() } : {}),
    ...(cleanSource(value.storedSource) ? { storedSource: cleanSource(value.storedSource) } : {}),
    ...(cleanSource(value.incomingSource) ? { incomingSource: cleanSource(value.incomingSource) } : {}),
    ...(value.relationshipBlocked === true ? { relationshipBlocked: true } : {}),
  };
}

function appendUniqueBoardConflict(conflicts, value) {
  const conflict = sanitizeBoardConflict(value);
  if (!conflict) return false;
  const fingerprint = boardConflictFingerprint(conflict);
  if (conflicts.some((item) => boardConflictFingerprint(item) === fingerprint)) return false;
  if (conflicts.length >= 100) return false;
  conflicts.push(conflict);
  return true;
}

function normalizedBoardEntries(values, defaults = {}) {
  const source = Array.isArray(values) ? values : [values];
  const entries = new Map();
  for (const value of source) {
    const name = normalizeBoardName(value && typeof value === "object" ? value.name : value);
    const key = normalizeBoardKey(name);
    if (!key) continue;
    const entrySource = sourceDescriptor(value?.source ?? defaults?.source ?? {});
    const entry = {
      key,
      name,
      conflicts: [],
      sourceRow: value && typeof value === "object" && (value.sourceRow != null || value.source?.sourceRow != null)
        ? Math.max(1, Math.trunc(Number(value.sourceRow ?? value.source?.sourceRow) || 1))
        : defaults?.sourceRow == null && defaults?.source?.sourceRow == null ? null : Math.max(1, Math.trunc(Number(defaults.sourceRow ?? defaults.source?.sourceRow) || 1)),
      source: entrySource.type || entrySource.fileName || entrySource.sheetName || entrySource.sourceRow != null ? entrySource : null,
    };
    for (const [field, maxLength] of BOARD_METADATA_FIELDS) {
      entry[field] = boardFieldValue(value, field, maxLength) || boardFieldValue(defaults, field, maxLength);
    }
    for (const conflict of Array.isArray(value?.conflicts) ? value.conflicts : []) appendUniqueBoardConflict(entry.conflicts, conflict);
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, entry);
      continue;
    }
    let filled = false;
    for (const [field] of BOARD_METADATA_FIELDS) {
      if (!existing[field] && entry[field]) {
        existing[field] = entry[field];
        filled = true;
      }
      else if (existing[field] && entry[field] && boardValueKey(existing[field]) !== boardValueKey(entry[field])) {
        appendUniqueBoardConflict(existing.conflicts, {
          field,
          storedValue: existing[field],
          incomingValue: entry[field],
          incomingSource: { sourceRow: entry.sourceRow },
        });
      }
    }
    for (const conflict of entry.conflicts) appendUniqueBoardConflict(existing.conflicts, conflict);
    // Like attachTargetBoards, this is the last source that filled accepted
    // relationship fields, not a claim that every field came from that file.
    // Original per-import values remain in immutable source receipts.
    if (filled && entry.source) {
      existing.source = entry.source;
      existing.sourceRow = entry.sourceRow;
    } else if ((!existing.source?.type && !existing.source?.fileName && !existing.source?.sheetName) && entry.source) existing.source = entry.source;
  }
  return [...entries.values()];
}

function serializedBoardEntries(values, defaults = {}) {
  return normalizedBoardEntries(values, defaults).map((entry) => ({
    name: entry.name,
    ...Object.fromEntries(BOARD_METADATA_FIELDS.map(([field]) => [field, entry[field]]).filter(([, value]) => value)),
    ...(entry.sourceRow != null ? { sourceRow: entry.sourceRow } : {}),
    ...(entry.source && (entry.source.type || entry.source.fileName || entry.source.sheetName || entry.source.sourceRow != null) ? { source: entry.source } : {}),
    ...(entry.conflicts.length ? { conflicts: entry.conflicts } : {}),
  }));
}

function sourceDescriptor(source = {}, sourceRow = null) {
  return {
    type: compactBoardValue(source?.type, 40),
    fileName: compactBoardValue(source?.fileName, 240),
    sheetName: compactBoardValue(source?.sheetName, 120),
    sourceRow: sourceRow == null
      ? source?.sourceRow == null ? null : Math.max(1, Math.trunc(Number(source.sourceRow) || 1))
      : Math.max(1, Math.trunc(Number(sourceRow) || 1)),
  };
}

function boardFromRow(row) {
  const conflicts = safeJson(row?.conflicts_json, []);
  return {
    key: row.board_key ?? row.key,
    name: row.board_name ?? row.name,
    organization: row.organization || "",
    tier: row.tier || "",
    category: row.category || "",
    owner: row.owner || "",
    filledDate: row.filled_date || "",
    note: row.note || "",
    conflicts: Array.isArray(conflicts) ? conflicts.map(sanitizeBoardConflict).filter(Boolean) : [],
    source: {
      type: row.source_type || "",
      fileName: row.source_file_name || "",
      sheetName: row.source_sheet_name || "",
      sourceRow: row.source_row == null ? null : Number(row.source_row),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    },
  };
}

const GENERIC_BOARD_THEME_KEYS = new Set(["unassigned", "douyin-streamers"]);

function explicitBoardTheme(values) {
  // The relationship's canonical identity is the authority boundary here.
  // Provenance (file/sheet/source name) and descriptive metadata (category,
  // tier, note, etc.) remain useful classification evidence elsewhere, but
  // must never freeze an IP theme for an otherwise generic board.
  const boards = (Array.isArray(values) ? values : [values]).flatMap((value) => {
    if (typeof value === "string") return [normalizeBoardName(value)].filter(Boolean);
    if (!value || typeof value !== "object") return [];
    const name = normalizeBoardName(value.name ?? value.board_name);
    const key = normalizeBoardName(value.key ?? value.board_key);
    return [...new Set([name, key].filter((item) => item && item !== UNASSIGNED_BOARD_KEY))];
  });
  const theme = classifyAuthor({ boards }).theme;
  return theme?.confirmed === true && !GENERIC_BOARD_THEME_KEYS.has(theme.key) ? theme : null;
}

function explicitThemesByKey(values) {
  const themes = new Map();
  for (const value of values) {
    const theme = explicitBoardTheme([value]);
    if (theme && !themes.has(theme.key)) themes.set(theme.key, theme);
  }
  return themes;
}

function primaryThemeConflictSummary(prefix, themes) {
  const labels = [...themes.values()]
    .sort((left, right) => left.key === right.key ? 0 : left.key < right.key ? -1 : 1)
    .map((theme) => theme.label);
  return `待归属｜${prefix}：${labels.join("、")}`;
}

function automaticBoardSource(source) {
  const type = compactBoardValue(source?.type, 40).toLowerCase();
  return type !== "manual" && !type.startsWith("user-");
}

function attachTargetBoards(db, targetId, values, source = {}, timestamp = nowIso(), batchThemes = null) {
  const entries = normalizedBoardEntries(values, source?.boardMetadata ?? {});
  const outcome = { added: 0, updated: 0, conflicts: [] };
  if (!entries.length) return outcome;
  // Plan the whole automatic attach before writing anything. A unique
  // pre-existing explicit theme is authoritative. With no such authority, a
  // batch containing multiple explicit IPs is unresolved: keep generic
  // memberships, block every explicit candidate, and report the conflict
  // instead of guessing from input order.
  const baselineRows = db.prepare("SELECT * FROM target_boards WHERE target_id=? ORDER BY board_key")
    .all(Number(targetId));
  const automaticSource = automaticBoardSource(source);
  const baselineThemes = automaticSource ? explicitThemesByKey(baselineRows.map(boardFromRow)) : new Map();
  const incomingThemeByBoardKey = new Map(entries.map((board) => [board.key, explicitBoardTheme([board])]));
  const incomingThemes = automaticSource
    ? batchThemes ?? explicitThemesByKey(entries)
    : new Map();
  const protectedTheme = baselineThemes.size === 1 ? baselineThemes.values().next().value : null;
  const baselineThemeConflict = automaticSource && baselineThemes.size > 1;
  const incomingThemeConflict = automaticSource && baselineThemes.size === 0 && incomingThemes.size > 1;
  const themeAnchor = protectedTheme
    ? baselineRows.find((row) => explicitBoardTheme([boardFromRow(row)])?.key === protectedTheme.key) ?? baselineRows[0]
    : null;
  const plannedEntries = incomingThemeConflict
    ? [...entries].sort((left, right) => {
        const leftExplicit = incomingThemeByBoardKey.get(left.key) ? 1 : 0;
        const rightExplicit = incomingThemeByBoardKey.get(right.key) ? 1 : 0;
        return leftExplicit - rightExplicit || (left.key === right.key ? 0 : left.key < right.key ? -1 : 1);
      })
    : entries;
  const register = db.prepare(`
    INSERT INTO board_catalog(board_key,board_name,enabled,source_type,created_at,updated_at)
    VALUES(?,?,1,?,?,?)
    ON CONFLICT(board_key) DO UPDATE SET enabled=1,updated_at=excluded.updated_at
  `);
  const insert = db.prepare(`
    INSERT INTO target_boards(
      target_id,board_key,board_name,organization,tier,category,owner,filled_date,note,conflicts_json,
      source_type,source_file_name,source_sheet_name,source_row,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const existingStatement = db.prepare("SELECT * FROM target_boards WHERE target_id=? AND board_key=?");
  const currentRowsStatement = db.prepare("SELECT * FROM target_boards WHERE target_id=? ORDER BY board_key");
  const updateConflicts = db.prepare(`
    UPDATE target_boards SET conflicts_json=?,updated_at=?
    WHERE target_id=? AND board_key=?
  `);
  const update = db.prepare(`
    UPDATE target_boards
    SET organization=?,tier=?,category=?,owner=?,filled_date=?,note=?,conflicts_json=?,
        source_type=?,source_file_name=?,source_sheet_name=?,source_row=?,updated_at=?
    WHERE target_id=? AND board_key=?
  `);
  for (const board of plannedEntries) {
    const existing = existingStatement.get(Number(targetId), board.key);
    const incomingSource = sourceDescriptor({ ...source, ...(board.source ?? {}) }, board.sourceRow ?? board.source?.sourceRow);
    const incomingTheme = incomingThemeByBoardKey.get(board.key);
    const protectedThemeMismatch = protectedTheme && incomingTheme && incomingTheme.key !== protectedTheme.key;
    const unresolvedThemeCandidate = incomingTheme && (baselineThemeConflict || incomingThemeConflict);
    if (!existing && automaticSource && (protectedThemeMismatch || unresolvedThemeCandidate)) {
      const anchor = themeAnchor
        ? existingStatement.get(Number(targetId), themeAnchor.board_key)
        : currentRowsStatement.all(Number(targetId)).find((row) => !explicitBoardTheme([boardFromRow(row)]))
          ?? (baselineThemeConflict ? baselineRows[0] : null);
      const conflicts = anchor && Array.isArray(safeJson(anchor.conflicts_json, []))
        ? safeJson(anchor.conflicts_json, []).map(sanitizeBoardConflict).filter(Boolean)
        : [];
      const storedValue = protectedThemeMismatch
        ? `${protectedTheme.label}｜${themeAnchor.board_name}`
        : baselineThemeConflict
          ? primaryThemeConflictSummary("已有冲突主题", baselineThemes)
          : primaryThemeConflictSummary("同批冲突主题", incomingThemes);
      const blockedConflict = sanitizeBoardConflict({
        field: "primaryTheme",
        storedValue,
        incomingValue: `${incomingTheme.label}｜${board.name}`,
        recordedAt: timestamp,
        ...(protectedThemeMismatch ? { storedSource: sourceDescriptor({
          type: anchor?.source_type,
          fileName: anchor?.source_file_name,
          sheetName: anchor?.source_sheet_name,
          sourceRow: anchor?.source_row,
        }) } : {}),
        incomingSource,
        relationshipBlocked: true,
      });
      if (anchor && appendUniqueBoardConflict(conflicts, blockedConflict)) {
        updateConflicts.run(JSON.stringify(conflicts), timestamp, Number(targetId), anchor.board_key);
        outcome.updated += 1;
      }
      // Report every rejected attempt to the import audit, even if the same
      // durable conflict was already recorded on an earlier run.
      outcome.conflicts.push({
        targetId: Number(targetId),
        boardKey: board.key,
        boardName: board.name,
        ...blockedConflict,
      });
      continue;
    }
    register.run(board.key, board.name, String(source?.type ?? "import").slice(0, 40), timestamp, timestamp);
    if (!existing) {
      const conflicts = [];
      for (const conflict of board.conflicts) {
        const stored = { ...conflict, recordedAt: conflict.recordedAt ?? timestamp, incomingSource: conflict.incomingSource ?? incomingSource };
        if (appendUniqueBoardConflict(conflicts, stored)) outcome.conflicts.push({ targetId: Number(targetId), boardKey: board.key, boardName: board.name, ...conflicts.at(-1) });
      }
      insert.run(
        Number(targetId), board.key, board.name,
        board.organization, board.tier, board.category, board.owner, board.filledDate, board.note, JSON.stringify(conflicts),
        incomingSource.type, incomingSource.fileName, incomingSource.sheetName, incomingSource.sourceRow,
        timestamp, timestamp,
      );
      outcome.added += 1;
      continue;
    }
    const merged = {
      organization: existing.organization || "",
      tier: existing.tier || "",
      category: existing.category || "",
      owner: existing.owner || "",
      filledDate: existing.filled_date || "",
      note: existing.note || "",
    };
    const conflicts = Array.isArray(safeJson(existing.conflicts_json, []))
      ? safeJson(existing.conflicts_json, []).map(sanitizeBoardConflict).filter(Boolean)
      : [];
    let changed = false;
    let filled = false;
    const storedSource = sourceDescriptor({
      type: existing.source_type,
      fileName: existing.source_file_name,
      sheetName: existing.source_sheet_name,
      sourceRow: existing.source_row,
    });
    for (const [field] of BOARD_METADATA_FIELDS) {
      if (!merged[field] && board[field]) {
        merged[field] = board[field];
        changed = true;
        filled = true;
      } else if (merged[field] && board[field] && boardValueKey(merged[field]) !== boardValueKey(board[field])) {
        const conflict = {
          field,
          storedValue: merged[field],
          incomingValue: board[field],
          recordedAt: timestamp,
          storedSource,
          incomingSource,
        };
        if (appendUniqueBoardConflict(conflicts, conflict)) {
          changed = true;
          outcome.conflicts.push({ targetId: Number(targetId), boardKey: board.key, boardName: board.name, ...conflicts.at(-1) });
        }
      }
    }
    for (const conflict of board.conflicts) {
      const stored = { ...conflict, recordedAt: conflict.recordedAt ?? timestamp, incomingSource: conflict.incomingSource ?? incomingSource };
      if (appendUniqueBoardConflict(conflicts, stored)) {
        changed = true;
        outcome.conflicts.push({ targetId: Number(targetId), boardKey: board.key, boardName: board.name, ...conflicts.at(-1) });
      }
    }
    if (!changed) continue;
    const effectiveSource = filled ? incomingSource : storedSource;
    update.run(
      merged.organization, merged.tier, merged.category, merged.owner, merged.filledDate, merged.note, JSON.stringify(conflicts),
      effectiveSource.type, effectiveSource.fileName, effectiveSource.sheetName, effectiveSource.sourceRow, timestamp,
      Number(targetId), board.key,
    );
    outcome.updated += 1;
  }
  return outcome;
}

function toTarget(row, boards = []) {
  if (!row) return null;
  // Target/bootstrap projections are not the topic-history provenance
  // boundary. Keep raw hashtag counters out of those generic payloads; the
  // verified topic-history read model is the only public metric projection.
  const topicMetricsRequireHistory = row.type === "hashtag";
  const topicQuality = topicMetricsRequireHistory && row.quality_status && row.quality_status !== "rejected"
    ? "unverified" : row.quality_status || null;
  const previousTopicQuality = topicMetricsRequireHistory && row.previous_quality_status && row.previous_quality_status !== "rejected"
    ? "unverified" : row.previous_quality_status || null;
  const strictIdentityStatus = row.strict_identity_status || null;
  const strictIdentityError = row.strict_identity_error || "";
  const strictReviewActive = ["pending", "retry", "rejected"].includes(strictIdentityStatus);
  const accountStatus = row.latest_account_status || "unknown";
  const worksCoverage = row.latest_works_coverage || "unknown";
  const profileUsable = ["available", "partial"].includes(accountStatus);
  return {
    ...row,
    enabled: Boolean(row.enabled),
    metadata: safeJson(row.metadata_json, {}),
    last_status: strictReviewActive ? (strictIdentityStatus === "rejected" ? "rejected" : "warning") : row.last_status,
    latestWarnings: strictReviewActive
      ? [strictIdentityError || "历史多作品身份正在逐项复核，复核完成前该账号保持暂停"]
      : safeJson(row.latest_warnings_json, []),
    accountStatus,
    worksCoverage,
    accountError: row.latest_account_error || null,
    worksError: row.latest_works_error || null,
    latestSnapshotAt: row.latest_snapshot_at || null,
    profileUsable,
    latestNormalizedPostCount: row.latest_normalized_post_count == null ? null : Number(row.latest_normalized_post_count),
    latestHashtagQualityStatus: topicQuality,
    previousHashtagQualityStatus: previousTopicQuality,
    latestHashtagParticipants: topicMetricsRequireHistory || row.quality_status === "rejected" || row.latest_hashtag_participants == null ? null : Number(row.latest_hashtag_participants),
    latestHashtagParticipantsDelta: topicMetricsRequireHistory || row.quality_status === "rejected" || row.previous_quality_status === "rejected"
      || row.latest_hashtag_participants == null || row.previous_hashtag_participants == null
      ? null : Number(row.latest_hashtag_participants) - Number(row.previous_hashtag_participants),
    latestHashtagViews: topicMetricsRequireHistory || row.quality_status === "rejected" || row.latest_hashtag_views == null ? null : Number(row.latest_hashtag_views),
    latestHashtagViewsDelta: topicMetricsRequireHistory || row.quality_status === "rejected" || row.previous_quality_status === "rejected"
      || row.latest_hashtag_views == null || row.previous_hashtag_views == null
      ? null : Number(row.latest_hashtag_views) - Number(row.previous_hashtag_views),
    latestHashtagPosts: topicMetricsRequireHistory || row.quality_status === "rejected" || row.latest_hashtag_posts == null ? null : Number(row.latest_hashtag_posts),
    latestAuthorCount: topicMetricsRequireHistory || row.quality_status === "rejected" || row.latest_author_count == null ? null : Number(row.latest_author_count),
    topicMetricsReadSource: topicMetricsRequireHistory ? "verified-history-only" : null,
    strictIdentityStatus,
    boards,
    latest_warnings_json: undefined,
    strict_identity_status: undefined,
    strict_identity_error: undefined,
    latest_account_status: undefined,
    latest_works_coverage: undefined,
    latest_account_error: undefined,
    latest_works_error: undefined,
    previous_quality_status: undefined,
    latest_snapshot_at: undefined,
    latest_hashtag_participants: undefined,
    previous_hashtag_participants: undefined,
    latest_hashtag_views: undefined,
    previous_hashtag_views: undefined,
    latest_hashtag_posts: undefined,
    latest_author_count: undefined,
  };
}

function toUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    displayName: row.display_name,
    role: row.role,
    enabled: Boolean(row.enabled),
    authSource: row.auth_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at ?? null,
    activeSessionCount: Number(row.active_session_count ?? 0),
  };
}

function toAuthorResolutionJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id == null ? null : Number(row.user_id),
    actorName: row.actor_name,
    clientIp: row.client_ip ?? null,
    fileName: row.file_name,
    sheetName: row.sheet_name,
    status: row.status,
    phase: row.phase,
    totalAuthors: Number(row.total_authors ?? 0),
    request: safeJson(row.request_json, {}),
    result: safeJson(row.result_json, null),
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    updatedAt: row.updated_at,
    leaseOwner: row.lease_owner ?? null,
    leaseUntil: row.lease_until ?? null,
    version: Number(row.version ?? 0),
  };
}

function compactQueueText(value, maxLength) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

const authorSchedulingConnections = new WeakSet();

// This key apportions queue turns only. It is never proof that a submitted
// handle belongs to a target, and never combines or changes evidence rows.
function authorSchedulingKey(identityKey, submittedId, accountLocator) {
  const row = { identity_key: identityKey, account_locator: accountLocator };
  const platform = authorQueuePlatform(row);
  const accountId = compactQueueText(submittedId, 180).replace(/^@/, "").toLowerCase();
  if (accountId && accountId !== "0") return checksum([platform, "submitted-id", accountId]);
  const locator = queuedAuthorAccountLocator(row);
  return checksum([platform, locator ? "canonical-locator" : "queue-evidence", locator || identityKey]);
}

function fairDueAuthorResolutionRows(db, {
  count, nowValue, fileName = null, includeNotDueRetries = false, excludeIds = [],
}) {
  if (!authorSchedulingConnections.has(db)) {
    db.function("author_scheduling_key", { deterministic: true }, authorSchedulingKey);
    authorSchedulingConnections.add(db);
  }
  // SQLite ranks narrow columns, not all original work/source payloads. The
  // indexed claim lookup reads the newest matching event for each identity;
  // only the <=36 winners load complete queue rows. Old history has no claim
  // event: initialize by first created_at, NOT import-updated_at or a guessed
  // last network attempt. New events record actual claims, not network success.
  return db.prepare(`
    WITH keyed AS MATERIALIZED (
      SELECT id,evidence_version,status,next_attempt_at,lease_owner,lease_until,file_name,created_at,
        author_scheduling_key(identity_key,douyin_id,account_locator) AS scheduling_key
      FROM author_resolution_queue WHERE status IN ('pending','retry')
    ), identity_state AS (
      SELECT scheduling_key,strftime('%Y-%m-%dT%H:%M:%fZ',MIN(julianday(created_at))) AS first_created_at,
        MAX(CASE WHEN lease_until IS NULL THEN lease_owner IS NOT NULL
          ELSE julianday(lease_until) IS NULL OR julianday(lease_until)>julianday($now) END) AS leased,
        MAX(CASE WHEN status='retry' AND (julianday(next_attempt_at) IS NULL OR julianday(next_attempt_at)>julianday($now))
          AND NOT ($force=1 AND file_name=$file) THEN 1 ELSE 0 END) AS cooling
      FROM keyed GROUP BY scheduling_key
    ), ready AS (
      SELECT q.id,q.evidence_version,q.scheduling_key,q.next_attempt_at,g.first_created_at,
        ROW_NUMBER() OVER (PARTITION BY q.scheduling_key ORDER BY julianday(q.next_attempt_at),q.id) AS identity_rank
      FROM keyed q JOIN identity_state g USING(scheduling_key)
      WHERE g.leased=0 AND g.cooling=0
        AND julianday(q.next_attempt_at) IS NOT NULL
        AND (julianday(q.next_attempt_at)<=julianday($now) OR ($force=1 AND q.status='retry'))
        AND ($file IS NULL OR q.file_name=$file)
        AND q.id NOT IN (SELECT value FROM json_each($excluded))
    ), turns AS (
      SELECT ready.*,COALESCE((SELECT a.created_at || ':' || printf('%020d',a.id) FROM activity_log a
          WHERE a.resource_type='author-resolution-identity' AND a.resource_id=ready.scheduling_key
            AND a.action='author-resolution.claimed' AND a.actor_name='系统' AND a.user_id IS NULL
            AND a.created_at<=$now ORDER BY a.created_at DESC,a.id DESC LIMIT 1),
          first_created_at || ':00000000000000000000') AS waiting_since
      FROM ready WHERE identity_rank=1
    ), picked AS MATERIALIZED (
      SELECT * FROM turns ORDER BY waiting_since,julianday(next_attempt_at),id LIMIT $count
    )
    SELECT q.*,picked.scheduling_key AS _scheduling_key
    FROM picked JOIN author_resolution_queue q ON q.id=picked.id
    ORDER BY picked.waiting_since,julianday(picked.next_attempt_at),picked.id
  `).all({ now: nowValue, force: includeNotDueRetries === true ? 1 : 0,
    file: fileName, excluded: JSON.stringify(excludeIds), count });
}

function overviewWarnings(status, warnings = []) {
  const normalized = safeJson(warnings, []);
  const state = reviewState(status, Array.isArray(normalized) ? normalized.map(String) : []);
  if (state === "retry") return ["作品列表接口未通过"];
  if (state === "limited") return ["公开范围说明"];
  return [];
}

function compactOverviewTarget(target) {
  const { metadata = {}, latestWarnings = [] } = target;
  const publicMetadata = {};
  for (const key of ["platform", "douyinId", "bilibiliId", "xiaohongshuId"]) {
    if (metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== "") publicMetadata[key] = metadata[key];
  }
  return {
    id: target.id,
    type: target.type,
    label: target.label,
    locator: target.locator,
    provider: target.provider,
    enabled: target.enabled,
    last_checked_at: target.last_checked_at,
    last_status: target.last_status,
    // Deterministic identity/evidence failures drive the actionable
    // "需补证据" filter in the dashboard. Keep the concrete audit reason in
    // the compact overview payload for error targets instead of forcing the
    // client to issue a second request just to classify the row.
    ...(target.last_status === "error" && target.last_error ? { last_error: target.last_error } : {}),
    // last_checked_at records the latest attempt (including a failed attempt).
    // Only error targets need the extra successful-snapshot timestamp; for a
    // normal saved collection last_checked_at and latestSnapshotAt are equal.
    ...(target.last_status === "error" && target.latestSnapshotAt ? { latestSnapshotAt: target.latestSnapshotAt } : {}),
    ...(target.accountStatus && target.accountStatus !== "unknown" ? { accountStatus: target.accountStatus } : {}),
    ...(target.worksCoverage && target.worksCoverage !== "unknown" ? { worksCoverage: target.worksCoverage } : {}),
    ...(target.type === "hashtag" ? {
      latestHashtagQualityStatus: target.latestHashtagQualityStatus,
      previousHashtagQualityStatus: target.previousHashtagQualityStatus,
      latestHashtagParticipants: target.latestHashtagParticipants,
      latestHashtagParticipantsDelta: target.latestHashtagParticipantsDelta,
      latestHashtagViews: target.latestHashtagViews,
      latestHashtagViewsDelta: target.latestHashtagViewsDelta,
      latestHashtagPosts: target.latestHashtagPosts,
      topicMetricsReadSource: target.topicMetricsReadSource,
      latestAuthorCount: target.latestAuthorCount,
    } : {}),
    known_posts: target.known_posts,
    boards: target.boards ?? [],
    metadata: publicMetadata,
    latestWarnings: overviewWarnings(target.last_status, latestWarnings),
  };
}

function overviewRunReviewState(item, targetType) {
  const status = item?.status ?? "pending";
  const warnings = overviewWarnings(status, item?.warnings);
  if (targetType === "hashtag") {
    if (status === "rejected") return "manual";
    if (["error", "skipped", "inactive"].includes(status)) return "retry";
    if (item?.topicMetricsUsable !== true) return "retry";
    if (status === "validated") return "complete";
    if (status === "warning") return "limited";
    return "pending";
  }
  const derived = reviewState(status, warnings, {
    accountStatus: item?.accountStatus ?? "unknown",
    worksCoverage: item?.worksCoverage ?? "unknown",
  });
  const saved = item?.reviewState;
  // Keep conservative collector decisions; never trust an old positive label
  // when the actual saved account/work coverage does not support it.
  if (["manual", "retry", "pending"].includes(saved)) return saved;
  if (saved === "limited" && derived === "complete") return "limited";
  return derived;
}

function compactOverviewRunDetails(value, targetTypes = new Map()) {
  const details = safeJson(value, []);
  if (!Array.isArray(details)) return [];
  return details.map((item) => {
    const warnings = overviewWarnings(item?.status, item?.warnings);
    const accountStatus = item?.accountStatus ?? "unknown";
    const worksCoverage = item?.worksCoverage ?? "unknown";
    return {
      ...(item?.targetId === undefined ? {} : { targetId: item.targetId }),
      status: item?.status ?? "pending",
      accountStatus,
      worksCoverage,
      profileUsable: Boolean(item?.profileUsable),
      reviewState: overviewRunReviewState(item, targetTypes.get(Number(item?.targetId))),
      warnings,
    };
  });
}

function topOverviewContributorIds(contributors) {
  const ids = new Set();
  const include = (key, direction, predicate) => {
    [...contributors]
      .filter((item) => item[key] !== null && item[key] !== undefined && predicate(Number(item[key])))
      .sort((left, right) => direction * (Number(left[key]) - Number(right[key])))
      .slice(0, 10)
      .forEach((item) => ids.add(Number(item.targetId)));
  };
  include("followersDelta", -1, (value) => value > 0);
  include("accountLikesDelta", -1, (value) => value > 0);
  include("followersDelta", 1, (value) => value < 0);
  include("estimatedPlaysDelta", -1, (value) => value > 0);
  return ids;
}

function compactOverviewReport(report) {
  if (!report) return null;
  const contributors = Array.isArray(report.contributors) ? report.contributors : [];
  const evidenceIds = topOverviewContributorIds(contributors);
  return {
    ...report,
    viral: (report.viral ?? []).slice(0, 6).map((post) => ({
      author_name: post.author_name,
      caption: post.caption,
      published_at: post.published_at,
      likes: post.likes,
      url: post.url,
    })),
    contributors: contributors.map((item) => {
      if (!evidenceIds.has(Number(item.targetId))) {
        return {
          targetId: item.targetId,
          followersDelta: item.followersDelta,
          accountLikesDelta: item.accountLikesDelta,
          estimatedPlaysDelta: item.estimatedPlaysDelta,
        };
      }
      const { warnings, reviewState: existingReviewState, ...evidence } = item;
      const compactWarnings = overviewWarnings(item.qualityStatus, warnings);
      return {
        ...evidence,
        reviewState: existingReviewState ?? reviewState(item.qualityStatus, compactWarnings),
        warnings: compactWarnings,
      };
    }),
    posts: [],
  };
}

export class MonitorDatabase {
  constructor(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.db = new DatabaseSync(filePath);
    this.db.function("normalize_board_key", { deterministic: true }, (value) => normalizeBoardKey(value));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    try { chmodSync(filePath, 0o600); } catch {}
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('account','hashtag')),
        label TEXT NOT NULL,
        locator TEXT NOT NULL,
        provider TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,
        next_check_at TEXT,
        last_status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        UNIQUE(type, locator, provider)
      );

      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT,
        caption TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        likes INTEGER,
        comments INTEGER,
        shares INTEGER,
        collects INTEGER,
        plays INTEGER,
        url TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        raw_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(target_id, external_id)
      );

      CREATE TABLE IF NOT EXISTS post_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        captured_at TEXT NOT NULL,
        likes INTEGER,
        comments INTEGER,
        shares INTEGER,
        collects INTEGER,
        plays INTEGER,
        UNIQUE(post_id, captured_at)
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        captured_at TEXT NOT NULL,
        followers INTEGER,
        total_likes INTEGER,
        total_posts INTEGER,
        hashtag_participants INTEGER,
        hashtag_views INTEGER,
        hashtag_posts INTEGER,
        author_count INTEGER,
        quality_status TEXT NOT NULL CHECK(quality_status IN ('validated','warning','rejected')),
        account_status TEXT NOT NULL DEFAULT 'unknown',
        works_coverage TEXT NOT NULL DEFAULT 'unknown',
        account_error TEXT,
        works_error TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        source_checksum TEXT NOT NULL,
        raw_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(target_id, captured_at)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_type TEXT NOT NULL,
        target_id INTEGER REFERENCES targets(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        target_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        details_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER REFERENCES targets(id) ON DELETE SET NULL,
        run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        normalized_post_count INTEGER NOT NULL DEFAULT 0,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        source_checksum TEXT,
        message TEXT
      );

      CREATE TABLE IF NOT EXISTS account_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        event_key TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        source_checksum TEXT NOT NULL,
        event_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(target_id,event_type,event_key)
      );
      CREATE INDEX IF NOT EXISTS account_events_target_time ON account_events(target_id,observed_at,id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_probes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_source_probes_provider_checked_at ON source_probes(provider, checked_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('viewer','editor','admin')),
        enabled INTEGER NOT NULL DEFAULT 1,
        auth_source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        idle_expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        revoked_at TEXT,
        client_ip TEXT,
        user_agent TEXT
      );

      CREATE TABLE IF NOT EXISTS access_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('viewer','editor')),
        label TEXT NOT NULL DEFAULT '',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_uses INTEGER NOT NULL DEFAULT 1,
        use_count INTEGER NOT NULL DEFAULT 0,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        created_at TEXT NOT NULL,
        client_ip TEXT,
        details_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS author_resolution_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identity_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        douyin_id TEXT NOT NULL DEFAULT '',
        account_locator TEXT NOT NULL DEFAULT '',
        video_ids_json TEXT NOT NULL DEFAULT '[]',
        share_urls_json TEXT NOT NULL DEFAULT '[]',
        organization TEXT NOT NULL DEFAULT '',
        tier TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        boards_json TEXT NOT NULL DEFAULT '[]',
        source_rows_json TEXT NOT NULL DEFAULT '[]',
        file_name TEXT NOT NULL DEFAULT '',
        sheet_name TEXT NOT NULL DEFAULT '',
        source_metadata_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retry','resolved','rejected')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        resolved_target_id INTEGER REFERENCES targets(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        evidence_version INTEGER NOT NULL DEFAULT 1,
        verification_policy_version INTEGER NOT NULL DEFAULT 2,
        suspended_target_enabled INTEGER CHECK(suspended_target_enabled IN (0,1))
      );

      CREATE TABLE IF NOT EXISTS author_resolution_import_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id INTEGER REFERENCES author_resolution_queue(id) ON DELETE SET NULL,
        queue_identity_key TEXT NOT NULL,
        receipt_sha256 TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(queue_identity_key, receipt_sha256)
      );

      -- Successful strict identity evidence is immutable and independent of
      -- the target's latest metadata, which later works may legitimately replace.
      CREATE TABLE IF NOT EXISTS author_resolution_success_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id INTEGER NOT NULL,
        evidence_version INTEGER NOT NULL,
        identity_key TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        canonical_account_id TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        receipt_sha256 TEXT NOT NULL,
        UNIQUE(queue_id, evidence_version)
      );

      CREATE TABLE IF NOT EXISTS board_catalog (
        board_key TEXT PRIMARY KEY,
        board_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        source_type TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS target_boards (
        target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        board_key TEXT NOT NULL,
        board_name TEXT NOT NULL,
        organization TEXT NOT NULL DEFAULT '',
        tier TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        filled_date TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        conflicts_json TEXT NOT NULL DEFAULT '[]',
        source_type TEXT NOT NULL DEFAULT '',
        source_file_name TEXT NOT NULL DEFAULT '',
        source_sheet_name TEXT NOT NULL DEFAULT '',
        source_row INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(target_id, board_key)
      );

      CREATE TABLE IF NOT EXISTS author_resolution_jobs (
        id TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor_name TEXT NOT NULL,
        client_ip TEXT,
        file_name TEXT NOT NULL,
        sheet_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
        phase TEXT NOT NULL,
        total_authors INTEGER NOT NULL DEFAULT 0,
        request_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        version INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS author_resolution_idempotency (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
        job_id TEXT NOT NULL UNIQUE REFERENCES author_resolution_jobs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(user_id,idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_target ON posts(target_id, last_seen_at DESC);
      -- Read paths repeatedly ask for the latest row per target and for a
      -- publication window scoped to one target.  Keep the tie-breaker in
      -- the index so pagination/detail views do not sort every target's
      -- complete history in a temp B-tree.
      CREATE INDEX IF NOT EXISTS idx_posts_target_published ON posts(target_id, published_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_post_time ON post_metrics(post_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_post_captured_id ON post_metrics(post_id, captured_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_target_time ON snapshots(target_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_target_captured_id ON snapshots(target_id, captured_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_target_epoch_id ON snapshots(target_id, julianday(captured_at) DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_trigger_started ON runs(trigger_type, started_at DESC, id DESC);
      -- Cursor-chain verification asks whether the same author has an
      -- intervening completed works run. A trigger-only lookup scanned all
      -- authors' runs once for every selected evidence node.
      CREATE INDEX IF NOT EXISTS idx_runs_works_target_id ON runs(target_id,id)
        WHERE trigger_type='works-only' AND finished_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_audits_target_latest ON audits(target_id,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS idx_audits_run_target_created ON audits(run_id,target_id,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS idx_targets_enabled_type ON targets(enabled,type,id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(idle_expires_at, absolute_expires_at);
      CREATE INDEX IF NOT EXISTS idx_invites_expiry ON access_invites(expires_at, revoked_at);
      CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_target_state ON activity_log(resource_type,resource_id,action,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS idx_author_resolution_due ON author_resolution_queue(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_author_jobs_status_created ON author_resolution_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_author_resolution_success_identity ON author_resolution_success_receipts(identity_key, id);
      CREATE INDEX IF NOT EXISTS idx_author_resolution_success_target ON author_resolution_success_receipts(target_id, canonical_account_id, platform, id);
      CREATE INDEX IF NOT EXISTS idx_target_boards_key_target ON target_boards(board_key, target_id);
      CREATE INDEX IF NOT EXISTS idx_board_catalog_enabled_name ON board_catalog(enabled, board_name);
    `);

    initializeWorksOnlyObservations(this.db);
    const postColumns = new Set(this.db.prepare("PRAGMA table_info(posts)").all().map((column) => column.name));
    if (!postColumns.has("collects")) this.db.exec("ALTER TABLE posts ADD COLUMN collects INTEGER");
    const metricColumns = new Set(this.db.prepare("PRAGMA table_info(post_metrics)").all().map((column) => column.name));
    if (!metricColumns.has("collects")) this.db.exec("ALTER TABLE post_metrics ADD COLUMN collects INTEGER");
    const snapshotColumns = new Set(this.db.prepare("PRAGMA table_info(snapshots)").all().map((column) => column.name));
    if (!snapshotColumns.has("account_status")) this.db.exec("ALTER TABLE snapshots ADD COLUMN account_status TEXT NOT NULL DEFAULT 'unknown'");
    if (!snapshotColumns.has("works_coverage")) this.db.exec("ALTER TABLE snapshots ADD COLUMN works_coverage TEXT NOT NULL DEFAULT 'unknown'");
    if (!snapshotColumns.has("account_error")) this.db.exec("ALTER TABLE snapshots ADD COLUMN account_error TEXT");
    if (!snapshotColumns.has("works_error")) this.db.exec("ALTER TABLE snapshots ADD COLUMN works_error TEXT");
    if (!snapshotColumns.has("hashtag_participants")) this.db.exec("ALTER TABLE snapshots ADD COLUMN hashtag_participants INTEGER");
    if (!snapshotColumns.has("works_observed_at")) this.db.exec("ALTER TABLE snapshots ADD COLUMN works_observed_at TEXT");
    // Adding schema columns must not reinterpret existing observations.
    // Unknown is a real saved state, not evidence of complete works. Topic
    // counters in particular have no account works-coverage contract at all.
    // Historical quality corrections require a separate evidence audit and
    // explicit repair; ordinary startup must not reclassify stored snapshots.
    const runColumns = new Set(this.db.prepare("PRAGMA table_info(runs)").all().map((column) => column.name));
    if (!runColumns.has("processed_count")) this.db.exec("ALTER TABLE runs ADD COLUMN processed_count INTEGER NOT NULL DEFAULT 0");
    if (!runColumns.has("skipped_count")) this.db.exec("ALTER TABLE runs ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0");
    if (!runColumns.has("warning_count")) this.db.exec("ALTER TABLE runs ADD COLUMN warning_count INTEGER NOT NULL DEFAULT 0");
    if (!runColumns.has("heartbeat_at")) this.db.exec("ALTER TABLE runs ADD COLUMN heartbeat_at TEXT");
    if (!runColumns.has("current_target_id")) this.db.exec("ALTER TABLE runs ADD COLUMN current_target_id INTEGER");
    this.db.exec("UPDATE runs SET processed_count=success_count+error_count+skipped_count WHERE finished_at IS NOT NULL AND processed_count=0");
    this.db.prepare(`
      UPDATE author_resolution_queue
      SET status='rejected', last_error='达到公开核验重试上限；' || COALESCE(last_error,'公开读取仍未成功'), updated_at=?
      WHERE status='retry' AND attempts>=5
    `).run(nowIso());
    this.repairSecondBasedPublishedDates();

    const authorQueueColumns = new Set(this.db.prepare("PRAGMA table_info(author_resolution_queue)").all().map((column) => column.name));
    if (!authorQueueColumns.has("share_urls_json")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN share_urls_json TEXT NOT NULL DEFAULT '[]'");
    if (!authorQueueColumns.has("account_locator")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN account_locator TEXT NOT NULL DEFAULT ''");
    if (!authorQueueColumns.has("organization")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN organization TEXT NOT NULL DEFAULT ''");
    if (!authorQueueColumns.has("tier")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN tier TEXT NOT NULL DEFAULT ''");
    if (!authorQueueColumns.has("category")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    if (!authorQueueColumns.has("boards_json")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN boards_json TEXT NOT NULL DEFAULT '[]'");
    if (!authorQueueColumns.has("lease_owner")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN lease_owner TEXT");
    if (!authorQueueColumns.has("lease_until")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN lease_until TEXT");
    if (!authorQueueColumns.has("evidence_version")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN evidence_version INTEGER NOT NULL DEFAULT 1");
    if (!authorQueueColumns.has("source_metadata_json")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN source_metadata_json TEXT NOT NULL DEFAULT '{}'");
    if (!authorQueueColumns.has("verification_policy_version")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN verification_policy_version INTEGER NOT NULL DEFAULT 1");
    if (!authorQueueColumns.has("suspended_target_enabled")) this.db.exec("ALTER TABLE author_resolution_queue ADD COLUMN suspended_target_enabled INTEGER");
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_author_resolution_suspended_target_latest
      ON author_resolution_queue(resolved_target_id,updated_at DESC,id DESC)
      WHERE suspended_target_enabled IS NOT NULL`);
    const missingQueueLocators = this.db.prepare(`
      SELECT id,identity_key FROM author_resolution_queue WHERE account_locator=''
    `).all();
    const backfillQueueLocator = this.db.prepare(`
      UPDATE author_resolution_queue SET account_locator=? WHERE id=? AND account_locator=''
    `);
    for (const row of missingQueueLocators) {
      const explicit = explicitAccountLocatorFromIdentityKey(row.identity_key);
      if (explicit?.locator) backfillQueueLocator.run(explicit.locator, row.id);
    }

    const targetBoardColumns = new Set(this.db.prepare("PRAGMA table_info(target_boards)").all().map((column) => column.name));
    if (!targetBoardColumns.has("organization")) this.db.exec("ALTER TABLE target_boards ADD COLUMN organization TEXT NOT NULL DEFAULT ''");
    if (!targetBoardColumns.has("tier")) this.db.exec("ALTER TABLE target_boards ADD COLUMN tier TEXT NOT NULL DEFAULT ''");
    if (!targetBoardColumns.has("category")) this.db.exec("ALTER TABLE target_boards ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    if (!targetBoardColumns.has("owner")) this.db.exec("ALTER TABLE target_boards ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
    if (!targetBoardColumns.has("filled_date")) this.db.exec("ALTER TABLE target_boards ADD COLUMN filled_date TEXT NOT NULL DEFAULT ''");
    if (!targetBoardColumns.has("note")) this.db.exec("ALTER TABLE target_boards ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    if (!targetBoardColumns.has("conflicts_json")) this.db.exec("ALTER TABLE target_boards ADD COLUMN conflicts_json TEXT NOT NULL DEFAULT '[]'");

    const legacyBoardRows = this.db.prepare(`
      SELECT tb.target_id,tb.board_key,tb.organization,tb.tier,tb.category,tb.owner,tb.filled_date,tb.note,t.metadata_json
      FROM target_boards tb JOIN targets t ON t.id=tb.target_id
      WHERE tb.organization='' OR tb.tier='' OR tb.category='' OR tb.owner='' OR tb.filled_date='' OR tb.note=''
    `).all();
    const backfillBoardMetadata = this.db.prepare(`
      UPDATE target_boards SET organization=?,tier=?,category=?,owner=?,filled_date=?,note=?
      WHERE target_id=? AND board_key=?
    `);
    for (const row of legacyBoardRows) {
      const metadata = safeJson(row.metadata_json, {});
      backfillBoardMetadata.run(
        row.organization || compactBoardValue(metadata?.organization, 200),
        row.tier || compactBoardValue(metadata?.tier, 120),
        row.category || compactBoardValue(metadata?.category, 120),
        row.owner || compactBoardValue(metadata?.owner, 120),
        row.filled_date || compactBoardValue(metadata?.filledDate ?? metadata?.filled_date, 40),
        row.note || compactBoardValue(metadata?.note ?? metadata?.notes ?? metadata?.remark ?? metadata?.remarks, 500),
        Number(row.target_id), row.board_key,
      );
    }

    const authorJobColumns = new Set(this.db.prepare("PRAGMA table_info(author_resolution_jobs)").all().map((column) => column.name));
    if (!authorJobColumns.has("lease_owner")) this.db.exec("ALTER TABLE author_resolution_jobs ADD COLUMN lease_owner TEXT");
    if (!authorJobColumns.has("lease_until")) this.db.exec("ALTER TABLE author_resolution_jobs ADD COLUMN lease_until TEXT");
    if (!authorJobColumns.has("version")) this.db.exec("ALTER TABLE author_resolution_jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 0");

    const targetsSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='targets'").get()?.sql ?? "";
    if (/CHECK\s*\(\s*provider\s+IN/i.test(targetsSql)) {
      this.db.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN IMMEDIATE;
        CREATE TABLE targets_unconstrained (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('account','hashtag')),
          label TEXT NOT NULL,
          locator TEXT NOT NULL,
          provider TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_checked_at TEXT,
          next_check_at TEXT,
          last_status TEXT NOT NULL DEFAULT 'pending',
          last_error TEXT,
          UNIQUE(type, locator, provider)
        );
        INSERT INTO targets_unconstrained SELECT * FROM targets;
        DROP TABLE targets;
        ALTER TABLE targets_unconstrained RENAME TO targets;
        COMMIT;
        PRAGMA foreign_keys=ON;
      `);
    }

    const defaults = {
      scheduleTime: "10:00",
      viralLikeThreshold: "10000",
      viralRelativeMultiplier: "3",
      publicPostsPerAccount: "30",
      hashtagScope: "monitored-account-pool",
    };
    this.db.exec(`DELETE FROM settings WHERE key IN ('socialdataxEndpoint','socialdataxApiKey','tikhubEndpoint','tikhubApiKey')`);
    const insert = this.db.prepare("INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES(?,?,?)");
    const createdAt = nowIso();
    for (const [key, value] of Object.entries(defaults)) insert.run(key, value, createdAt);
  }

  repairStoredWorksCoverage() {
    // Deliberately not a startup migration. Audit the affected historical
    // evidence separately before explicitly invoking this legacy repair.
    const rows = this.db.prepare(`
      SELECT id,total_posts,works_coverage,warnings_json,raw_json
      FROM snapshots
      WHERE works_coverage='retry'
    `).all();
    if (!rows.length) return;
    const update = this.db.prepare(`
      UPDATE snapshots
      SET works_coverage=?, warnings_json=?, quality_status=?
      WHERE id=? AND works_coverage='retry'
    `);
    const latestWindowWarning = "匿名公开接口仅返回账号最新公开作品窗口；后续每日采集会持续累积，未将该窗口冒充完整历史";
    for (const row of rows) {
      const raw = safeJson(row.raw_json, {});
      const works = raw?.works && typeof raw.works === "object" ? raw.works : null;
      const hasExplicitWorks = Array.isArray(works?.aweme_list)
        || Array.isArray(works?.video_list)
        || Array.isArray(works?.items)
        || Array.isArray(works?.posts);
      if (!hasExplicitWorks) continue;
      const provenance = raw?.provenance && typeof raw.provenance === "object" ? raw.provenance : {};
      const sourceScope = String(provenance.worksCoverage ?? provenance.worksScope ?? "").trim();
      const warnings = safeJson(row.warnings_json, []);
      const normalizedWarnings = Array.isArray(warnings) ? warnings.map(String) : [];
      if (Number(row.total_posts) === 0) {
        const cleanedWarnings = normalizedWarnings.filter((warning) => !/未识别到作品列表|作品列表接口未通过/.test(warning));
        update.run("complete", JSON.stringify(cleanedWarnings), cleanedWarnings.length ? "warning" : "validated", row.id);
        continue;
      }
      if (["latest-public-window", "limited"].includes(sourceScope) || works.public_window_limited === true) {
        const nextWarnings = normalizedWarnings.includes(latestWindowWarning)
          ? normalizedWarnings
          : [...normalizedWarnings, latestWindowWarning];
        update.run("limited", JSON.stringify([...new Set(nextWarnings)]), "warning", row.id);
      }
    }
  }

  repairSecondBasedPublishedDates() {
    const affected = this.db.prepare(`
      SELECT id, raw_json FROM posts
      WHERE published_at >= '1970-01-01' AND published_at < '2000-01-01'
    `).all();
    if (!affected.length) return;
    const update = this.db.prepare("UPDATE posts SET published_at=? WHERE id=?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of affected) {
        const raw = safeJson(row.raw_json, {});
        const repaired = asIsoDate(raw?.create_time ?? raw?.publish_time ?? raw?.published_at);
        if (repaired && repaired >= "2000-01-01") update.run(repaired, row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.db.close(); }

  recoverInterruptedRuns(reference = nowIso()) {
    return this.db.prepare(`
      UPDATE runs SET status='interrupted', finished_at=?, heartbeat_at=?, current_target_id=NULL
      WHERE status='running'
    `).run(reference, reference).changes;
  }

  requeueInterruptedAuthorJobs(reference = nowIso()) {
    return this.db.prepare(`
      UPDATE author_resolution_jobs
      SET status='queued', phase='queued', error=NULL, lease_owner=NULL, lease_until=NULL, updated_at=?
      WHERE status='running' AND (lease_until IS NULL OR lease_until<=?)
    `).run(reference, reference).changes;
  }

  countLegacyPartialEvidenceVerifications() {
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM author_resolution_queue q
      JOIN targets t ON t.id=q.resolved_target_id
      WHERE q.verification_policy_version<2 AND q.status='resolved'
        AND (
          (json_array_length(q.video_ids_json)+json_array_length(q.share_urls_json))>1
          OR (
            (json_array_length(q.video_ids_json)+json_array_length(q.share_urls_json))=0
            AND (q.identity_key LIKE 'share:%' OR q.identity_key LIKE 'bilibili:share:%')
          )
        )
    `).get()?.count ?? 0);
  }

  requeueLegacyPartialEvidenceVerifications(reference = nowIso()) {
    const legacy = this.db.prepare(`
      SELECT q.id,q.identity_key,q.status,q.resolved_target_id,q.video_ids_json,q.share_urls_json,
             t.enabled AS target_enabled
      FROM author_resolution_queue q
      LEFT JOIN targets t ON t.id=q.resolved_target_id
      WHERE q.verification_policy_version<2
      ORDER BY q.id
    `).all();
    if (!legacy.length) return { reviewed: 0, requeued: 0, suspendedTargets: 0, legacyUnverifiable: 0 };
    const requeue = this.db.prepare(`
      UPDATE author_resolution_queue
      SET status='pending', attempts=0, next_attempt_at=?,
          last_error='历史多作品核验只覆盖了首项证据；已自动暂停原监控并转入逐项复核',
          lease_owner=NULL,lease_until=NULL,evidence_version=evidence_version+1,
          verification_policy_version=2,suspended_target_enabled=?,updated_at=?
      WHERE id=? AND verification_policy_version<2
    `);
    const markCurrent = this.db.prepare(`
      UPDATE author_resolution_queue
      SET verification_policy_version=2,updated_at=?
      WHERE id=? AND verification_policy_version<2
    `);
    const rejectLostSharePath = this.db.prepare(`
      UPDATE author_resolution_queue
      SET status='rejected',attempts=attempts+1,
          last_error='历史短链仅保留了被小写化的标识，原始路径大小写不可恢复；请重新提交原始分享链接',
          lease_owner=NULL,lease_until=NULL,verification_policy_version=2,suspended_target_enabled=?,updated_at=?
      WHERE id=? AND verification_policy_version<2
    `);
    const suspendTarget = this.db.prepare("UPDATE targets SET enabled=0,updated_at=? WHERE id=?");
    const recordTargetState = this.db.prepare(`
      INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
      VALUES('系统','target.state','target',?,?,?)
    `);
    const audit = this.db.prepare(`
      INSERT INTO audits(target_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message)
      VALUES(?,?,'public-web','warning',0,?,?,?)
    `);
    const rejectedAudit = this.db.prepare(`
      INSERT INTO audits(target_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message)
      VALUES(?,?,'public-web','rejected',0,?,?,?)
    `);
    let requeued = 0;
    let suspendedTargets = 0;
    let legacyUnverifiable = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of legacy) {
        const evidenceCount = safeJson(row.video_ids_json, []).length + safeJson(row.share_urls_json, []).length;
        const lostSharePath = evidenceCount === 0 && /^(?:bilibili:)?share:/i.test(String(row.identity_key ?? ""));
        if (lostSharePath) {
          const linkedTarget = row.resolved_target_id != null && row.target_enabled != null;
          const wasEnabled = linkedTarget ? Number(Boolean(row.target_enabled)) : null;
          if (wasEnabled === 1) {
            suspendTarget.run(reference, row.resolved_target_id);
            recordTargetState.run(String(row.resolved_target_id), reference, JSON.stringify({ enabled: false, source: "strict-identity-review" }));
            suspendedTargets += 1;
          }
          rejectLostSharePath.run(wasEnabled, reference, row.id);
          if (linkedTarget) {
            rejectedAudit.run(
              row.resolved_target_id,
              reference,
              JSON.stringify(["历史短链的原始路径大小写已经丢失；账号已暂停，必须重新提交完整原始分享链接"]),
              checksum({ queueId: Number(row.id), identityKey: row.identity_key, policy: "case-preserved-share-v2" }),
              "严格身份复核已阻止：旧短链无法安全还原；请重新提交完整原始分享链接后核验",
            );
          }
          legacyUnverifiable += 1;
          continue;
        }
        const needsStrictReplay = row.status === "resolved" && row.resolved_target_id != null && row.target_enabled != null && evidenceCount > 1;
        if (!needsStrictReplay) {
          markCurrent.run(reference, row.id);
          continue;
        }
        const wasEnabled = Number(Boolean(row.target_enabled));
        if (wasEnabled) {
          suspendTarget.run(reference, row.resolved_target_id);
          recordTargetState.run(String(row.resolved_target_id), reference, JSON.stringify({ enabled: false, source: "strict-identity-review" }));
          suspendedTargets += 1;
        }
        requeue.run(reference, wasEnabled, reference, row.id);
        audit.run(
          row.resolved_target_id,
          reference,
          JSON.stringify(["历史版本只核验了多项作品证据中的第一项；该账号已暂停，等待全部作品逐项确认同一作者"]),
          checksum({ queueId: Number(row.id), identityKey: row.identity_key, policy: "all-evidence-v2", evidenceCount }),
          `严格身份复核：历史记录含 ${evidenceCount} 项作品证据，原监控已暂停；全部证据确认同一作者后才会自动恢复`,
        );
        requeued += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { reviewed: legacy.length, requeued, suspendedTargets, legacyUnverifiable };
  }

  releaseAuthorResolutionJobs(owner, reference = nowIso()) {
    const worker = String(owner ?? "").slice(0, 120);
    if (!worker) return 0;
    return this.db.prepare(`
      UPDATE author_resolution_jobs
      SET status='queued', phase='queued', error=NULL, lease_owner=NULL, lease_until=NULL, updated_at=?
      WHERE status='running' AND lease_owner=?
    `).run(reference, worker).changes;
  }

  releaseAuthorResolutionQueue(owner, reference = nowIso()) {
    const worker = String(owner ?? "").slice(0, 120);
    if (!worker) return 0;
    return this.db.prepare(`
      UPDATE author_resolution_queue
      SET lease_owner=NULL, lease_until=NULL, updated_at=?
      WHERE status IN ('pending','retry') AND lease_owner=?
    `).run(reference, worker).changes;
  }

  ensureLocalOwner() {
    let row = this.db.prepare("SELECT * FROM users WHERE auth_source='local-owner' ORDER BY id LIMIT 1").get();
    if (!row) {
      const timestamp = nowIso();
      const result = this.db.prepare(`
        INSERT INTO users(display_name,role,enabled,auth_source,created_at,updated_at)
        VALUES('本机管理员','admin',1,'local-owner',?,?)
      `).run(timestamp, timestamp);
      row = this.db.prepare("SELECT * FROM users WHERE id=?").get(Number(result.lastInsertRowid));
    }
    return toUser(row);
  }

  createSession({ tokenHash, userId, csrfToken, createdAt, idleExpiresAt, absoluteExpiresAt, clientIp, userAgent }) {
    this.db.prepare(`
      INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_seen_at,idle_expires_at,absolute_expires_at,client_ip,user_agent)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(tokenHash, Number(userId), csrfToken, createdAt, createdAt, idleExpiresAt, absoluteExpiresAt, clientIp ?? null, String(userAgent ?? "").slice(0, 300));
  }

  getSession(tokenHash, { now, idleExpiresAt }) {
    const row = this.db.prepare(`
      SELECT s.*, u.display_name, u.role, u.enabled, u.auth_source, u.updated_at
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND u.enabled=1
        AND s.idle_expires_at>? AND s.absolute_expires_at>?
    `).get(tokenHash, now, now);
    if (!row) return null;
    const nextIdleExpiry = idleExpiresAt < row.absolute_expires_at ? idleExpiresAt : row.absolute_expires_at;
    const heartbeat = this.db.prepare("UPDATE sessions SET last_seen_at=?, idle_expires_at=? WHERE token_hash=?")
      .run(now, nextIdleExpiry, tokenHash);
    // Only the direct, known authentication heartbeat is non-business work.
    // Trigger side effects and every unknown/cross-connection write still
    // invalidate a pending plan; source data never enters this counter.
    this.sessionHeartbeatChanges = (this.sessionHeartbeatChanges ?? 0) + Number(heartbeat.changes);
    return {
      tokenHash,
      csrfToken: row.csrf_token,
      absoluteExpiresAt: row.absolute_expires_at,
      user: toUser({ ...row, id: row.user_id }),
    };
  }

  revokeSession(tokenHash, revokedAt = nowIso()) {
    return this.db.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(revokedAt, tokenHash).changes > 0;
  }

  purgeExpiredAccess(now = nowIso()) {
    this.db.prepare("DELETE FROM sessions WHERE revoked_at IS NOT NULL OR absolute_expires_at<=?").run(now);
  }

  createInvite({ codeHash, role, label, createdBy, createdAt, expiresAt, maxUses }) {
    const result = this.db.prepare(`
      INSERT INTO access_invites(code_hash,role,label,created_by,created_at,expires_at,max_uses)
      VALUES(?,?,?,?,?,?,?)
    `).run(codeHash, role, label, Number(createdBy), createdAt, expiresAt, Number(maxUses));
    return Number(result.lastInsertRowid);
  }

  consumeInvite({ codeHash, displayName, tokenHash, csrfToken, createdAt, idleExpiresAt, absoluteExpiresAt, clientIp, userAgent }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const invite = this.db.prepare(`
        SELECT * FROM access_invites
        WHERE code_hash=? AND revoked_at IS NULL AND expires_at>? AND use_count<max_uses
      `).get(codeHash, createdAt);
      if (!invite) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const userResult = this.db.prepare(`
        INSERT INTO users(display_name,role,enabled,auth_source,created_at,updated_at)
        VALUES(?,?,1,'invite',?,?)
      `).run(displayName, invite.role, createdAt, createdAt);
      const userId = Number(userResult.lastInsertRowid);
      this.db.prepare(`
        INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_seen_at,idle_expires_at,absolute_expires_at,client_ip,user_agent)
        VALUES(?,?,?,?,?,?,?,?,?)
      `).run(tokenHash, userId, csrfToken, createdAt, createdAt, idleExpiresAt, absoluteExpiresAt, clientIp ?? null, String(userAgent ?? "").slice(0, 300));
      this.db.prepare("UPDATE access_invites SET use_count=use_count+1 WHERE id=?").run(invite.id);
      this.db.exec("COMMIT");
      return toUser(this.db.prepare("SELECT * FROM users WHERE id=?").get(userId));
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  listAccess(now = nowIso()) {
    const activeSince = new Date(new Date(now).getTime() - 5 * 60_000).toISOString();
    const members = this.db.prepare(`
      SELECT u.*, MAX(s.last_seen_at) AS last_seen_at,
             COUNT(CASE WHEN s.revoked_at IS NULL AND s.last_seen_at>=? AND s.idle_expires_at>? AND s.absolute_expires_at>? THEN 1 END) AS active_session_count
      FROM users u LEFT JOIN sessions s ON s.user_id=u.id
      GROUP BY u.id ORDER BY u.auth_source='local-owner' DESC, u.created_at DESC
    `).all(activeSince, now, now).map(toUser);
    const invites = this.db.prepare(`
      SELECT id,role,label,created_at,expires_at,max_uses,use_count,revoked_at
      FROM access_invites ORDER BY created_at DESC LIMIT 100
    `).all().map((row) => ({
      id: Number(row.id), role: row.role, label: row.label, createdAt: row.created_at,
      expiresAt: row.expires_at, maxUses: Number(row.max_uses), useCount: Number(row.use_count),
      revoked: Boolean(row.revoked_at), expired: row.expires_at <= now,
    }));
    const activity = this.db.prepare(`
      SELECT id,actor_name,action,resource_type,resource_id,created_at,details_json
      FROM activity_log ORDER BY created_at DESC LIMIT 40
    `).all().map((row) => {
      const details = safeJson(row.details_json, {});
      if (row.action === 'author-resolution.authorised-reconsideration') {
        // Keep the exact prior transport failure only in the local audit
        // storage. Admin HTTP responses also must not echo upstream secrets.
        if (details?.previous && typeof details.previous === 'object') delete details.previous.lastError;
        return { ...row, id: Number(row.id), details_json: JSON.stringify(details), details };
      }
      return { ...row, id: Number(row.id), details };
    });
    return { members, invites, activity };
  }

  revokeInvite(id, revokedAt = nowIso()) {
    return this.db.prepare("UPDATE access_invites SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(revokedAt, Number(id)).changes > 0;
  }

  updateMember(id, values) {
    const current = this.db.prepare("SELECT * FROM users WHERE id=?").get(Number(id));
    if (!current) return null;
    if (current.auth_source === "local-owner") return toUser(current);
    const role = values.role ?? current.role;
    const enabled = values.enabled === undefined ? Number(current.enabled) : Number(Boolean(values.enabled));
    this.db.prepare("UPDATE users SET role=?, enabled=?, updated_at=? WHERE id=?").run(role, enabled, nowIso(), Number(id));
    if (!enabled) this.db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(nowIso(), Number(id));
    return toUser(this.db.prepare("SELECT * FROM users WHERE id=?").get(Number(id)));
  }

  recordActivity({ userId, actorName, action, resourceType, resourceId = null, clientIp = null, details = {} }) {
    this.db.prepare(`
      INSERT INTO activity_log(user_id,actor_name,action,resource_type,resource_id,created_at,client_ip,details_json)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(Number(userId) || null, actorName, action, resourceType, resourceId === null ? null : String(resourceId), nowIso(), clientIp, JSON.stringify(details));
  }

  getSettings() {
    const rows = this.db.prepare("SELECT key, value FROM settings").all();
    return { ...BROWSER_WORKS_SETTING_DEFAULTS, ...Object.fromEntries(rows.map((row) => [row.key, row.value])) };
  }

  recordSourceProbe(provider, payload = {}) {
    const result = payload && typeof payload === "object" ? payload : {};
    const compact = {
      ok: Boolean(result.ok),
      ...(result.trigger ? { trigger: String(result.trigger).slice(0, 40) } : {}),
      ...(Number.isFinite(Number(result.durationMs)) && Number(result.durationMs) >= 0
        ? { durationMs: Math.min(900_000, Math.round(Number(result.durationMs))) }
        : {}),
      ...(result.result && typeof result.result === "object" ? { result: result.result } : {}),
      ...(result.error ? { error: String(result.error).slice(0, 500) } : {}),
    };
    const checkedAt = nowIso();
    this.db.prepare("INSERT INTO source_probes(provider,checked_at,result_json) VALUES(?,?,?)")
      .run(String(provider || "unknown").slice(0, 80), checkedAt, JSON.stringify(compact));
    return { provider: String(provider || "unknown").slice(0, 80), checkedAt, ...compact };
  }

  getLatestSourceProbe(provider = "douyin-public") {
    const row = this.db.prepare("SELECT provider, checked_at, result_json FROM source_probes WHERE provider=? ORDER BY checked_at DESC, id DESC LIMIT 1").get(String(provider));
    if (!row) return null;
    const payload = safeJson(row.result_json, {});
    return { provider: row.provider, checkedAt: row.checked_at, ...(payload && typeof payload === "object" ? payload : {}) };
  }

  getLatestSourceProbes() {
    const rows = this.db.prepare("SELECT provider, checked_at, result_json FROM source_probes ORDER BY checked_at DESC, id DESC").all();
    const latest = new Map();
    for (const row of rows) {
      if (latest.has(row.provider)) continue;
      const payload = safeJson(row.result_json, {});
      latest.set(row.provider, {
        provider: row.provider,
        checkedAt: row.checked_at,
        ...(payload && typeof payload === "object" ? payload : {}),
      });
    }
    return [...latest.values()].sort((left, right) => String(left.provider).localeCompare(String(right.provider)));
  }

  getRecentSourceProbes(limit = 24) {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 24)));
    return this.db.prepare("SELECT provider, checked_at, result_json FROM source_probes ORDER BY checked_at DESC, id DESC LIMIT ?")
      .all(boundedLimit)
      .map((row) => {
        const payload = safeJson(row.result_json, {});
        return {
          provider: row.provider,
          checkedAt: row.checked_at,
          ...(payload && typeof payload === "object" ? payload : {}),
        };
      });
  }

  setSettings(values) {
    const allowed = new Set(["scheduleTime", "viralLikeThreshold", "viralRelativeMultiplier", "publicPostsPerAccount"]);
    const entries = Object.entries(values).flatMap(([key, value]) => {
      if (!allowed.has(key) || value === undefined) return [];
      if (key === "scheduleTime") {
        const normalized = parseTimeOfDay(value, "");
        if (!normalized) throw new Error("每日采集时间必须是 00:00–23:59");
        return [[key, normalized]];
      }
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`${key} 必须是有效数字`);
      if (key === "viralLikeThreshold" && number < 0) throw new Error("爆款点赞阈值不能小于 0");
      if (key === "viralRelativeMultiplier" && number < 1) throw new Error("相对爆款倍数不能小于 1");
      if (key === "publicPostsPerAccount" && (!Number.isInteger(number) || number < 1 || number > 100)) {
        throw new Error("单账号作品数必须是 1–100 之间的整数");
      }
      return [[key, String(number)]];
    });
    const statement = this.db.prepare(`
      INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);
    const updatedAt = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Validate cross-field policy against the locked current snapshot so
      // two writers cannot each validate a different half of an invalid pair.
      entries.push(...Object.entries(validateBrowserWorksSettingsUpdate(values, this.getSettings())));
      for (const [key, value] of entries) statement.run(key, value, updatedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getSettings();
  }

  listBoards() {
    const boards = this.db.prepare(`
      SELECT catalog.board_key AS key, catalog.board_name AS name,
             COUNT(DISTINCT CASE WHEN t.enabled=1 AND t.type='account' THEN t.id END) AS target_count
      FROM board_catalog catalog
      LEFT JOIN target_boards tb ON tb.board_key=catalog.board_key
      LEFT JOIN targets t ON t.id=tb.target_id
      WHERE catalog.enabled=1
      GROUP BY catalog.board_key,catalog.board_name
      ORDER BY catalog.board_name COLLATE NOCASE
    `).all().map((row) => ({
      key: row.key,
      name: row.name,
      targetCount: Number(row.target_count ?? 0),
      queuedCount: 0,
      pendingCount: 0,
      rejectedCount: 0,
    }));
    const catalogByKey = new Map(boards.map((board) => [board.key, board]));
    let unassignedQueuedCount = 0;
    let unassignedPendingCount = 0;
    let unassignedRejectedCount = 0;
    const queuedRows = this.db.prepare(`
      SELECT id,status,boards_json FROM author_resolution_queue
      WHERE status<>'resolved' AND resolved_target_id IS NULL
    `).all();
    for (const row of queuedRows) {
      // Legacy rows may store strings and newer rows store metadata objects.
      // Normalization also deduplicates repeated board names within one row.
      const storedBoards = safeJson(row.boards_json, []);
      const memberships = normalizedBoardEntries(Array.isArray(storedBoards) ? storedBoards : []);
      if (!memberships.length) {
        unassignedQueuedCount += 1;
        if (row.status === "rejected") unassignedRejectedCount += 1;
        else if (row.status === "pending" || row.status === "retry") unassignedPendingCount += 1;
      }
      for (const membership of memberships) {
        const board = catalogByKey.get(membership.key);
        if (!board) continue;
        board.queuedCount += 1;
        if (row.status === "rejected") board.rejectedCount += 1;
        else if (row.status === "pending" || row.status === "retry") board.pendingCount += 1;
      }
    }
    Object.defineProperties(boards, {
      unassignedQueuedCount: { value: unassignedQueuedCount, enumerable: false },
      unassignedPendingCount: { value: unassignedPendingCount, enumerable: false },
      unassignedRejectedCount: { value: unassignedRejectedCount, enumerable: false },
    });
    return boards;
  }

  createBoard(name, { sourceType = "manual" } = {}) {
    const boardName = validatedBoardName(name);
    const key = normalizeBoardKey(boardName);
    registerBoard(this.db, boardName, compactBoardValue(sourceType, 40) || "manual", nowIso());
    return this.listBoards().find((board) => board.key === key);
  }

  assignTargetsToBoard(targetIds, boardName, { sourceType = "manual", sourceFileName = "", note = "" } = {}) {
    const name = validatedBoardName(boardName);
    const key = normalizeBoardKey(name);
    if (!Array.isArray(targetIds) || !targetIds.length) throw new Error("请至少选择一个作者");
    if (targetIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error("作者 ID 必须是正整数");
    }
    const uniqueTargetIds = [...new Set(targetIds)];
    const source = {
      type: compactBoardValue(sourceType, 40) || "manual",
      fileName: compactBoardValue(sourceFileName, 240),
    };
    const timestamp = nowIso();
    let added = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const findTarget = this.db.prepare("SELECT id,type FROM targets WHERE id=?");
      for (const id of uniqueTargetIds) {
        const target = findTarget.get(id);
        if (!target) throw new Error(`作者 ID ${id} 不存在，未保存本次板块归属`);
        if (!["account", "hashtag"].includes(target.type)) throw new Error(`目标 ID ${id} 不是可归类的监控对象，未保存本次板块归属`);
      }
      registerBoard(this.db, name, source.type, timestamp);
      const canonicalName = this.db.prepare("SELECT board_name FROM board_catalog WHERE board_key=?").get(key).board_name;
      const findMembership = this.db.prepare("SELECT 1 FROM target_boards WHERE target_id=? AND board_key=?");
      for (const id of uniqueTargetIds) {
        // Repeated assignment must not replace the membership's original
        // metadata or provenance, or alter the monitored target itself.
        if (findMembership.get(id, key)) continue;
        added += attachTargetBoards(this.db, id, [{ name: canonicalName, note }], source, timestamp).added;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      board: this.listBoards().find((board) => board.key === key),
      requestedCount: targetIds.length,
      uniqueTargetCount: uniqueTargetIds.length,
      added,
      existing: uniqueTargetIds.length - added,
      targetIds: uniqueTargetIds,
    };
  }

  listTargets({ board = null } = {}) {
    const boardKey = normalizeBoardKey(board);
    const boardScope = targetBoardScopeSql("t", boardKey);
    const rows = this.db.prepare(`
      SELECT t.*, COUNT(DISTINCT p.id) AS known_posts,
             MAX(CASE WHEN t.type='account' THEN p.author_id END) AS known_author_id,
             (SELECT quality_status FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS quality_status,
             (SELECT warnings_json FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS latest_warnings_json,
             (SELECT account_status FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS latest_account_status,
             (SELECT works_coverage FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS latest_works_coverage,
             (SELECT account_error FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS latest_account_error,
             (SELECT works_error FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS latest_works_error,
             (SELECT hashtag_participants FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS latest_hashtag_participants,
             (SELECT hashtag_participants FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1 OFFSET 1) AS previous_hashtag_participants,
             (SELECT quality_status FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1 OFFSET 1) AS previous_quality_status,
             (SELECT hashtag_views FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS latest_hashtag_views,
             (SELECT hashtag_views FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1 OFFSET 1) AS previous_hashtag_views,
             (SELECT hashtag_posts FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS latest_hashtag_posts,
             (SELECT author_count FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS latest_author_count,
             (SELECT captured_at FROM snapshots s WHERE s.target_id=t.id ORDER BY captured_at DESC,s.id DESC LIMIT 1) AS latest_snapshot_at,
             (SELECT normalized_post_count FROM audits a WHERE a.target_id=t.id ORDER BY created_at DESC,a.id DESC LIMIT 1) AS latest_normalized_post_count,
             (SELECT q.status FROM author_resolution_queue q
               WHERE q.resolved_target_id=t.id AND q.suspended_target_enabled IS NOT NULL
               ORDER BY q.updated_at DESC,q.id DESC LIMIT 1) AS strict_identity_status,
             (SELECT q.last_error FROM author_resolution_queue q
               WHERE q.resolved_target_id=t.id AND q.suspended_target_enabled IS NOT NULL
               ORDER BY q.updated_at DESC,q.id DESC LIMIT 1) AS strict_identity_error
      FROM targets t LEFT JOIN posts p ON p.target_id=t.id
      WHERE ${boardScope.clause}
      GROUP BY t.id ORDER BY t.enabled DESC, t.created_at DESC
    `).all(...boardScope.params);
    if (!rows.length) return [];
    const ids = rows.map((row) => Number(row.id));
    const placeholders = ids.map(() => "?").join(",");
    const boardRows = this.db.prepare(`
      SELECT * FROM target_boards
      WHERE target_id IN (${placeholders}) ORDER BY board_name COLLATE NOCASE
    `).all(...ids);
    const boardsByTarget = new Map();
    for (const row of boardRows) {
      const targetId = Number(row.target_id);
      if (!boardsByTarget.has(targetId)) boardsByTarget.set(targetId, []);
      boardsByTarget.get(targetId).push(boardFromRow(row));
    }
    return rows.map((row) => toTarget(row, boardsByTarget.get(Number(row.id)) ?? []));
  }

  listTopicHistory({ startDate, endDate } = {}) {
    const range = topicHistoryDateKeys(String(startDate ?? ""), String(endDate ?? ""));
    // Read exactly one adjacent Beijing business day for the first point's
    // baseline. It is evidence only, never an extra returned/counted day.
    const baselineDate = shiftCalendarDate(range.dates[0], -1);
    const endExclusive = new Date(range.end);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    const generatedAt = nowIso();
    const targets = this.db.prepare("SELECT id,label,enabled,provider,locator FROM targets WHERE type='hashtag' ORDER BY enabled DESC,label COLLATE NOCASE,id").all();
    const byTopic = new Map(targets.map(row => [Number(row.id), {
      id: Number(row.id), type: 'hashtag', label: row.label, enabled: Boolean(row.enabled),
      provider: row.provider, locator: row.locator, points: new Map(),
      latestKnown: { participants: null, views: null },
    }]));
    // Topic rows are few and are streamed in calendar order. This lets the
    // read model locate the latest *verified* observation even if a newer
    // stored row is manual, corrupt, or missing its source audit. The final
    // observation of each Beijing day wins before validation, so bad later
    // rows cannot fall back to earlier same-day values.
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT s.id AS snapshot_id,s.target_id,s.captured_at,s.hashtag_participants,s.hashtag_views,
          s.quality_status,s.warnings_json,s.source_checksum,s.raw_json,
          date(s.captured_at,'+8 hours') AS business_date,
          ROW_NUMBER() OVER (
            PARTITION BY s.target_id,date(s.captured_at,'+8 hours')
            ORDER BY julianday(s.captured_at) DESC,s.id DESC
          ) AS daily_rank
        FROM snapshots s JOIN targets t ON t.id=s.target_id
        WHERE t.type='hashtag' AND julianday(s.captured_at)<julianday(?)
          AND julianday(s.captured_at)<=julianday(?)
      )
      SELECT ranked.*,a.id AS audit_id,a.target_id AS audit_target_id,
        a.provider AS audit_provider,a.status AS audit_status,a.source_checksum AS audit_checksum,
        a.created_at AS audit_created_at,a.run_id,
        r.target_id AS run_target_id,r.status AS run_status,r.started_at,r.finished_at
      FROM ranked
      LEFT JOIN audits a ON a.id=(
        SELECT candidate.id FROM audits candidate
        WHERE candidate.target_id=ranked.target_id
          AND candidate.source_checksum=ranked.source_checksum
          AND julianday(candidate.created_at)>=julianday(ranked.captured_at)
          AND julianday(candidate.created_at)<=julianday(?)
        ORDER BY CASE WHEN candidate.provider='public-web' AND candidate.status=ranked.quality_status THEN 0 ELSE 1 END,
          julianday(candidate.created_at),candidate.id LIMIT 1
      )
      LEFT JOIN runs r ON r.id=a.run_id
      WHERE ranked.daily_rank=1
      ORDER BY ranked.target_id,ranked.business_date
    `).iterate(endExclusive.toISOString(), generatedAt, generatedAt);
    const lastDailyByTopic = new Map();
    for (const row of rows) {
      const id = Number(row.target_id);
      const topic = byTopic.get(id);
      if (!topic || !row.snapshot_id || !row.captured_at) continue;
      const capturedAt = new Date(row.captured_at);
      if (!Number.isFinite(capturedAt.getTime())) continue;
      const date = row.business_date || businessDateKey(capturedAt);
      const evidence = validateTopicSnapshot({ ...row, id: Number(row.snapshot_id) }, topic, { asOf: Date.parse(generatedAt) });
      const qualityStatus = row.quality_status === 'rejected' ? 'rejected'
        : evidence.valid ? row.quality_status : 'unverified';
      const point = {
        date,
        capturedAt: capturedAt.toISOString(),
        participants: evidence.valid ? evidence.participants : null,
        views: evidence.valid ? evidence.views : null,
        posts: null,
        authorCount: null,
        qualityStatus: qualityStatus || "unverified",
        storedQualityStatus: row.quality_status || null,
        sourceVerified: evidence.valid,
        sourceVerificationReason: evidence.reason,
        accountStatus: "unknown",
        warningCount: Array.isArray(safeJson(row.warnings_json, [])) ? safeJson(row.warnings_json, []).length : 0,
        sourceChecksum: row.source_checksum || null,
        snapshotId: Number(row.snapshot_id),
      };
      const previous = lastDailyByTopic.get(id);
      for (const [field, value] of [['participants', point.participants], ['views', point.views]]) {
        if (!Number.isSafeInteger(value) || value < 0) continue;
        const baseline = previous?.date === shiftCalendarDate(date, -1)
          && Number.isSafeInteger(previous[field]) && previous[field] >= 0 ? previous : null;
        topic.latestKnown[field] = {
          date, capturedAt: point.capturedAt, value,
          delta: baseline ? value - baseline[field] : null,
          baselineDate: baseline?.date ?? null,
          baselineCapturedAt: baseline?.capturedAt ?? null,
          sourceChecksum: point.sourceChecksum,
          snapshotId: point.snapshotId,
          qualityStatus: point.qualityStatus,
          sourceVerified: true,
        };
      }
      if (date >= baselineDate && date <= String(endDate)) topic.points.set(date, point);
      lastDailyByTopic.set(id, point);
    }
    const orderedDates = range.dates;
    return {
      startDate: String(startDate),
      endDate: String(endDate),
      days: orderedDates.length,
      timeZone: "Asia/Shanghai",
      generatedAt,
      topics: [...byTopic.values()].map((topic) => {
        const points = orderedDates.map((date) => {
          const point = topic.points.get(date) || {
            date,
            capturedAt: null,
            participants: null,
            views: null,
            posts: null,
            authorCount: null,
            qualityStatus: "missing",
            accountStatus: "unknown",
            warningCount: 0,
            sourceChecksum: null,
            snapshotId: null,
          };
          // An older available sample is not a daily baseline. A missing or
          // rejected prior day must leave each affected metric's delta null.
          const previous = topic.points.get(shiftCalendarDate(date, -1));
          const delta = (current, prior) => Number.isFinite(current) && Number.isFinite(prior)
            ? current - prior
            : null;
          return {
            ...point,
            baselineDate: previous?.date ?? null,
            baselineCapturedAt: previous?.capturedAt ?? null,
            baselineSourceChecksum: previous?.sourceChecksum ?? null,
            baselineQualityStatus: previous?.qualityStatus ?? null,
            participantsDelta: delta(point.participants, previous?.participants),
            viewsDelta: delta(point.views, previous?.views),
          };
        });
        const sampledPoints = points.filter((point) => point.capturedAt);
        const observedPoints = points.filter((point) => point.participants !== null || point.views !== null);
        const participantsObservedPoints = points.filter((point) => Number.isFinite(point.participants));
        const viewsObservedPoints = points.filter((point) => Number.isFinite(point.views));
        return {
          id: topic.id,
          label: topic.label,
          enabled: topic.enabled,
          latestAt: observedPoints.at(-1)?.capturedAt || null,
          observedCount: observedPoints.length,
          sampledCount: sampledPoints.length,
          missingCount: points.length - observedPoints.length,
          participantsObservedCount: participantsObservedPoints.length,
          participantsMissingCount: points.length - participantsObservedPoints.length,
          viewsObservedCount: viewsObservedPoints.length,
          viewsMissingCount: points.length - viewsObservedPoints.length,
          latestKnown: {
            participants: topic.latestKnown.participants,
            views: topic.latestKnown.views,
          },
          points,
        };
      }),
    };
  }

  listTargetAudits(targetId, limit = 20) {
    return this.db.prepare(`
      SELECT id,target_id,run_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message
      FROM audits WHERE target_id=?
      ORDER BY created_at DESC,id DESC LIMIT ?
    `).all(Number(targetId), Math.max(1, Math.min(100, Number(limit) || 20))).map((row) => ({
      ...row,
      warnings: safeJson(row.warnings_json, []),
      warnings_json: undefined,
    }));
  }

  getTarget(id) {
    const row = this.db.prepare(`
      SELECT t.*,
             (SELECT quality_status FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1) AS quality_status,
             (SELECT quality_status FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1 OFFSET 1) AS previous_quality_status,
             (SELECT account_status FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1) AS latest_account_status,
             (SELECT works_coverage FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1) AS latest_works_coverage,
             (SELECT account_error FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1) AS latest_account_error,
             (SELECT works_error FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1) AS latest_works_error,
             (SELECT hashtag_participants FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1) AS latest_hashtag_participants,
             (SELECT hashtag_participants FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1 OFFSET 1) AS previous_hashtag_participants,
             (SELECT hashtag_views FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1) AS latest_hashtag_views,
             (SELECT hashtag_views FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1 OFFSET 1) AS previous_hashtag_views,
             (SELECT hashtag_posts FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1) AS latest_hashtag_posts,
             (SELECT author_count FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1) AS latest_author_count,
             (SELECT captured_at FROM snapshots s WHERE s.target_id=t.id ORDER BY s.captured_at DESC,s.id DESC LIMIT 1) AS latest_snapshot_at,
             (SELECT q.status FROM author_resolution_queue q
               WHERE q.resolved_target_id=t.id AND q.suspended_target_enabled IS NOT NULL
               ORDER BY q.updated_at DESC,q.id DESC LIMIT 1) AS strict_identity_status,
             (SELECT q.last_error FROM author_resolution_queue q
               WHERE q.resolved_target_id=t.id AND q.suspended_target_enabled IS NOT NULL
               ORDER BY q.updated_at DESC,q.id DESC LIMIT 1) AS strict_identity_error
      FROM targets t WHERE t.id=?
    `).get(Number(id));
    if (!row) return null;
    const boards = this.db.prepare(`
      SELECT * FROM target_boards WHERE target_id=? ORDER BY board_name COLLATE NOCASE
    `).all(Number(id)).map(boardFromRow);
    return toTarget(row, boards);
  }

  isTargetAwaitingStrictAuthorVerification(id) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM author_resolution_queue
      WHERE resolved_target_id=? AND suspended_target_enabled IS NOT NULL
        AND status IN ('pending','retry','rejected')
      LIMIT 1
    `).get(Number(id)));
  }

  createTarget(input) {
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)
      `).run(input.type, input.label, input.locator, input.provider, input.enabled === false ? 0 : 1, JSON.stringify(input.metadata ?? {}), timestamp, timestamp);
      const targetId = Number(result.lastInsertRowid);
      attachTargetBoards(
        this.db,
        targetId,
        input.boards ?? input.board ?? input.metadata?.boards ?? input.metadata?.board,
        { ...(input.metadata?.importSource ?? {}), boardMetadata: input.metadata ?? {} },
        timestamp,
      );
      this.db.exec("COMMIT");
      return this.getTarget(targetId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  importAuthorTargets(inputs, auditContext = {}) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
      VALUES('account',?,?,'public-web',1,?,?,?)
    `);
    const createdIds = [];
    const skipped = [];
    let boardMembershipsAdded = 0;
    let boardMembershipsUpdated = 0;
    const boardFieldConflicts = [];
    const timestamp = nowIso();
    // Classify the whole submitted batch before its first relationship write.
    // A single locator may occur on many source rows; otherwise the first IP
    // row would become a false authority for later conflicting rows.
    const batchThemesByLocator = new Map();
    for (const input of inputs) {
      if (!automaticBoardSource(input.metadata?.importSource ?? {})) continue;
      const locator = String(input.locator ?? "");
      if (!batchThemesByLocator.has(locator)) batchThemesByLocator.set(locator, new Map());
      const themes = batchThemesByLocator.get(locator);
      for (const [key, theme] of explicitThemesByKey(normalizedBoardEntries(
        input.boards ?? input.board, input.metadata ?? {},
      ))) themes.set(key, theme);
    }
    const nested = this.db.isTransaction === true;
    this.db.exec(nested ? "SAVEPOINT author_targets_import" : "BEGIN IMMEDIATE");
    try {
      for (const input of inputs) {
        const result = insert.run(input.label, input.locator, JSON.stringify(input.metadata ?? {}), timestamp, timestamp);
        const targetId = result.changes
          ? Number(result.lastInsertRowid)
          : Number(this.db.prepare(`
              SELECT id FROM targets WHERE type='account' AND locator=? AND provider='public-web'
            `).get(input.locator)?.id ?? 0);
        if (!targetId) throw new Error("作者监控目标写入未完成");
        const source = input.metadata?.importSource ?? {};
        const membership = attachTargetBoards(this.db, targetId, input.boards ?? input.board, {
          ...source,
          boardMetadata: input.metadata ?? {},
        }, timestamp, batchThemesByLocator.get(String(input.locator ?? "")));
        boardMembershipsAdded += membership.added;
        boardMembershipsUpdated += membership.updated;
        boardFieldConflicts.push(...membership.conflicts);
        if (result.changes) createdIds.push(targetId);
        else skipped.push({
          locator: input.locator,
          reason: membership.added
            ? "该监控目标已存在，已补充板块归属"
            : membership.conflicts.length
              ? "该监控目标已存在；板块资料冲突已留痕，保留原有非空值"
              : membership.updated
                ? "该监控目标已存在，已补充板块资料"
                : "该监控目标已存在",
        });
      }
      const details = {
        fileName: auditContext.fileName ?? null,
        sheetName: auditContext.sheetName ?? null,
        reviewedRows: Number(auditContext.reviewedRows ?? inputs.length),
        createdCount: createdIds.length,
        skippedCount: skipped.length + Number(auditContext.skippedCount ?? 0),
        boardMembershipsAdded,
        boardMembershipsUpdated,
        boardFieldConflictCount: boardFieldConflicts.length,
      };
      this.db.prepare(`
        INSERT INTO audits(target_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message)
        VALUES(NULL,?,'public-web','validated',0,?,?,?)
      `).run(
        timestamp,
        JSON.stringify([...skipped, ...boardFieldConflicts.map((conflict) => ({
          targetId: conflict.targetId,
          reason: `板块“${conflict.boardName}”的${conflict.field}资料冲突：保留“${conflict.storedValue}”，未覆盖为“${conflict.incomingValue}”`,
        }))].slice(0, 50)),
        checksum({ details, targets: inputs.map((input) => ({ label: input.label, locator: input.locator, boards: serializedBoardEntries(input.boards ?? input.board, input.metadata ?? {}) })) }),
        `作者表格已审查：${details.reviewedRows} 行，新增 ${details.createdCount} 个监控，新增 ${details.boardMembershipsAdded} 条板块归属，更新 ${details.boardMembershipsUpdated} 条板块资料，记录 ${details.boardFieldConflictCount} 条资料冲突，跳过 ${details.skippedCount} 行`,
      );
      this.db.exec(nested ? "RELEASE SAVEPOINT author_targets_import" : "COMMIT");
    } catch (error) {
      if (nested) this.db.exec("ROLLBACK TO SAVEPOINT author_targets_import; RELEASE SAVEPOINT author_targets_import");
      else this.db.exec("ROLLBACK");
      throw error;
    }
    return { created: createdIds.map((id) => this.getTarget(id)), skipped, boardMembershipsAdded, boardMembershipsUpdated, boardFieldConflicts };
  }

  enqueueAuthorResolutions(items, context = {}) {
    const outcome = { evidenceReusedCount: 0, evidenceReusedKeys: [], pendingEvidenceRequestCount: 0,
      pendingEvidenceRequestKeys: [], resolvedEvidenceRequestKeys: [], alreadyResolvedEvidenceRequestCount: 0,
      verifiedExistingEvidenceRequestKeys: [], verifiedExistingEvidenceRequestCount: 0, leaseDeferredEvidenceRequestCount: 0 };
    if (!Array.isArray(items) || !items.length) return { ...this.getAuthorResolutionQueueSummary(), ...outcome };
    const timestamp = nowIso();
    const sourceFingerprint = authorEvidenceSourceFingerprint(context.sourceMetadata);
    const insert = this.db.prepare(`
      INSERT INTO author_resolution_queue(
        identity_key,name,douyin_id,account_locator,video_ids_json,share_urls_json,organization,tier,category,boards_json,source_rows_json,file_name,sheet_name,
        source_metadata_json,status,attempts,next_attempt_at,last_error,resolved_target_id,created_at,updated_at,verification_policy_version,suspended_target_enabled
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,NULL,NULL,?,?,2,NULL)
      ON CONFLICT(identity_key) DO UPDATE SET
        name=CASE WHEN author_resolution_queue.status='resolved' AND author_resolution_queue.resolved_target_id IS NOT NULL
          THEN author_resolution_queue.name ELSE excluded.name END,
        douyin_id=excluded.douyin_id,
        account_locator=excluded.account_locator,
        video_ids_json=CASE WHEN author_resolution_queue.status='resolved'
          AND author_resolution_queue.resolved_target_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id)
          THEN author_resolution_queue.video_ids_json ELSE excluded.video_ids_json END,
        share_urls_json=CASE WHEN author_resolution_queue.status='resolved'
          AND author_resolution_queue.resolved_target_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id)
          THEN author_resolution_queue.share_urls_json ELSE excluded.share_urls_json END,
        organization=CASE WHEN author_resolution_queue.status='resolved' AND author_resolution_queue.resolved_target_id IS NOT NULL
          THEN author_resolution_queue.organization ELSE excluded.organization END,
        tier=CASE WHEN author_resolution_queue.status='resolved' AND author_resolution_queue.resolved_target_id IS NOT NULL
          THEN author_resolution_queue.tier ELSE excluded.tier END,
        category=CASE WHEN author_resolution_queue.status='resolved' AND author_resolution_queue.resolved_target_id IS NOT NULL
          THEN author_resolution_queue.category ELSE excluded.category END,
        boards_json=excluded.boards_json,
        source_rows_json=CASE WHEN author_resolution_queue.status='resolved' AND author_resolution_queue.resolved_target_id IS NOT NULL
          THEN author_resolution_queue.source_rows_json ELSE excluded.source_rows_json END,
        file_name=CASE WHEN author_resolution_queue.status='resolved' AND author_resolution_queue.resolved_target_id IS NOT NULL
          THEN author_resolution_queue.file_name ELSE excluded.file_name END,
        sheet_name=CASE WHEN author_resolution_queue.status='resolved' AND author_resolution_queue.resolved_target_id IS NOT NULL
          THEN author_resolution_queue.sheet_name ELSE excluded.sheet_name END,
        source_metadata_json=CASE WHEN author_resolution_queue.status='resolved'
          AND author_resolution_queue.resolved_target_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id)
          THEN author_resolution_queue.source_metadata_json ELSE excluded.source_metadata_json END,
        status=CASE
          WHEN author_resolution_queue.status='resolved'
            AND author_resolution_queue.resolved_target_id IS NOT NULL
            AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id) THEN 'resolved'
          WHEN author_resolution_queue.status='rejected'
            AND author_resolution_queue.name=excluded.name
            AND author_resolution_queue.douyin_id=excluded.douyin_id
            AND author_resolution_queue.account_locator=excluded.account_locator
            AND author_resolution_queue.video_ids_json=excluded.video_ids_json
            AND author_resolution_queue.share_urls_json=excluded.share_urls_json THEN 'rejected'
          ELSE 'pending'
        END,
        attempts=CASE
          WHEN author_resolution_queue.status='resolved'
            AND author_resolution_queue.resolved_target_id IS NOT NULL
            AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id) THEN author_resolution_queue.attempts
          WHEN author_resolution_queue.status='rejected'
            AND author_resolution_queue.name=excluded.name
            AND author_resolution_queue.douyin_id=excluded.douyin_id
            AND author_resolution_queue.account_locator=excluded.account_locator
            AND author_resolution_queue.video_ids_json=excluded.video_ids_json
            AND author_resolution_queue.share_urls_json=excluded.share_urls_json THEN author_resolution_queue.attempts
          ELSE 0
        END,
        next_attempt_at=CASE
          WHEN author_resolution_queue.status='resolved'
            AND author_resolution_queue.resolved_target_id IS NOT NULL
            AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id) THEN author_resolution_queue.next_attempt_at
          WHEN author_resolution_queue.status='rejected'
            AND author_resolution_queue.name=excluded.name
            AND author_resolution_queue.douyin_id=excluded.douyin_id
            AND author_resolution_queue.account_locator=excluded.account_locator
            AND author_resolution_queue.video_ids_json=excluded.video_ids_json
            AND author_resolution_queue.share_urls_json=excluded.share_urls_json THEN author_resolution_queue.next_attempt_at
          ELSE excluded.next_attempt_at
        END,
        last_error=CASE
          WHEN author_resolution_queue.status='resolved'
            AND author_resolution_queue.resolved_target_id IS NOT NULL
            AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id) THEN author_resolution_queue.last_error
          WHEN author_resolution_queue.status='rejected'
            AND author_resolution_queue.name=excluded.name
            AND author_resolution_queue.douyin_id=excluded.douyin_id
            AND author_resolution_queue.account_locator=excluded.account_locator
            AND author_resolution_queue.video_ids_json=excluded.video_ids_json
            AND author_resolution_queue.share_urls_json=excluded.share_urls_json THEN author_resolution_queue.last_error
          ELSE NULL
        END,
        resolved_target_id=CASE
          WHEN author_resolution_queue.status='resolved'
            AND author_resolution_queue.resolved_target_id IS NOT NULL
            AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id)
            THEN author_resolution_queue.resolved_target_id
          WHEN author_resolution_queue.suspended_target_enabled IS NOT NULL
            AND author_resolution_queue.resolved_target_id IS NOT NULL
            AND EXISTS(SELECT 1 FROM targets suspended_target WHERE suspended_target.id=author_resolution_queue.resolved_target_id)
            THEN author_resolution_queue.resolved_target_id
          ELSE NULL
        END,
        lease_owner=NULL,
        lease_until=NULL,
        evidence_version=CASE WHEN author_resolution_queue.status='resolved'
          AND author_resolution_queue.resolved_target_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id)
          THEN author_resolution_queue.evidence_version ELSE author_resolution_queue.evidence_version+1 END,
        verification_policy_version=CASE WHEN author_resolution_queue.status='resolved'
          AND author_resolution_queue.resolved_target_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id)
          THEN author_resolution_queue.verification_policy_version ELSE 2 END,
        suspended_target_enabled=author_resolution_queue.suspended_target_enabled,
        updated_at=CASE WHEN author_resolution_queue.status='resolved'
          AND author_resolution_queue.resolved_target_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM targets resolved_target WHERE resolved_target.id=author_resolution_queue.resolved_target_id)
          THEN author_resolution_queue.updated_at ELSE excluded.updated_at END
    `);
    const existingQueue = this.db.prepare(`
      SELECT queue.*,
             target.id AS existing_target_id
      FROM author_resolution_queue queue
      LEFT JOIN targets target ON target.id=queue.resolved_target_id
      WHERE queue.identity_key=?
    `);
    const saveSource = this.db.prepare(`INSERT OR IGNORE INTO author_resolution_import_sources
      (queue_id,queue_identity_key,receipt_sha256,observed_at,payload_json) VALUES(?,?,?,?,?)`);
    const retainedSource = this.db.prepare("SELECT 1 FROM author_resolution_import_sources WHERE queue_identity_key=? AND queue_id=? LIMIT 1");
    const retainSource = (id, identityKey, source) => {
      const payload = JSON.stringify(source);
      saveSource.run(id, identityKey, checksum(source), timestamp, payload);
    };
    const boardMembershipAlreadyRetained = (incoming, targetId) => {
      const requested = normalizedBoardEntries(safeJson(incoming.boards_json, []), incoming);
      const stored = new Map(this.db.prepare("SELECT * FROM target_boards WHERE target_id=?").all(targetId)
        .map((row) => [row.board_key, row]));
      return requested.every((board) => {
        const membership = stored.get(board.key);
        if (!membership || board.conflicts?.length) return false;
        return BOARD_METADATA_FIELDS.every(([field, maxLength]) => {
          const value = boardFieldValue(board, field, maxLength);
          return !value || boardValueKey(value) === boardValueKey(boardFieldValue(membership, field, maxLength));
        });
      });
    };
    const nested = this.db.isTransaction === true;
    this.db.exec(nested ? "SAVEPOINT author_resolutions_enqueue" : "BEGIN IMMEDIATE");
    try {
      // Snapshot roots before inserting anything: no same-import proof chains.
      const rootsByAccount = new Map();
      const targets = new Map();
      if (sourceFingerprint) {
        const locators = [...new Set(items.map((item) => queuedAuthorAccountLocator({ identity_key: item?.key, accountLocator: item?.accountLocator })).filter(Boolean))];
        for (const target of this.db.prepare(`SELECT * FROM targets WHERE type='account' AND provider='public-web'
          AND locator IN (SELECT value FROM json_each(?))`).all(JSON.stringify(locators))) targets.set(target.id, target);
        for (const prior of this.db.prepare(`SELECT * FROM author_resolution_queue WHERE status='resolved' AND verification_policy_version>=2
          AND resolved_target_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...targets.keys()]))) {
          const key = String(prior.douyin_id ?? "").normalize("NFKC").replace(/^@/, "").trim().toLowerCase();
          if (!rootsByAccount.has(key)) rootsByAccount.set(key, []);
          rootsByAccount.get(key).push(prior);
        }
      }
      const incomingKeys = new Set();
      const leasedKeys = new Set();
      const requestedBoardsByKey = new Map();
      for (const item of items) {
        const identityKey = String(item?.key ?? "");
        if (identityKey.length > 300) throw new Error("待核验作者证据键超过 300 字符，已拒绝写入以防不同作者证据碰撞");
        incomingKeys.add(identityKey);
        const existing = existingQueue.get(identityKey);
        const submittedSource = { fileName: String(context.fileName ?? "").slice(0, 240), sheetName: String(context.sheetName ?? "").slice(0, 120),
          sourceRows: item?.sourceRows ?? [], sourceMetadata: context.sourceMetadata ?? {}, boards: item?.boards ?? [item?.board].filter(Boolean) };
        const sourceRecords = (Array.isArray(item?.sourceRecords) ? item.sourceRecords : [])
          .filter(record => Number.isSafeInteger(record?.sourceRow) && record.sourceRow > 0
            && submittedSource.sourceRows.includes(record.sourceRow)
            && typeof record?.sourceRecordId === "string" && /^rec[A-Za-z0-9_-]{6,120}$/.test(record.sourceRecordId))
          .map(record => ({ sourceRow: record.sourceRow, sourceRecordId: record.sourceRecordId }));
        if (sourceRecords.length) submittedSource.sourceRecords = sourceRecords;
        if (existing) {
          // Queue rows can include relationship supplements from more than
          // one import. Archive a legacy row only if it has no original
          // receipt; never relabel a later merged state as the old source.
          if (!retainedSource.get(identityKey, existing.id)) {
            retainSource(existing.id, identityKey, { fileName: existing.file_name, sheetName: existing.sheet_name,
              sourceRows: safeJson(existing.source_rows_json, []), sourceMetadata: safeJson(existing.source_metadata_json, {}),
              boards: safeJson(existing.boards_json, []) });
          }
          retainSource(existing.id, identityKey, submittedSource);
        }
        const videoIdsJson = JSON.stringify([...new Set((item?.videoIds ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, 5_000));
        const shareUrlsJson = JSON.stringify([...new Set((item?.shareUrls ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, 5_000));
        const accountLocator = compactQueueText(queuedAuthorAccountLocator({ identity_key: identityKey, accountLocator: item?.accountLocator }), 500);
        let preservesClaim = false;
        if (existing?.lease_owner || existing?.lease_until) {
          leasedKeys.add(identityKey);
          // Identical reimports cannot steal a worker's lease. Changed evidence
          // must retain the existing version invalidation semantics, but may
          // not use automatic receipt reuse in this invocation.
          preservesClaim = existing.name === String(item?.name ?? "").slice(0, 120)
            && existing.douyin_id === String(item?.douyinId ?? "").slice(0, 120)
            && existing.account_locator === accountLocator && existing.video_ids_json === videoIdsJson
            && existing.share_urls_json === shareUrlsJson;
        }
        if (existing?.status === "resolved" && existing.existing_target_id
          && !sameResolvedAuthorEvidence(existing, {
            douyin_id: String(item?.douyinId ?? "").slice(0, 120),
            account_locator: accountLocator,
            video_ids_json: videoIdsJson,
            share_urls_json: shareUrlsJson,
          })) {
          throw new Error("同一作者证据 key 的身份或作品内容冲突；已保留旧核验凭证，请使用新的证据请求");
        }
        const existingBoards = normalizedBoardEntries(safeJson(existing?.boards_json, []), {
          organization: existing?.organization,
          tier: existing?.tier,
          category: existing?.category,
          sourceRow: safeJson(existing?.source_rows_json, [])[0],
          source: {
            type: safeJson(existing?.source_metadata_json, {})?.sourceType ?? "author-spreadsheet",
            fileName: existing?.file_name,
            sheetName: existing?.sheet_name,
            sourceRow: safeJson(existing?.source_rows_json, [])[0],
          },
        });
        const incomingBoards = normalizedBoardEntries(
          Array.isArray(item?.boards) ? item.boards : [item?.board],
          {
            organization: item?.organization,
            tier: item?.tier,
            category: item?.category,
            owner: item?.owner,
            filledDate: item?.filledDate,
            note: item?.note ?? item?.notes,
            sourceRow: item?.sourceRows?.[0],
            source: {
              type: context.sourceMetadata?.sourceType ?? "author-spreadsheet",
              fileName: context.fileName,
              sheetName: context.sheetName,
              sourceRow: item?.sourceRows?.[0],
            },
          },
        );
        const boards = serializedBoardEntries([...existingBoards, ...incomingBoards]);
        requestedBoardsByKey.set(identityKey, boards);
        if (preservesClaim) {
          // Identity verification may already be in flight. Keep its owner,
          // version, original source and timing untouched, but retain new
          // relationship information for the eventual atomic commit.
          const boardsJson = JSON.stringify(boards);
          if (["pending", "retry"].includes(existing.status) && boardsJson !== existing.boards_json) {
            this.db.prepare("UPDATE author_resolution_queue SET boards_json=? WHERE id=?").run(boardsJson, existing.id);
          }
          continue;
        }
        const sourceRows = [...new Set([
          ...safeJson(existing?.source_rows_json, []),
          ...(item?.sourceRows ?? []),
        ].map((value) => Math.max(1, Math.trunc(Number(value) || 1))))].slice(0, 5_000);
        insert.run(
          identityKey,
          String(item?.name ?? "").slice(0, 120),
          String(item?.douyinId ?? "").slice(0, 120),
          accountLocator,
          videoIdsJson,
          shareUrlsJson,
          compactQueueText(item?.organization, 200),
          compactQueueText(item?.tier, 120),
          compactQueueText(item?.category, 120),
          JSON.stringify(boards),
          JSON.stringify(sourceRows),
          String(context.fileName ?? "").slice(0, 240),
          String(context.sheetName ?? "").slice(0, 120),
          JSON.stringify(context.sourceMetadata && typeof context.sourceMetadata === "object" ? context.sourceMetadata : {}),
          timestamp,
          timestamp,
          timestamp,
        );
        if (!existing) retainSource(existingQueue.get(identityKey).id, identityKey, submittedSource);
        const unchangedResolvedMembership = existing?.status === "resolved" && existing.existing_target_id
          && boardMembershipAlreadyRetained({ ...existing, boards_json: JSON.stringify(boards) }, Number(existing.existing_target_id));
        if (existing?.existing_target_id && boards.length && !unchangedResolvedMembership) {
          attachTargetBoards(this.db, Number(existing.existing_target_id), boards, {
            type: context.sourceMetadata?.sourceType ?? "author-spreadsheet",
            fileName: context.fileName,
            sheetName: context.sheetName,
            sourceRow: item?.sourceRows?.[0],
          }, timestamp);
        }
      }
      const readIncoming = this.db.prepare("SELECT * FROM author_resolution_queue WHERE identity_key=?");
      for (const identityKey of incomingKeys) {
        const incoming = readIncoming.get(identityKey);
        if (!incoming) continue;
        if (sourceFingerprint && !leasedKeys.has(identityKey)
          && authorEvidenceSourceFingerprint(safeJson(incoming.source_metadata_json, null)) === sourceFingerprint) {
          const accountKey = String(incoming.douyin_id ?? "").normalize("NFKC").replace(/^@/, "").trim().toLowerCase();
          const proof = uniqueRoutineAuthorEvidence(incoming, rootsByAccount.get(accountKey) ?? [], targets, timestamp);
          if (proof && boardMembershipAlreadyRetained(incoming, proof.targetId)) {
            const target = targets.get(proof.targetId);
            const currentRoot = this.db.prepare("SELECT * FROM author_resolution_queue WHERE id=?").get(proof.sourceQueueId);
            const currentTarget = this.db.prepare("SELECT * FROM targets WHERE id=?").get(proof.targetId);
            const liveProof = uniqueRoutineAuthorEvidence(incoming, currentRoot ? [currentRoot] : [],
              new Map(currentTarget ? [[currentTarget.id, currentTarget]] : []), timestamp);
            if (!liveProof || liveProof.sourceEvidenceSha256 !== proof.sourceEvidenceSha256) {
              throw new Error("复用作者证据的原凭证已变化，事务已取消");
            }
            const evidenceReuse = { ...proof, reusedAt: timestamp, newPublicCollection: false,
              sourceFingerprint, context: "routine-author-import" };
            if (!this.markAuthorResolutionResolved(incoming.id, proof.targetId, { evidenceVersion: incoming.evidence_version })) {
              throw new Error("复用作者证据时队列状态已变化，事务已取消");
            }
            const saved = this.db.prepare(`UPDATE author_resolution_queue SET source_metadata_json=?
              WHERE id=? AND status='resolved' AND resolved_target_id=? AND evidence_version=?
                AND source_metadata_json=? AND lease_owner IS NULL AND lease_until IS NULL
                AND suspended_target_enabled IS NULL
                AND EXISTS(SELECT 1 FROM targets WHERE id=? AND type=? AND provider=? AND locator=? AND enabled=? AND metadata_json=?)
            `).run(JSON.stringify({ ...safeJson(incoming.source_metadata_json, {}), evidenceReuse }),
              incoming.id, proof.targetId, incoming.evidence_version, incoming.source_metadata_json,
              target.id, target.type, target.provider, target.locator, target.enabled, target.metadata_json).changes;
            if (saved !== 1) throw new Error("复用作者证据的来源或身份已变化，事务已取消");
            outcome.evidenceReusedKeys.push(identityKey);
          }
        }
        const current = readIncoming.get(identityKey);
        if (["pending", "retry"].includes(current.status)) outcome.pendingEvidenceRequestKeys.push(identityKey);
        if (current.status === "resolved") outcome.resolvedEvidenceRequestKeys.push(identityKey);
        if (sourceFingerprint && current.status === "resolved" && !outcome.evidenceReusedKeys.includes(identityKey)
          && !leasedKeys.has(identityKey) && requestedBoardsByKey.has(identityKey)
          && boardMembershipAlreadyRetained({ ...current, boards_json: JSON.stringify(requestedBoardsByKey.get(identityKey)) }, current.resolved_target_id)) {
          const rootId = safeJson(current.source_metadata_json, {})?.evidenceReuse?.sourceQueueId;
          const root = Number.isSafeInteger(rootId) && rootId > 0
            ? this.db.prepare("SELECT * FROM author_resolution_queue WHERE id=?").get(rootId) : null;
          const currentTarget = this.db.prepare("SELECT * FROM targets WHERE id=?").get(current.resolved_target_id);
          if (verifiedExistingRoutineAuthorEvidence(current, root ? [root] : [],
            new Map(currentTarget ? [[currentTarget.id, currentTarget]] : []), timestamp)) outcome.verifiedExistingEvidenceRequestKeys.push(identityKey);
        }
      }
      outcome.evidenceReusedCount = outcome.evidenceReusedKeys.length;
      outcome.pendingEvidenceRequestCount = outcome.pendingEvidenceRequestKeys.length;
      outcome.alreadyResolvedEvidenceRequestCount = outcome.resolvedEvidenceRequestKeys.length - outcome.evidenceReusedCount;
      outcome.verifiedExistingEvidenceRequestCount = outcome.verifiedExistingEvidenceRequestKeys.length;
      outcome.leaseDeferredEvidenceRequestCount = leasedKeys.size;
      this.db.exec(nested ? "RELEASE SAVEPOINT author_resolutions_enqueue" : "COMMIT");
    } catch (error) {
      if (nested) this.db.exec("ROLLBACK TO SAVEPOINT author_resolutions_enqueue; RELEASE SAVEPOINT author_resolutions_enqueue");
      else this.db.exec("ROLLBACK");
      throw error;
    }
    return { ...this.getAuthorResolutionQueueSummary(), ...outcome };
  }

  listDueAuthorResolutions(limit = 12, reference = new Date()) {
    const count = Math.max(1, Math.min(36, Math.trunc(Number(limit) || 12)));
    return fairDueAuthorResolutionRows(this.db, { count, nowValue: reference.toISOString() }).map(({ _scheduling_key, ...row }) => ({
      ...row,
      accountLocator: compactQueueText(queuedAuthorAccountLocator(row), 500),
      organization: compactQueueText(row.organization, 200),
      tier: compactQueueText(row.tier, 120),
      category: compactQueueText(row.category, 120),
      boards: serializedBoardEntries(safeJson(row.boards_json, []), {
        organization: row.organization,
        tier: row.tier,
        category: row.category,
      }),
      videoIds: safeJson(row.video_ids_json, []),
      shareUrls: safeJson(row.share_urls_json, []),
      sourceRows: safeJson(row.source_rows_json, []),
      sourceMetadata: safeJson(row.source_metadata_json, {}),
    }));
  }

  claimDueAuthorResolutions(limit = 12, {
    owner, leaseMs = 15 * 60_000, reference = new Date(), fileName,
    includeNotDueRetries = false, excludeIds = [],
  } = {}) {
    const worker = String(owner ?? "").slice(0, 120);
    if (!worker) throw new Error("作者核验队列缺少 worker 标识");
    if (fileName !== undefined && (typeof fileName !== "string" || !fileName.trim() || fileName.length > 240)) {
      throw new Error("作者核验文件名必须是完整且非空的精确文件名（最多 240 字）");
    }
    if (includeNotDueRetries && !fileName) throw new Error("提前重试必须指定精确文件名，禁止全局提前重试");
    if (!Array.isArray(excludeIds) || excludeIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      throw new Error("作者核验排除 ID 必须是正整数数组");
    }
    const count = Math.max(1, Math.min(36, Math.trunc(Number(limit) || 12)));
    const now = reference instanceof Date ? reference : new Date(reference);
    const nowValue = now.toISOString();
    const leaseUntil = new Date(now.getTime() + Math.max(30_000, Number(leaseMs) || 15 * 60_000)).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = fairDueAuthorResolutionRows(this.db, { count, nowValue, fileName: fileName ?? null,
        includeNotDueRetries, excludeIds });
      const claim = this.db.prepare(`
        UPDATE author_resolution_queue SET lease_owner=?, lease_until=?, updated_at=?
        WHERE id=? AND evidence_version=? AND status IN ('pending','retry')
          AND julianday(next_attempt_at) IS NOT NULL
          AND (julianday(next_attempt_at)<=julianday(?) OR (?=1 AND status='retry' AND file_name=?))
          AND (lease_until IS NULL OR julianday(lease_until)<=julianday(?))
      `);
      const recordClaim = this.db.prepare(`INSERT INTO activity_log
        (actor_name,action,resource_type,resource_id,created_at,details_json)
        VALUES('系统','author-resolution.claimed','author-resolution-identity',?,?,?)`);
      const claimed = [];
      for (const row of rows) {
        if (!claim.run(worker, leaseUntil, nowValue, row.id, row.evidence_version, nowValue,
          includeNotDueRetries === true ? 1 : 0, fileName ?? null, nowValue).changes) continue;
        recordClaim.run(row._scheduling_key, nowValue, JSON.stringify({ version: 1, policy: "identity-fair-v1",
          queueId: Number(row.id), evidenceVersion: Number(row.evidence_version) }));
        claimed.push({ ...row, lease_owner: worker, lease_until: leaseUntil, updated_at: nowValue });
      }
      this.db.exec("COMMIT");
      return claimed.map(({ _scheduling_key, ...row }) => ({
        ...row,
        accountLocator: compactQueueText(queuedAuthorAccountLocator(row), 500),
        organization: compactQueueText(row.organization, 200),
        tier: compactQueueText(row.tier, 120),
        category: compactQueueText(row.category, 120),
        boards: serializedBoardEntries(safeJson(row.boards_json, []), {
          organization: row.organization,
          tier: row.tier,
          category: row.category,
        }),
        videoIds: safeJson(row.video_ids_json, []),
        shareUrls: safeJson(row.share_urls_json, []),
        sourceRows: safeJson(row.source_rows_json, []),
        sourceMetadata: safeJson(row.source_metadata_json, {}),
      }));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markAuthorResolutionRetry(id, error, nextAttemptAt, { owner, evidenceVersion } = {}) {
    const worker = owner ? String(owner).slice(0, 120) : null;
    const version = evidenceVersion === undefined || evidenceVersion === null ? null : Number(evidenceVersion);
    if (worker && !Number.isInteger(version)) return false;
    return this.db.prepare(`
      UPDATE author_resolution_queue
      SET status=CASE WHEN attempts>=4 THEN 'rejected' ELSE 'retry' END,
          attempts=attempts+1, next_attempt_at=?,
          last_error=CASE WHEN attempts>=4 THEN '达到公开核验重试上限；' || ? ELSE ? END,
          lease_owner=NULL, lease_until=NULL, updated_at=?
      WHERE id=? AND status IN ('pending','retry') AND (? IS NULL OR lease_owner=?)
        AND (? IS NULL OR evidence_version=?)
    `).run(
      String(nextAttemptAt),
      String(error ?? "公开读取暂未成功").slice(0, 760),
      String(error ?? "公开读取暂未成功").slice(0, 800),
      nowIso(),
      Number(id),
      worker,
      worker,
      version,
      version,
    ).changes > 0;
  }

  markAuthorResolutionResolved(id, targetId, { owner, evidenceVersion } = {}) {
    const worker = owner ? String(owner).slice(0, 120) : null;
    const version = evidenceVersion === undefined || evidenceVersion === null ? null : Number(evidenceVersion);
    if (worker && !Number.isInteger(version)) return false;
    return this.db.prepare(`
      UPDATE author_resolution_queue
      SET status='resolved', resolved_target_id=?, last_error=NULL, lease_owner=NULL, lease_until=NULL, updated_at=?
      WHERE id=? AND status IN ('pending','retry') AND (? IS NULL OR lease_owner=?)
        AND (? IS NULL OR evidence_version=?)
    `).run(Number(targetId), nowIso(), Number(id), worker, worker, version, version).changes > 0;
  }

  markAuthorResolutionRejected(id, error, { owner, evidenceVersion } = {}) {
    const worker = owner ? String(owner).slice(0, 120) : null;
    const version = evidenceVersion === undefined || evidenceVersion === null ? null : Number(evidenceVersion);
    if (worker && !Number.isInteger(version)) return false;
    return this.db.prepare(`
      UPDATE author_resolution_queue
      SET status='rejected', attempts=attempts+1, last_error=?, lease_owner=NULL, lease_until=NULL, updated_at=?
      WHERE id=? AND status IN ('pending','retry') AND (? IS NULL OR lease_owner=?)
        AND (? IS NULL OR evidence_version=?)
    `).run(String(error ?? "公开作者身份与提交信息不一致").slice(0, 800), nowIso(), Number(id), worker, worker, version, version).changes > 0;
  }

  listAuthorResolutionQueue(limit = 200, status = "all", board = "") {
    const normalizedStatus = ["pending", "retry", "resolved", "rejected"].includes(String(status)) ? String(status) : null;
    const count = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 200)));
    const boardScope = authorQueueBoardScopeSql("queue", board);
    const rows = normalizedStatus
      ? this.db.prepare(`
          SELECT id,identity_key,name,douyin_id,account_locator,video_ids_json,share_urls_json,organization,tier,category,boards_json,source_rows_json,file_name,sheet_name,source_metadata_json,status,attempts,next_attempt_at,last_error,resolved_target_id,created_at,updated_at,verification_policy_version,suspended_target_enabled
          FROM author_resolution_queue queue WHERE status=? AND ${boardScope.clause} ORDER BY updated_at DESC,id DESC LIMIT ?
        `).all(normalizedStatus, ...boardScope.params, count)
      : this.db.prepare(`
          SELECT id,identity_key,name,douyin_id,account_locator,video_ids_json,share_urls_json,organization,tier,category,boards_json,source_rows_json,file_name,sheet_name,source_metadata_json,status,attempts,next_attempt_at,last_error,resolved_target_id,created_at,updated_at,verification_policy_version,suspended_target_enabled
          FROM author_resolution_queue queue WHERE ${boardScope.clause} ORDER BY
            CASE status WHEN 'pending' THEN 0 WHEN 'retry' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
            updated_at DESC,id DESC LIMIT ?
        `).all(...boardScope.params, count);
    return rows.map((row) => {
      const parsedBoards = safeJson(row.boards_json, []);
      const storedBoards = Array.isArray(parsedBoards) ? parsedBoards : [];
      const platform = String(row.identity_key ?? "").startsWith("bilibili:") ? "bilibili"
        : String(row.identity_key ?? "").startsWith("xiaohongshu:") ? "xiaohongshu" : "douyin";
      const submittedAccountId = platform === "bilibili"
        ? (/^\d{2,20}$/.test(row.account_locator || "") ? row.account_locator : row.douyin_id || "")
        : row.douyin_id || "";
      const classification = classifyAuthor({
        label: row.name,
        category: row.category,
        tier: row.tier,
        boards: storedBoards,
        metadata: safeJson(row.source_metadata_json, {}),
      });
      return {
      id: Number(row.id),
      name: row.name || "",
      platform,
      submittedAccountId,
      douyinId: row.douyin_id || "",
      accountLocator: compactQueueText(queuedAuthorAccountLocator(row), 500),
      organization: compactQueueText(row.organization, 200),
      tier: compactQueueText(row.tier, 120),
      category: compactQueueText(row.category, 120),
      boards: normalizedBoardEntries(storedBoards).map((board) => board.name),
      boardDetails: serializedBoardEntries(storedBoards, {
        organization: row.organization,
        tier: row.tier,
        category: row.category,
      }),
      classification,
      videoIds: safeJson(row.video_ids_json, []),
      shareUrls: safeJson(row.share_urls_json, []),
      sourceRows: safeJson(row.source_rows_json, []),
      sourceMetadata: safeJson(row.source_metadata_json, {}),
      fileName: row.file_name || "",
      sheetName: row.sheet_name || "",
      status: row.status,
      attempts: Number(row.attempts || 0),
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error || "",
      resolvedTargetId: row.resolved_target_id == null ? null : Number(row.resolved_target_id),
      verificationPolicyVersion: Number(row.verification_policy_version || 1),
      suspendedTargetEnabled: row.suspended_target_enabled == null ? null : Boolean(row.suspended_target_enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    });
  }

  commitAuthorResolutionTarget(id, input, context = {}, { owner, evidenceVersion, requireUnexpiredLease = false, withinTransaction = false } = {}) {
    const nested = withinTransaction === true;
    if (nested && this.db.isTransaction !== true) throw new Error("作者核验嵌套提交必须已有外层事务");
    const worker = String(owner ?? "").slice(0, 120);
    const version = Number(evidenceVersion);
    if (!worker || !Number.isInteger(version)) return null;
    const timestamp = nowIso();
    let targetId = null;
    let created = false;
    let boardMembershipsAdded = 0;
    let boardMembershipsUpdated = 0;
    let boardFieldConflicts = [];
    this.db.exec(nested ? "SAVEPOINT author_target_commit" : "BEGIN IMMEDIATE");
    try {
      const claim = this.db.prepare(`
        SELECT * FROM author_resolution_queue
        WHERE id=? AND status IN ('pending','retry') AND lease_owner=? AND evidence_version=?
          AND (?=0 OR julianday(lease_until)>julianday(?))
      `).get(Number(id), worker, version, requireUnexpiredLease === true ? 1 : 0, timestamp);
      if (!claim) {
        this.db.exec(nested ? "RELEASE author_target_commit" : "COMMIT");
        return null;
      }
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
        VALUES('account',?,?,'public-web',1,?,?,?)
      `).run(
        String(input?.label ?? "").slice(0, 120),
        String(input?.locator ?? "").slice(0, 500),
        JSON.stringify(input?.metadata ?? {}),
        timestamp,
        timestamp,
      );
      created = inserted.changes > 0;
      targetId = created
        ? Number(inserted.lastInsertRowid)
        : Number(this.db.prepare(`
          SELECT id FROM targets WHERE type='account' AND locator=? AND provider='public-web'
        `).get(String(input?.locator ?? "").slice(0, 500))?.id ?? 0);
      if (!targetId) throw new Error("严格核验通过但目标写入未完成");
      if (!created) {
        const existingTarget = this.db.prepare("SELECT label,metadata_json FROM targets WHERE id=?").get(targetId);
        const existingMetadata = safeJson(existingTarget?.metadata_json, {}) ?? {};
        const incomingMetadata = input?.metadata ?? {};
        const normalizedPublicId = value => String(value ?? "").normalize("NFKC").replace(/^@/, "").trim().toLowerCase();
        const storedPublicId = normalizedPublicId(existingMetadata.douyinId);
        const submittedPublicId = normalizedPublicId(claim.douyin_id);
        const verifiedPublicId = normalizedPublicId(incomingMetadata.resolution?.publicDouyinId);
        const storedAnchor = existingMetadata.identityVerification?.accountId;
        const strictIdentity = incomingMetadata.resolution?.verificationPolicy === "all-submitted-evidence-v2"
          && incomingMetadata.resolution.canonicalAccountId === String(input?.locator ?? "");
        // The strict verifier accepts a submitted ID observed as unique_id,
        // short_id or uid. Its preferred publicDouyinId may therefore differ
        // from that valid submitted alias; reject only when neither matches.
        const publicIdConflict = (existingMetadata.platform ?? "douyin") === "douyin" && strictIdentity
          && storedPublicId && verifiedPublicId
          && storedPublicId !== submittedPublicId && storedPublicId !== verifiedPublicId;
        // A prior homepage identity anchor must never be silently replaced by
        // a source-only proof. Otherwise the queue would say resolved while
        // the current-source projection correctly refuses the target.
        const anchorConflict = strictIdentity && storedAnchor != null
          && storedAnchor !== String(input?.locator ?? "");
        if (publicIdConflict || anchorConflict) {
          const reason = anchorConflict
            ? "既有监控主页身份锚点与严格核验账号不一致；已保留原账号及历史，需人工核查身份冲突"
            : "严格核验的公开抖音号与既有监控记录不一致；已保留原账号及历史，需人工核查改号或别名冲突";
          if (!this.markAuthorResolutionRejected(id, reason, { owner: worker, evidenceVersion: version }))
            throw new Error("账号身份冲突未能记录到核验队列");
          this.db.prepare(`
            INSERT INTO audits(target_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message)
            VALUES(?,?,'public-web','warning',0,?,?,?)
          `).run(targetId, timestamp, JSON.stringify([{ queueId: Number(id), reason }]),
            checksum({ queueId: Number(id), targetId, storedPublicId, submittedPublicId, verifiedPublicId, storedAnchor }), reason);
          if (nested) {
            // The outer admission transaction must commit this explicit
            // quarantine, not treat a null result as a stale claim and roll it
            // back. A caller can distinguish it from a successful target.
            this.db.exec("RELEASE author_target_commit");
            return { status: "identity_conflict", queueId: Number(id) };
          }
          this.db.exec("COMMIT");
          return null;
        }
        // A newly verified source may supplement an existing monitor, but it
        // must not rename it or overwrite fields maintained by the user. The
        // latest strict identity proof is system-owned and remains available
        // independently in the immutable success receipt below.
        const metadata = { ...incomingMetadata, ...existingMetadata };
        if (incomingMetadata.resolution && typeof incomingMetadata.resolution === "object"
          && !Array.isArray(incomingMetadata.resolution)) metadata.resolution = incomingMetadata.resolution;
        this.db.prepare("UPDATE targets SET label=?,metadata_json=?,updated_at=? WHERE id=?").run(
          String(existingTarget?.label ?? input?.label ?? "").slice(0, 120),
          JSON.stringify(metadata),
          timestamp,
          targetId,
        );
      }
      const committedBoards = serializedBoardEntries([
        ...safeJson(claim.boards_json, []),
        ...serializedBoardEntries(input?.boards ?? input?.board, input?.metadata ?? {}),
      ]);
      const membership = attachTargetBoards(
        this.db,
        targetId,
        committedBoards,
        { ...(input?.metadata?.importSource ?? {}), boardMetadata: input?.metadata ?? {} },
        timestamp,
      );
      boardMembershipsAdded = membership.added;
      boardMembershipsUpdated = membership.updated;
      boardFieldConflicts = membership.conflicts;
      const committed = this.db.prepare(`
        UPDATE author_resolution_queue
        SET status='resolved', resolved_target_id=?, last_error=NULL, lease_owner=NULL, lease_until=NULL,
            verification_policy_version=2,suspended_target_enabled=NULL,updated_at=?
        WHERE id=? AND status IN ('pending','retry') AND lease_owner=? AND evidence_version=?
      `).run(targetId, timestamp, Number(id), worker, version).changes;
      if (!committed) throw new Error("作者核验租约已失效");
      const successProof = {
        format: "mcn-author-resolution-success-v1",
        queueId: Number(id), evidenceVersion: version, identityKey: claim.identity_key,
        verificationPolicyVersion: 2, targetId,
        platform: input?.metadata?.platform ?? "douyin", canonicalAccountId: String(input?.locator ?? ""),
        verifiedAt: String(input?.metadata?.resolution?.resolvedAt ?? ""), committedAt: timestamp,
        evidence: { name: claim.name, douyinId: claim.douyin_id, accountLocator: claim.account_locator,
          videoIds: safeJson(claim.video_ids_json, []), shareUrls: safeJson(claim.share_urls_json, []) },
        resolution: input?.metadata?.resolution ?? null,
      };
      // A duplicate queue/version is an integrity error, not permission to
      // rewrite the original proof. This insert shares the target/queue transaction.
      this.db.prepare(`INSERT INTO author_resolution_success_receipts
        (queue_id,evidence_version,identity_key,target_id,platform,canonical_account_id,verified_at,payload_json,receipt_sha256)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(Number(id), version, claim.identity_key, targetId, successProof.platform,
        successProof.canonicalAccountId, successProof.verifiedAt, JSON.stringify(successProof), checksum(successProof));
      const suspendedTargetId = claim.suspended_target_enabled == null ? null : Number(claim.resolved_target_id);
      if (suspendedTargetId === targetId) {
        if (Number(claim.suspended_target_enabled) === 1) {
          // Preserve the target-level restore intent until the final strict
          // evidence row finishes. This prevents an earlier successful row
          // from re-enabling a target while another row is retrying/rejected.
          this.db.prepare(`
            UPDATE author_resolution_queue SET suspended_target_enabled=1
            WHERE resolved_target_id=? AND suspended_target_enabled IS NOT NULL
              AND status IN ('pending','retry','rejected')
          `).run(suspendedTargetId);
        }
        const blocker = this.db.prepare(`
          SELECT 1 FROM author_resolution_queue
          WHERE resolved_target_id=? AND suspended_target_enabled IS NOT NULL
            AND status IN ('pending','retry','rejected')
          LIMIT 1
        `).get(suspendedTargetId);
        if (!blocker && Number(claim.suspended_target_enabled) === 1) {
          this.db.prepare("UPDATE targets SET enabled=1,updated_at=? WHERE id=?").run(timestamp, suspendedTargetId);
          this.db.prepare(`
            INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
            VALUES('系统','target.state','target',?,?,?)
          `).run(String(suspendedTargetId), timestamp, JSON.stringify({ enabled: true, source: "strict-identity-review" }));
        }
      }
      const details = {
        fileName: context.fileName ?? null,
        sheetName: context.sheetName ?? null,
        reviewedRows: 1,
        createdCount: created ? 1 : 0,
        skippedCount: created ? 0 : 1,
        boardMembershipsAdded,
        boardMembershipsUpdated,
        boardFieldConflictCount: boardFieldConflicts.length,
      };
      this.db.prepare(`
        INSERT INTO audits(target_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message)
        VALUES(NULL,?,'public-web','validated',0,?,?,?)
      `).run(
        timestamp,
        JSON.stringify([
          ...(created ? [] : [{ locator: input?.locator, reason: "该监控目标已存在" }]),
          ...boardFieldConflicts.map((conflict) => ({
            targetId: conflict.targetId,
            reason: `板块“${conflict.boardName}”的${conflict.field}资料冲突：保留“${conflict.storedValue}”，未覆盖为“${conflict.incomingValue}”`,
          })),
        ].slice(0, 50)),
        checksum({
          queueId: Number(id),
          evidenceVersion: version,
          details,
          target: {
            label: input?.label,
            locator: input?.locator,
            boards: committedBoards,
          },
        }),
        `后台作者核验已完成：新增 ${details.createdCount} 个监控，新增 ${details.boardMembershipsAdded} 条板块归属，更新 ${details.boardMembershipsUpdated} 条板块资料，记录 ${details.boardFieldConflictCount} 条资料冲突，复用 ${details.skippedCount} 个已有监控`,
      );
      if (nested) {
        // Resolve the returned view before releasing the savepoint so even a
        // readback failure cannot leave a partially successful child operation.
        const result = { target: this.getTarget(targetId), created, boardMembershipsAdded, boardMembershipsUpdated, boardFieldConflicts };
        this.db.exec("RELEASE author_target_commit");
        return result;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (nested) {
        this.db.exec("ROLLBACK TO author_target_commit");
        this.db.exec("RELEASE author_target_commit");
      } else this.db.exec("ROLLBACK");
      throw error;
    }
    return { target: this.getTarget(targetId), created, boardMembershipsAdded, boardMembershipsUpdated, boardFieldConflicts };
  }

  getAuthorResolutionQueueSummary(board = "") {
    const boardScope = authorQueueBoardScopeSql("queue", board);
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('pending','retry') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
        COUNT(*) AS total
      FROM author_resolution_queue queue WHERE ${boardScope.clause}
    `).get(...boardScope.params);
    return { pending: Number(row?.pending ?? 0), resolved: Number(row?.resolved ?? 0), rejected: Number(row?.rejected ?? 0), total: Number(row?.total ?? 0) };
  }

  createAuthorResolutionJob({ id, userId, actorName, clientIp, fileName, sheetName, totalAuthors, request }) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO author_resolution_jobs(
        id,user_id,actor_name,client_ip,file_name,sheet_name,status,phase,total_authors,request_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'queued','queued',?,?,?,?)
    `).run(
      String(id),
      userId == null ? null : Number(userId),
      String(actorName ?? "未知成员").slice(0, 80),
      clientIp ? String(clientIp).slice(0, 120) : null,
      String(fileName ?? "未命名表格").slice(0, 240),
      String(sheetName ?? "").slice(0, 120),
      Math.max(0, Number(totalAuthors) || 0),
      JSON.stringify(request ?? {}),
      timestamp,
      timestamp,
    );
    return this.getAuthorResolutionJob(id);
  }

  createIdempotentAuthorResolutionJob({ idempotencyKey, fingerprint, ...jobInput }) {
    const userId = Number(jobInput.userId);
    const key = String(idempotencyKey ?? "");
    const digest = String(fingerprint ?? "").toLowerCase();
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("幂等导入缺少有效用户身份");
    if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error("导入幂等键格式无效");
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("导入幂等指纹格式无效");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(`
        SELECT fingerprint,job_id FROM author_resolution_idempotency
        WHERE user_id=? AND idempotency_key=?
      `).get(userId, key);
      if (existing) {
        this.db.exec("COMMIT");
        if (existing.fingerprint !== digest) return { job: null, replayed: false, conflict: true };
        return { job: this.getAuthorResolutionJob(existing.job_id), replayed: true, conflict: false };
      }

      const job = this.createAuthorResolutionJob(jobInput);
      this.db.prepare(`
        INSERT INTO author_resolution_idempotency(user_id,idempotency_key,fingerprint,job_id,created_at)
        VALUES(?,?,?,?,?)
      `).run(userId, key, digest, job.id, nowIso());
      this.db.exec("COMMIT");
      return { job: this.getAuthorResolutionJob(job.id), replayed: false, conflict: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  getAuthorResolutionJob(id) {
    return toAuthorResolutionJob(this.db.prepare("SELECT * FROM author_resolution_jobs WHERE id=?").get(String(id)));
  }

  listAuthorResolutionJobs(limit = 8, { userId = null } = {}) {
    const count = Math.max(1, Math.min(50, Number(limit) || 8));
    if (userId !== null && userId !== undefined) {
      return this.db.prepare(`
        SELECT * FROM author_resolution_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT ?
      `).all(Number(userId), count).map(toAuthorResolutionJob);
    }
    return this.db.prepare(`
      SELECT * FROM author_resolution_jobs ORDER BY created_at DESC LIMIT ?
    `).all(count).map(toAuthorResolutionJob);
  }

  hasQueuedAuthorResolutionJobs() {
    return Boolean(this.db.prepare("SELECT 1 FROM author_resolution_jobs WHERE status='queued' LIMIT 1").get());
  }

  claimNextAuthorResolutionJob({ owner, leaseMs = 30 * 60_000, reference = new Date() } = {}) {
    const worker = String(owner ?? "").slice(0, 120);
    if (!worker) throw new Error("作者核验任务缺少 worker 标识");
    const now = reference instanceof Date ? reference : new Date(reference);
    const nowValue = now.toISOString();
    const leaseUntil = new Date(now.getTime() + Math.max(30_000, Number(leaseMs) || 30 * 60_000)).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE author_resolution_jobs
        SET status='queued', phase='queued', error=NULL, lease_owner=NULL, lease_until=NULL, updated_at=?
        WHERE status='running' AND (lease_until IS NULL OR lease_until<=?)
      `).run(nowValue, nowValue);
      const row = this.db.prepare("SELECT id FROM author_resolution_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
      if (!row) { this.db.exec("COMMIT"); return null; }
      const claimed = this.db.prepare(`
        UPDATE author_resolution_jobs
        SET status='running', phase='resolving', started_at=COALESCE(started_at,?), updated_at=?,
            lease_owner=?, lease_until=?, version=version+1
        WHERE id=? AND status='queued'
      `).run(nowValue, nowValue, worker, leaseUntil, row.id).changes;
      this.db.exec("COMMIT");
      return claimed ? this.getAuthorResolutionJob(row.id) : null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateAuthorResolutionJob(id, { phase, totalAuthors, owner, version, leaseMs = 30 * 60_000 } = {}) {
    const worker = String(owner ?? "").slice(0, 120);
    const expectedVersion = Number(version);
    if (!worker || !Number.isInteger(expectedVersion)) return null;
    const current = this.getAuthorResolutionJob(id);
    if (!current || current.status !== "running") return null;
    const timestamp = nowIso();
    const leaseUntil = new Date(Date.now() + Math.max(30_000, Number(leaseMs) || 30 * 60_000)).toISOString();
    const changed = this.db.prepare(`
      UPDATE author_resolution_jobs SET phase=?, total_authors=?, updated_at=?, lease_until=?
      WHERE id=? AND status='running' AND lease_owner=? AND version=?
    `).run(phase ?? current.phase, totalAuthors ?? current.totalAuthors, timestamp, leaseUntil, String(id), worker, expectedVersion).changes;
    return changed ? this.getAuthorResolutionJob(id) : null;
  }

  completeAuthorResolutionJob(id, result, { owner, version } = {}) {
    const worker = String(owner ?? "").slice(0, 120);
    const expectedVersion = Number(version);
    if (!worker || !Number.isInteger(expectedVersion)) return null;
    const timestamp = nowIso();
    const changed = this.db.prepare(`
      UPDATE author_resolution_jobs
      SET status='completed', phase='completed', result_json=?, error=NULL, finished_at=?, updated_at=?, lease_owner=NULL, lease_until=NULL
      WHERE id=? AND status='running' AND lease_owner=? AND version=?
    `).run(JSON.stringify(result ?? {}), timestamp, timestamp, String(id), worker, expectedVersion).changes;
    return changed ? this.getAuthorResolutionJob(id) : null;
  }

  failAuthorResolutionJob(id, error, { owner, version } = {}) {
    const worker = String(owner ?? "").slice(0, 120);
    const expectedVersion = Number(version);
    if (!worker || !Number.isInteger(expectedVersion)) return null;
    const timestamp = nowIso();
    const changed = this.db.prepare(`
      UPDATE author_resolution_jobs
      SET status='failed', phase='failed', error=?, finished_at=?, updated_at=?, lease_owner=NULL, lease_until=NULL
      WHERE id=? AND status='running' AND lease_owner=? AND version=?
    `).run(String(error?.message ?? error ?? "自动核验失败").slice(0, 1_000), timestamp, timestamp, String(id), worker, expectedVersion).changes;
    return changed ? this.getAuthorResolutionJob(id) : null;
  }

  updateTarget(id, input) {
    const current = this.getTarget(id);
    if (!current) return null;
    const nextLocator = input.locator ?? current.locator;
    const nextProvider = input.provider ?? current.provider;
    const nextMetadata = input.metadata ?? current.metadata ?? {};
    const identityChanged = String(nextLocator).trim() !== String(current.locator).trim()
      || String(nextMetadata.platform ?? "douyin") !== String(current.metadata?.platform ?? "douyin");
    if (identityChanged) {
      const collectionInProgress = this.db.prepare(`
        SELECT id FROM runs
        WHERE status='running'
          AND (target_id=? OR current_target_id=? OR target_id IS NULL)
        ORDER BY id DESC LIMIT 1
      `).get(Number(id), Number(id));
      if (collectionInProgress) {
        const error = new Error("采集批次进行中，暂不能修改账号主页或平台；请等待当前批次结束后再操作。");
        error.status = 409;
        error.code = "target_identity_in_progress";
        throw error;
      }
      const hasHistory = ["snapshots", "posts", "account_events", "audits"].some((table) =>
        Boolean(this.db.prepare(`SELECT 1 FROM ${table} WHERE target_id=? LIMIT 1`).get(Number(id))));
      if (hasHistory) {
        const error = new Error("此账号已有历史数据；不能把同一记录改成另一个账号。请新增账号并保留原记录。");
        error.status = 409;
        error.code = "target_identity_conflict";
        throw error;
      }
    }
    this.db.prepare(`
      UPDATE targets SET label=?, locator=?, provider=?, enabled=?, metadata_json=?, updated_at=? WHERE id=?
    `).run(
      input.label ?? current.label,
      nextLocator,
      nextProvider,
      input.enabled === undefined ? Number(current.enabled) : Number(Boolean(input.enabled)),
      JSON.stringify(nextMetadata),
      nowIso(),
      Number(id),
    );
    return this.getTarget(id);
  }

  deleteTarget(id) {
    return this.db.prepare("DELETE FROM targets WHERE id=?").run(Number(id)).changes > 0;
  }

  beginRun(triggerType, targetId = null, targetCount = 0) {
    const startedAt = nowIso();
    const result = this.db.prepare(`
      INSERT INTO runs(trigger_type,target_id,started_at,status,target_count,heartbeat_at) VALUES(?,?,?,?,?,?)
    `).run(triggerType, targetId, startedAt, "running", targetCount, startedAt);
    return Number(result.lastInsertRowid);
  }

  updateRunProgress(id, { processedCount = 0, successCount = 0, errorCount = 0, skippedCount = 0, warningCount = 0, currentTargetId = null } = {}) {
    this.db.prepare(`
      UPDATE runs SET processed_count=?, success_count=?, error_count=?, skipped_count=?, warning_count=?, heartbeat_at=?, current_target_id=?
      WHERE id=? AND status='running'
    `).run(processedCount, successCount, errorCount, skippedCount, warningCount, nowIso(), currentTargetId, Number(id));
  }

  finishRun(id, { status, successCount = 0, errorCount = 0, skippedCount = 0, warningCount = 0, processedCount = null, details = [] }) {
    const finalProcessedCount = processedCount ?? (successCount + errorCount + skippedCount);
    this.db.prepare(`
      UPDATE runs SET finished_at=?, status=?, processed_count=?, success_count=?, error_count=?, skipped_count=?, warning_count=?, heartbeat_at=?, current_target_id=NULL, details_json=? WHERE id=?
    `).run(nowIso(), status, finalProcessedCount, successCount, errorCount, skippedCount, warningCount, nowIso(), JSON.stringify(details), Number(id));
  }

  recordFailure(target, runId, error) {
    const message = String(error?.message ?? error).slice(0, 2000);
    const currentTarget = target?.id ? this.getTarget(target.id) : null;
    if (currentTarget) this.db.prepare(`UPDATE targets SET last_checked_at=?, last_status='error', last_error=? WHERE id=?`)
      .run(nowIso(), message, currentTarget.id);
    this.db.prepare(`
      INSERT INTO audits(target_id,run_id,created_at,provider,status,message) VALUES(?,?,?,?,?,?)
    `).run(currentTarget?.id ?? null, runId, nowIso(), target?.provider ?? "public-web", "rejected", message);
  }

  storeAccountEvent(target, runId, type, key, evidence, raw) {
    // The internal ledger has no client-write API. Keep evidence separate
    // from mutable target metadata and retain the exact collector envelope.
    const sourceChecksum = checksum(raw);
    this.db.prepare(`
      INSERT OR IGNORE INTO account_events(target_id,run_id,event_type,event_key,observed_at,source_checksum,event_json,raw_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(target.id, runId, type, key, evidence.observedAt, sourceChecksum, JSON.stringify(evidence), JSON.stringify(raw), nowIso());
  }

  recordAccountLifecycle(target, runId, lifecycle, raw) {
    const current = this.getTarget(target.id);
    if (!current?.enabled || current.locator !== target.locator) throw new Error("账号已暂停或身份已变更，未记录生命周期");
    if (lifecycle?.state !== "deleted" || lifecycle.requestedAccountId !== current.locator
      || lifecycle.sourceChecksum !== checksum(raw)) throw new Error("生命周期证据校验失败");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.storeAccountEvent(current, runId, "lifecycle", `${runId}:${lifecycle.sourceChecksum}`, lifecycle, raw);
      this.db.prepare("UPDATE targets SET last_checked_at=?,last_status='warning',last_error=NULL,updated_at=? WHERE id=?")
        .run(lifecycle.observedAt, nowIso(), current.id);
      this.db.prepare(`
        INSERT INTO audits(target_id,run_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message)
        VALUES(?,?,?,?,?,0,'[]',?,?)
      `).run(current.id, runId, lifecycle.observedAt, current.provider, "warning", lifecycle.sourceChecksum, "官方主页显示账号已注销；未采集新指标，保留历史，每天复查主页状态");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveCollection(target, runId, collection) {
    const capturedAt = collection.capturedAt ?? nowIso();
    const warnings = collection.warnings ?? [];
    const qualityStatus = collection.qualityStatus ?? (warnings.length ? "warning" : "validated");
    const sourceChecksum = collection.sourceChecksum ?? checksum(collection.raw ?? collection);
    const worksObservation = browserWorksObservation(collection.raw, { reference: Date.now() });
    const httpWorksObservation = bilibiliWorkObservation(target, collection);
    if (collection.raw?.works?.pagination?.version === 1 && !worksObservation) throw new Error("新版浏览器作品缺少独立观察时间；不能降为历史时间合同");
    if (worksObservation && (sourceChecksum !== checksum(collection.raw)
      || Date.parse(capturedAt) !== Date.parse(collection.raw.capturedAt)
      || worksObservation.postTimes.size !== (collection.posts ?? []).length
      || (collection.posts ?? []).some(post => !worksObservation.postTimes.has(post.externalId))
      || checksum(collection.posts ?? []) !== checksum(normalizeCollection(target, collection.raw, { capturedAt }).posts))) throw new Error("浏览器作品入库时间与作品证据不一致");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A fresh profile cannot erase older ownership evidence. Conflicts need
      // explicit review, not deletion (which would also cascade post_metrics).
      // Check before target updates and all inserts so the whole batch fails.
      const expectedAuthorId = collection.raw?.profile?.user?.sec_uid ?? collection.raw?.profile?.user_info?.sec_uid ?? null;
      assertPostHistoryIdentity(this.db, target, collection.posts ?? [], expectedAuthorId);
      const historicalIdentity = collection.verifiedIdentity?.sourceEvidenceEvent;
      if (historicalIdentity) {
        const historical = historicalIdentity.type === "historical-source-id-verification";
        const verifiedAt = Date.parse(historicalIdentity.verifiedAt);
        const currentTime = Date.now();
        const proposedTarget = { ...target, ...collection.targetUpdate };
        // getTarget retains both representations; updateTarget writes metadata.
        // Do not let the old metadata_json hide a changed proposed source row.
        if (collection.targetUpdate?.metadata != null) proposedTarget.metadata_json = JSON.stringify(collection.targetUpdate.metadata);
        const rechecked = historical ? verifyHistoricalSourceWorkIdentity(this, proposedTarget, collection.raw, {
          requestStartedAt: historicalIdentity.profileRequestStartedAt, reference: historicalIdentity.verifiedAt,
        }) : verifySourceWorkIdentity(this, proposedTarget, collection.raw, {
          provider: "public-web", operation: "identity-work", requestedVideoId: historicalIdentity.sourceVideoId,
          requestedAccountId: target.locator, sourceBindingChecksum: historicalIdentity.sourceBindingChecksum,
          observedAt: historicalIdentity.verifiedAt,
        });
        const { sourceIdentityEvidence: _identityOnly, ...metricsRaw } = collection.raw ?? {};
        const normalized = normalizeCollection(proposedTarget, metricsRaw, { capturedAt: collection.raw?.capturedAt });
        if (!rechecked || checksum(rechecked) !== checksum(historicalIdentity)
          || sourceChecksum !== checksum(collection.raw)
          || ["followers", "totalLikes", "totalPosts"].some(key => collection.snapshot?.[key] !== normalized.snapshot[key])
          || checksum(collection.posts ?? []) !== checksum(normalized.posts)
          || Date.parse(capturedAt) !== Date.parse(collection.raw?.capturedAt)
          || (historical && (!Number.isFinite(verifiedAt) || currentTime < verifiedAt || currentTime - verifiedAt > 600_000
            || Date.parse(capturedAt) !== Date.parse(historicalIdentity.observedAt)))) {
          throw new Error("历史原作品身份凭证在提交前失效；未写入采样");
        }
      }
      if (collection.targetUpdate) this.updateTarget(target.id, collection.targetUpdate);
      persistPosts(this.db, { target, posts: collection.posts ?? [], expectedAuthorId, capturedAt, postTimes: worksObservation?.postTimes ?? httpWorksObservation?.postTimes });
      const snapshot = collection.snapshot ?? {};
      this.db.prepare(`
        INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,hashtag_participants,hashtag_views,hashtag_posts,author_count,quality_status,account_status,works_coverage,account_error,works_error,warnings_json,source_checksum,raw_json,works_observed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        target.id, capturedAt, snapshot.followers ?? null, snapshot.totalLikes ?? null, snapshot.totalPosts ?? null,
        snapshot.hashtagParticipants ?? null,
        snapshot.hashtagViews ?? null, snapshot.hashtagPosts ?? null, snapshot.authorCount ?? null,
        qualityStatus, collection.accountStatus ?? "unknown", collection.worksCoverage ?? "unknown",
        collection.accountError ?? null, collection.worksError ?? null,
        JSON.stringify(warnings), sourceChecksum, JSON.stringify(collection.raw ?? {}), worksObservation?.observedAt ?? httpWorksObservation?.observedAt ?? null,
      );
      const alias = collection.verifiedIdentity?.aliasEvent;
      if (alias) {
        if (alias.currentRawSha256 !== checksum(collection.raw) || alias.canonicalAccountId !== target.locator
          || Number(alias.targetId) !== Number(target.id)) throw new Error("改号连续性证据校验失败");
        const eventKey = checksum([target.id, alias.submittedAccountId, alias.previousPublicAccountId, alias.currentPublicAccountId, alias.canonicalAccountId, alias.uid]);
        this.storeAccountEvent(target, runId, "alias", eventKey, alias, collection.raw);
      }
      const lastLifecycle = this.db.prepare("SELECT event_json FROM account_events WHERE target_id=? AND event_type='lifecycle' ORDER BY observed_at DESC,id DESC LIMIT 1").get(target.id);
      const identityEvidence = collection.verifiedIdentity?.sourceEvidenceEvent;
      if (identityEvidence) {
        if (identityEvidence.currentRawSha256 !== checksum(collection.raw) || identityEvidence.canonicalAccountId !== target.locator
          || Number(identityEvidence.targetId) !== Number(target.id)) throw new Error("原作品账号身份凭据校验失败");
        const eventKey = identityEvidence.type === "historical-source-id-verification"
          ? checksum([target.id, identityEvidence.type, identityEvidence.historicalEvidence.eventId, identityEvidence.currentRawSha256])
          : checksum([target.id, identityEvidence.submittedAccountId, identityEvidence.sourceVideoId,
            identityEvidence.canonicalAccountId, identityEvidence.uid, identityEvidence.sourceMatchField]);
        this.storeAccountEvent(target, runId, "identity", eventKey, identityEvidence, collection.raw);
      }
      if (safeJson(lastLifecycle?.event_json, {}).state === "deleted" && collection.verifiedIdentity
        && ["available", "partial"].includes(collection.accountStatus)) {
        this.storeAccountEvent(target, runId, "lifecycle", `active:${sourceChecksum}`, {
          state: "active", observedAt: capturedAt, requestedAccountId: target.locator,
          source: "official-public-profile", sourceChecksum, identityVerified: true,
          reason: "官方主页已恢复可核验的指标，恢复正常记录；此前注销证据仍保留",
        }, collection.raw);
      }
      this.db.prepare(`
        UPDATE targets SET last_checked_at=?, last_status=?, last_error=NULL, updated_at=? WHERE id=?
      `).run(capturedAt, qualityStatus, nowIso(), target.id);
      this.db.prepare(`
        INSERT INTO audits(target_id,run_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message)
        VALUES(?,?,?,?,?,?,?,?,?)
      `).run(target.id, runId, nowIso(), target.provider, qualityStatus, collection.posts?.length ?? 0, JSON.stringify(warnings), sourceChecksum, "结构校验已完成");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getReport(period = "day", reference = new Date(), { board = null, scopedTargets = null, timeZone = null } = {}) {
    const bounds = periodBounds(period, reference, timeZone);
    const boardKey = normalizeBoardKey(board);
    const boardScope = targetBoardScopeAsOfSql("t", boardKey, bounds.end);
    const posts = this.db.prepare(`
      WITH ranked AS (
        SELECT p.*, t.label AS target_label, t.type AS target_type,
          COALESCE(json_extract(t.metadata_json,'$.platform'),'douyin') AS platform_key,
          (SELECT pm.likes FROM post_metrics pm WHERE pm.post_id=p.id AND pm.captured_at<=?
            ORDER BY pm.captured_at DESC, pm.id DESC LIMIT 1) AS likes_asof,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(t.metadata_json,'$.platform'),'douyin'),p.external_id
            ORDER BY p.first_seen_at ASC, p.target_id ASC) AS duplicate_rank
        FROM posts p JOIN targets t ON t.id=p.target_id
        WHERE t.type='account'
          AND ${boardScope.clause}
          AND p.published_at >= ? AND p.published_at <= ? AND p.first_seen_at<=?
      )
      SELECT * FROM ranked WHERE duplicate_rank=1
      ORDER BY likes_asof DESC, published_at DESC
    `).all(bounds.end, ...boardScope.params, bounds.start, bounds.end, bounds.end)
      .map((post) => ({ ...post, likes: post.likes_asof }));
    const metrics = this.db.prepare(`
      WITH scoped_targets AS MATERIALIZED (
        SELECT t.id,COALESCE(json_extract(t.metadata_json,'$.platform'),'douyin') AS platform_key
        FROM targets t WHERE t.type='account' AND ${boardScope.clause}
      ), valid AS (
        SELECT p.id AS post_row_id, p.external_id, p.target_id,t.platform_key,
          pm.captured_at AS observation_at, pm.likes,
          ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY pm.captured_at ASC, pm.id ASC) AS first_rank,
          ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY pm.captured_at DESC, pm.id DESC) AS last_rank,
          COUNT(*) OVER (PARTITION BY p.id) AS sample_count
        FROM post_metrics pm
        JOIN posts p ON p.id=pm.post_id JOIN scoped_targets t ON t.id=p.target_id
        WHERE pm.likes IS NOT NULL
          AND pm.captured_at >= ? AND pm.captured_at <= ?
      ), deltas AS (
        SELECT post_row_id, external_id, target_id, platform_key, MAX(observation_at) AS last_seen_at,
          MAX(CASE WHEN last_rank=1 THEN likes END)-MAX(CASE WHEN first_rank=1 THEN likes END) AS likes_delta
        FROM valid WHERE sample_count>=2 GROUP BY post_row_id, external_id, target_id, platform_key
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY platform_key,external_id ORDER BY last_seen_at DESC, target_id ASC) AS duplicate_rank
        FROM deltas
      )
      SELECT external_id AS post_id, likes_delta FROM ranked WHERE duplicate_rank=1
    `).all(...boardScope.params, bounds.start, bounds.end);
    const snapshots = this.db.prepare(`
      SELECT s.target_id FROM snapshots s JOIN targets t ON t.id=s.target_id
      WHERE 1=1
        AND ${boardScope.clause}
        AND s.captured_at >= ? AND s.captured_at <= ? ORDER BY s.captured_at DESC
    `).all(...boardScope.params, bounds.start, bounds.end);
    const collectionActivity = this.db.prepare(`
      WITH scoped_targets AS MATERIALIZED (
        SELECT t.id,COALESCE(json_extract(t.metadata_json,'$.platform'),'douyin') AS platform_key
        FROM targets t WHERE t.type='account' AND ${boardScope.clause}
      )
      SELECT COUNT(*) AS sampled_post_count,
        COUNT(CASE WHEN first_seen_at>=? AND first_seen_at<=? THEN 1 END) AS newly_observed_post_count
      FROM (
        SELECT p.external_id,t.platform_key,
          MIN(p.first_seen_at) AS first_seen_at
        FROM post_metrics pm
        JOIN posts p ON p.id=pm.post_id
        JOIN scoped_targets t ON t.id=p.target_id
        WHERE pm.captured_at>=? AND pm.captured_at<=?
        GROUP BY platform_key,p.external_id
      )
    `).get(...boardScope.params, bounds.start, bounds.end, bounds.start, bounds.end);
    const coverageSnapshots = this.db.prepare(`
      WITH ranked AS (
        SELECT s.id,s.target_id,s.captured_at,s.followers,s.total_likes,s.total_posts,
          s.quality_status,s.account_status,s.works_coverage,s.account_error,s.works_error,s.warnings_json,
          ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY s.captured_at DESC, s.id DESC) AS rank
        FROM snapshots s JOIN targets t ON t.id=s.target_id
        WHERE s.quality_status!='rejected' AND s.captured_at<=?
          AND ${boardScope.clause}
      )
      SELECT * FROM ranked WHERE rank=1 ORDER BY target_id
    `).all(bounds.end, ...boardScope.params);
    const snapshotComparisons = readAccountSnapshotComparisons(this.db, { bounds, boardScope });
    // Reports are account-growth reports. Hashtag targets have their own
    // official participant/view metrics and must never enter account
    // coverage, follower/like baselines, or estimated-play totals. Keep
    // them available through listTargets/topic APIs, but isolate them here
    // before buildReport derives any account aggregates.
    const targetCandidates = scopedTargets ?? this.listTargets();
    const scopeEnd = Date.parse(bounds.end);
    const enabledAtRows = this.db.prepare(`SELECT t.id,${targetEnabledAtSql("t", bounds.end)} AS enabled FROM targets t`).all();
    const enabledAtById = new Map(enabledAtRows.map((row) => [Number(row.id), Number(row.enabled) === 1]));
    const isInBoardScope = (target) => {
      const targetCreatedAt = Date.parse(target.created_at ?? "");
      if (!Number.isFinite(targetCreatedAt) || targetCreatedAt > scopeEnd) return false;
      if (!boardKey) return true;
      const membershipsAtEnd = (target.boards ?? []).filter((membership) => {
        const createdAt = membership.source?.createdAt;
        const created = Date.parse(createdAt ?? "");
        return Number.isFinite(created) && created <= scopeEnd;
      });
      return boardKey === UNASSIGNED_BOARD_KEY
        ? membershipsAtEnd.length === 0
        : membershipsAtEnd.some((membership) => membership.key === boardKey);
    };
    const targets = targetCandidates
      .filter((target) => target.type === "account" && enabledAtById.get(Number(target.id)) === true && isInBoardScope(target));
    const settings = this.getSettings({ includeSecrets: true });
    const report = buildReport({
      period,
      bounds,
      posts,
      metrics,
      snapshots,
      coverageSnapshots,
      snapshotComparisons,
      collectionActivity,
      targets,
      options: {
        fixedLikeThreshold: Number(settings.viralLikeThreshold),
        relativeMultiplier: Number(settings.viralRelativeMultiplier),
      },
    });
    const selectedBoard = boardKey
      ? boardKey === UNASSIGNED_BOARD_KEY
        ? { key: boardKey, name: "未分板块", targetCount: targets.length }
        : { ...(this.listBoards().find((item) => item.key === boardKey) ?? { key: boardKey, name: normalizeBoardName(board) }), targetCount: targets.length }
      : null;
    const scopeBasis = {
      metrics: "period-observations",
      targetCreated: "period-end",
      boardMembership: "retained-relationship-created-by-period-end",
      boardMembershipRemoval: "not-historized",
      boardCatalog: "current-catalog",
      enabledStatus: "period-end-recorded-state",
      description: "只纳入区间末前已创建且按区间末状态启用的账号；指标按所选区间内真实观测。板块归属只按当前仍保留且在区间末前建立的关系筛选；关系移除、板块目录、作者/板块显示名称没有完整历史版本。启停状态优先使用截止时点前的状态记录；旧数据无状态记录时，只有目标最后更新时间不晚于截止点才采用当前值，否则沿用默认启用状态，未留痕的非默认历史状态无法还原。",
    };
    return { ...report, selectedBoard, scopeBasis };
  }

  getOverview({ board = null, timeZone = null } = {}) {
    const boardKey = normalizeBoardKey(board);
    const boards = this.listBoards();
    const targetRoster = this.listTargets();
    const isInCurrentBoardScope = (target) => !boardKey
      || (boardKey === UNASSIGNED_BOARD_KEY
        ? !(target.boards ?? []).length
        : (target.boards ?? []).some((membership) => membership.key === boardKey));
    const targets = targetRoster.filter(isInCurrentBoardScope);
    const targetTypes = new Map(this.db.prepare("SELECT id,type FROM targets").all()
      .map((row) => [Number(row.id), row.type]));
    const selectedBoard = boardKey
      ? boardKey === UNASSIGNED_BOARD_KEY
        ? { key: boardKey, name: "未分板块", targetCount: targets.filter((target) => target.enabled).length }
        : boards.find((item) => item.key === boardKey) ?? { key: boardKey, name: normalizeBoardName(board), targetCount: 0 }
      : null;
    const boardScope = targetBoardScopeSql("t", boardKey);
    const recentPosts = this.db.prepare(`
      WITH ranked AS (
        SELECT p.author_name, p.published_at, p.likes, p.last_seen_at, p.target_id,
          t.label AS target_label,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(t.metadata_json,'$.platform'),'douyin'),p.external_id
            ORDER BY p.last_seen_at DESC, p.target_id ASC) AS duplicate_rank
        FROM posts p JOIN targets t ON t.id=p.target_id
        WHERE t.type='account' AND t.enabled=1
          AND ${boardScope.clause}
      )
      SELECT author_name,target_label,published_at,likes FROM ranked WHERE duplicate_rank=1
      ORDER BY COALESCE(published_at,last_seen_at) DESC LIMIT 30
    `).all(...boardScope.params);
    const recentRunSummaries = this.db.prepare(`
      SELECT id,trigger_type,target_id,started_at,finished_at,status,target_count,
        success_count,error_count,processed_count,skipped_count,warning_count,heartbeat_at,current_target_id
      FROM runs ORDER BY started_at DESC,id DESC LIMIT 12
    `).all();
    // The visible run list is intentionally small, but automation summaries
    // must not use that window to decide which run was the last full batch.
    // A burst of per-account retries can otherwise make a 3-target retry look
    // like the board's "整批" run. Reconcile scheduled runs against the
    // selected board's actual target IDs before exposing automation metadata.
    const scheduledRunRows = this.db.prepare(`
      SELECT id,trigger_type,target_id,started_at,finished_at,status,target_count,
        success_count,error_count,processed_count,skipped_count,warning_count,heartbeat_at,current_target_id,details_json
      FROM runs WHERE trigger_type='scheduled' ORDER BY started_at DESC,id DESC
    `).all();
    const summarizeDetailState = (item) => ({
      ...item,
      reviewState: overviewRunReviewState(item, targetTypes.get(Number(item?.targetId))),
    });
    const scopedTargetIds = new Set(targets.filter((target) => target.enabled).map((target) => Number(target.id)));
    const summarizeScopedRun = (row) => {
      const rawDetails = safeJson(row.details_json, []);
      const normalizedDetails = (Array.isArray(rawDetails) ? rawDetails : []).map(summarizeDetailState);
      const { details_json: _detailsJson, ...summary } = row;
      if (!boardKey) {
        return {
          ...summary,
          scopeComplete: Number(row.target_count) > 0 && Number(row.processed_count) >= Number(row.target_count),
          scopeTargetCount: Number(row.target_count) || 0,
          scopeProcessedCount: Number(row.processed_count) || 0,
          scopeLimitedCount: normalizedDetails.filter((item) => item.reviewState === "limited").length,
          scopeRetryCount: normalizedDetails.filter((item) => ["retry", "pending"].includes(item.reviewState)).length,
        };
      }
      const scopedDetails = normalizedDetails.filter((item) => scopedTargetIds.has(Number(item?.targetId)));
      if (!scopedDetails.length) return null;
      const wasSkipped = (item) => item?.status === "skipped";
      const wasSuccessful = (item) => item?.profileUsable === true || ["complete", "limited"].includes(String(item?.reviewState ?? ""));
      const processedCount = scopedDetails.length;
      const scopeTargetCount = scopedTargetIds.size;
      const scopeComplete = scopeTargetCount > 0 && processedCount >= scopeTargetCount;
      const successCount = scopedDetails.filter(wasSuccessful).length;
      const skippedCount = scopedDetails.filter(wasSkipped).length;
      const errorCount = scopedDetails.filter((item) => !wasSkipped(item) && !wasSuccessful(item)).length;
      const warningCount = scopedDetails.filter((item) => item?.status === "warning" || item?.warnings?.length
        || (targetTypes.get(Number(item?.targetId)) === "account" && item?.worksCoverage !== "complete")).length;
      const targetCount = scopeComplete ? scopeTargetCount : processedCount;
      return {
        ...summary,
        target_count: targetCount,
        processed_count: processedCount,
        success_count: successCount,
        error_count: errorCount,
        skipped_count: skippedCount,
        warning_count: warningCount,
        scopeComplete,
        scopeTargetCount,
        scopeProcessedCount: processedCount,
        scopeLimitedCount: scopedDetails.filter((item) => item?.reviewState === "limited").length,
        scopeRetryCount: scopedDetails.filter((item) => item?.reviewState === "retry").length,
      };
    };
    const automationCandidates = scheduledRunRows.map(summarizeScopedRun).filter(Boolean);
    const latestOverallRun = recentRunSummaries.find((run) => run.finished_at) ?? recentRunSummaries[0] ?? null;
    const scheduledRuns = automationCandidates;
    const latestScheduledRun = scheduledRuns.find((run) => run.finished_at) ?? scheduledRuns[0] ?? null;
    const completedScheduledRuns = scheduledRuns.filter((run) => run.finished_at && ["success", "partial"].includes(run.status));
    const latestScheduledBatchRun = boardKey
      ? completedScheduledRuns.find((run) => run.scopeComplete)
        ?? null
      : (() => {
        const largestScheduledTargetCount = completedScheduledRuns.reduce((largest, run) => Math.max(largest, Number(run.target_count) || 0), 0);
        return completedScheduledRuns.find((run) => Number(run.target_count) === largestScheduledTargetCount)
          ?? completedScheduledRuns[0]
          ?? null;
      })();
    const latestScheduledRetryRun = latestScheduledRun && latestScheduledBatchRun
      && Number(latestScheduledRun.id) !== Number(latestScheduledBatchRun.id)
      && Number(latestScheduledRun.target_count) < Number(latestScheduledBatchRun.target_count)
      ? latestScheduledRun
      : null;
    const detailRunIds = [...new Set([
      latestOverallRun?.id,
      latestScheduledRun?.id,
      latestScheduledBatchRun?.id,
      latestScheduledRetryRun?.id,
    ].filter(Boolean).map(Number))];
    const detailsByRunId = new Map();
    if (detailRunIds.length) {
      const placeholders = detailRunIds.map(() => "?").join(",");
      for (const row of this.db.prepare(`SELECT id,details_json FROM runs WHERE id IN (${placeholders})`).all(...detailRunIds)) {
        detailsByRunId.set(Number(row.id), compactOverviewRunDetails(row.details_json, targetTypes));
      }
    }
    const recentRuns = recentRunSummaries.map((row) => ({
      ...row,
      details: detailsByRunId.get(Number(row.id)) ?? [],
    }));
    const latestCompletedScheduledRun = latestScheduledRun && latestScheduledRun.finished_at && ["success", "partial"].includes(latestScheduledRun.status)
      ? recentRuns.find((run) => Number(run.id) === Number(latestScheduledRun.id)) ?? latestScheduledRun
      : latestScheduledBatchRun
        ? recentRuns.find((run) => Number(run.id) === Number(latestScheduledBatchRun.id)) ?? latestScheduledBatchRun
      : null;
    const audits = this.db.prepare(`
      SELECT a.*, t.label AS target_label FROM audits a LEFT JOIN targets t ON t.id=a.target_id ORDER BY a.created_at DESC, a.id DESC LIMIT 30
    `).all().map((row) => {
      const { warnings_json, ...summary } = row;
      return { ...summary, warnings: safeJson(warnings_json, []) };
    });
    const latestCompletedDay = latestCompletedScheduledRun
      ? this.getReport("day", new Date(latestCompletedScheduledRun.finished_at), { board: boardKey, scopedTargets: targetRoster, timeZone })
      : null;
    return {
      boards,
      selectedBoard,
      targets: targets.map(compactOverviewTarget),
      recentPosts,
      recentRuns,
      automation: {
        latest: latestScheduledRun,
        latestBatch: latestScheduledBatchRun,
        latestRetry: latestScheduledRetryRun,
      },
      audits,
      authorResolutionQueue: this.getAuthorResolutionQueueSummary(boardKey),
      reports: {
        day: compactOverviewReport(this.getReport("day", new Date(), { board: boardKey, scopedTargets: targetRoster, timeZone })),
        latestCompletedDay: compactOverviewReport(latestCompletedDay),
        week: compactOverviewReport(this.getReport("week", new Date(), { board: boardKey, scopedTargets: targetRoster, timeZone })),
        month: compactOverviewReport(this.getReport("month", new Date(), { board: boardKey, scopedTargets: targetRoster, timeZone })),
      },
    };
  }

  listAccountPostsForPool(limit = 10_000) {
    return this.db.prepare(`
      SELECT p.* FROM posts p JOIN targets t ON t.id=p.target_id
      WHERE t.type='account' AND t.enabled=1
      ORDER BY COALESCE(p.published_at,p.last_seen_at) DESC LIMIT ?
    `).all(Math.max(1, Math.min(50_000, Number(limit) || 10_000)));
  }

  lastScheduledRunDate() {
    return this.lastScheduledRun()?.started_at ?? null;
  }

  lastScheduledRun() {
    return this.db.prepare(`
      SELECT id,started_at,finished_at,status,target_count,processed_count
      FROM runs WHERE trigger_type='scheduled' ORDER BY started_at DESC,id DESC LIMIT 1
    `).get() ?? null;
  }

  listScheduledProcessedTargetIds(dateKey) {
    return this.db.prepare(`
      SELECT DISTINCT a.target_id
      FROM audits a JOIN runs r ON r.id=a.run_id
      WHERE r.trigger_type='scheduled' AND date(r.started_at,'localtime')=? AND a.target_id IS NOT NULL
    `).all(String(dateKey)).map((row) => Number(row.target_id));
  }
}

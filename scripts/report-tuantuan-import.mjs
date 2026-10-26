// Read-only acceptance report for this explicitly scoped Feishu import.
// Production SQLite is opened read-only; only this import's report files are written.
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalAccountLocator } from "../lib/author-spreadsheet.mjs";

const DIRECTORY = "data/tuantuan-import-5BDbxd";
const BOARD = "一条小团团切片矩阵";
const SOURCE_TOKEN = "UbeEsThm3h1fsktWiEaclM1enOe";
const json = (value, fallback = {}) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
const text = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const identity = value => text(value).replace(/^@/, "").toLowerCase();
const unique = values => [...new Set(values)];
const md = value => text(value).replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const number = value => value == null ? "—" : Number(value).toLocaleString("zh-CN");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const changedFields = (before, after) => unique([...Object.keys(before), ...Object.keys(after)])
  .filter(field => !same(before[field], after[field]));
const sourceRowKey = row => `${row.sheetId}:${row.sourceRow}`;
const canonicalUrl = value => {
  try { const url = new URL(text(value)); url.hash = ""; return url.toString(); }
  catch { return text(value); }
};
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const readOptionalJson = async path => {
  try { return await readJson(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

export function evidenceMatches(row, queued) {
  const submittedId = identity(row.douyinId);
  // Never let one corrected ID or a same-name row certify a different submitted ID.
  if (submittedId ? submittedId !== identity(queued.douyin_id) : identity(row.name) !== identity(queued.name)) return false;
  const videoId = text(row.videoId);
  const shareUrl = canonicalUrl(row.shareUrl);
  const videos = json(queued.video_ids_json, []);
  const shares = json(queued.share_urls_json, []).map(canonicalUrl);
  if (!videoId && !shareUrl) return false;
  if (videoId && !videos.includes(videoId)) return false;
  if (shareUrl && !shares.includes(shareUrl)) return false;
  const locator = canonicalAccountLocator(row.locator, "douyin");
  const queuedLocator = canonicalAccountLocator(queued.account_locator, "douyin");
  return !locator || !queuedLocator || locator === queuedLocator;
}

export function compareTable(before, current, table, stableFields = null) {
  const rows = before.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  const find = current.prepare(`SELECT * FROM ${table} WHERE id=?`);
  const missingIds = [];
  const changed = [];
  const protectedChanges = [];
  for (const row of rows) {
    const now = find.get(row.id);
    if (!now) { missingIds.push(row.id); continue; }
    const fields = changedFields(row, now);
    if (!fields.length) continue;
    const item = { id: row.id, fields };
    if (table === "targets") {
      item.labelBefore = row.label;
      item.labelAfter = now.label;
      if (fields.includes("metadata_json")) {
        const oldMetadata = json(row.metadata_json);
        const newMetadata = json(now.metadata_json);
        item.metadataFields = changedFields(oldMetadata, newMetadata);
        item.metadataIdentityChanges = ["douyinId", "bilibiliId", "xiaohongshuId", "platform"]
          .filter(key => !same(oldMetadata[key], newMetadata[key]))
          .map(key => ({ field: key, before: oldMetadata[key] ?? null, after: newMetadata[key] ?? null }));
      }
    }
    changed.push(item);
    const protectedFields = stableFields ? fields.filter(field => stableFields.includes(field)) : fields;
    if (protectedFields.length) protectedChanges.push({ id: row.id, fields: protectedFields });
  }
  return {
    beforeCount: rows.length,
    currentCount: current.prepare(`SELECT count(*) count FROM ${table}`).get().count,
    originalRowsRetained: missingIds.length === 0,
    originalRowsUnchanged: !missingIds.length && !changed.length,
    protectedFieldsUnchanged: !missingIds.length && !protectedChanges.length,
    stableFields: stableFields ?? "all",
    missingIds, changedCount: changed.length, changed, protectedChanges,
  };
}

async function verifySavedSource(source, sourceDirectory) {
  const checks = [];
  for (const sheet of source.sheets) {
    const cloud = await readJson(`${sourceDirectory}/cloud-${sheet.id}.json`);
    const data = cloud.data ?? {};
    const expectedRows = source.rows.filter(row => row.sheetId === sheet.id);
    const rawRows = (data.rows ?? []).slice(1)
      .filter(row => [row.values?.A, row.values?.B, row.values?.C].some(text));
    const mismatchRows = rawRows.filter(row => {
      const parsed = expectedRows.find(item => item.sourceRow === row.row_number);
      return !parsed || text(parsed.name) !== text(row.values.A) || text(parsed.douyinId) !== text(row.values.B);
    }).map(row => row.row_number);
    const complete = cloud.ok && !data.has_more && !data.data_not_fully_read
      && data.actual_range === sheet.physicalRange && data.revision === source.revision
      && rawRows.length === expectedRows.length && mismatchRows.length === 0;
    checks.push({ sheetId: sheet.id, title: sheet.title, complete: Boolean(complete),
      physicalRange: sheet.physicalRange, actualRange: data.actual_range, dataRange: sheet.dataRange,
      physicalRows: data.rows?.length ?? 0, recognizedRows: expectedRows.length,
      revision: data.revision, mismatchRows });
  }
  return { complete: checks.every(check => check.complete), sheets: checks };
}

async function main() {
  const manifest = await readJson(`${DIRECTORY}/snapshot-import.json`);
  if (!/^data\/tuantuan-import-[A-Za-z0-9]+\/source-audit\.json$/.test(manifest.sourceAuditPath || "")) throw new Error("Unexpected snapshot audit path");
  const source = await readJson(manifest.sourceAuditPath);
  if (!source.url?.includes(SOURCE_TOKEN) || !Array.isArray(source.rows) || !source.rows.length) throw new Error("Unexpected source audit");
  if (source.revision !== manifest.sourceRevision || source.sourceValuesSha256 !== manifest.sourceValuesSha256) throw new Error("Snapshot manifest and audited source disagree");
  const rowMappings = new Map((manifest.mappings ?? []).map(mapping => [sourceRowKey(mapping), mapping]));
  if (rowMappings.size !== source.rows.length || manifest.mappings.length !== source.rows.length
    || new Set(manifest.mappings.map(mapping => mapping.derivedSourceRow)).size !== source.rows.length
    || source.rows.some(row => {
      const mapped = rowMappings.get(sourceRowKey(row));
      return !mapped || text(mapped.name) !== text(row.name) || text(mapped.submittedId) !== text(row.douyinId)
        || text(mapped.original?.videoId) !== text(row.videoId) || canonicalUrl(mapped.original?.shareUrl) !== canonicalUrl(row.shareUrl);
    })) throw new Error("Derived source row mapping is incomplete or changed original identity/evidence");
  const savedSource = await verifySavedSource(source, dirname(manifest.sourceAuditPath));
  const candidateAudit = await readOptionalJson(`${DIRECTORY}/identity-candidates.json`);
  const existingAssignment = await readOptionalJson(`${DIRECTORY}/existing-id-assignment.json`);
  const profileSupplement = await readOptionalJson(`${DIRECTORY}/verified-profile-supplement.json`);
  const profileSupplementJobReceipt = await readOptionalJson(`${DIRECTORY}/profile-supplement-job.json`);
  if (candidateAudit && (candidateAudit.sourceRevision !== source.revision
    || candidateAudit.sourceValuesSha256 !== source.sourceValuesSha256)) throw new Error("Public identity evidence is from a different source snapshot");
  // No constructor migrations, SQL mutations, or collector calls are used here.
  const db = new DatabaseSync("data/douyin-monitor.sqlite", { readOnly: true });
  const before = new DatabaseSync(`${DIRECTORY}/before.sqlite`, { readOnly: true });
  try {
    db.exec("BEGIN");
    before.exec("BEGIN");
    const allTargets = db.prepare("SELECT * FROM targets ORDER BY id").all().map(row => ({
      ...row, metadata: json(row.metadata_json),
    }));
    const targetsById = new Map(allTargets.map(target => [target.id, target]));
    const boardRows = db.prepare("SELECT * FROM target_boards WHERE board_key=? ORDER BY target_id").all(identity(BOARD));
    const boardTargetIds = new Set(boardRows.map(row => row.target_id));
    const idIndex = new Map();
    const locatorIndex = new Map();
    for (const target of allTargets) {
      if (target.type !== "account" || target.provider !== "public-web") continue;
      const platform = target.metadata.platform || "douyin";
      if (platform !== "douyin") continue;
      for (const key of unique([target.metadata.douyinId, target.metadata.resolution?.publicDouyinId].map(identity).filter(Boolean))) {
        if (!idIndex.has(key)) idIndex.set(key, []);
        idIndex.get(key).push(target.id);
      }
      const key = canonicalAccountLocator(target.locator, platform);
      if (key) {
        if (!locatorIndex.has(key)) locatorIndex.set(key, []);
        locatorIndex.get(key).push(target.id);
      }
    }
    let existingIdAssignment = null;
    if (existingAssignment) {
      const original = source.rows.find(row => row.sheetId === existingAssignment.sourceSheetId
        && row.sourceRow === existingAssignment.sourceRow);
      const target = targetsById.get(existingAssignment.targetId);
      if (!original || !target || identity(original.douyinId) !== identity(existingAssignment.submittedId)
        || !idIndex.get(identity(original.douyinId))?.includes(target.id)
        || !existingAssignment.result?.targetIds?.includes(target.id)) throw new Error("Existing target assignment lacks exact original account ID evidence");
      existingIdAssignment = { sourceKey: sourceRowKey(original), sheetName: original.sheetName,
        sourceRow: original.sourceRow, submittedName: original.name, submittedId: original.douyinId,
        targetId: target.id, currentName: target.label, inBoard: boardTargetIds.has(target.id),
        enabled: Boolean(target.enabled), assignedAt: existingAssignment.readAt,
        method: "normal_board_assignment_api_exact_account_id", originalWorkQueueUnchangedByAssignment: true };
    }
    let verifiedProfileSupplement = null;
    if (profileSupplement) {
      if (profileSupplement.sourceRevision !== source.revision || !profileSupplement.sourceUrl?.includes(SOURCE_TOKEN)
        || !profileSupplementJobReceipt?.id) throw new Error("Profile supplement has no matching source/job receipt");
      const job = db.prepare("SELECT id,file_name,sheet_name,status,result_json,error FROM author_resolution_jobs WHERE id=?")
        .get(profileSupplementJobReceipt.id);
      if (!job || job.file_name !== profileSupplement.fileName) throw new Error("Profile supplement job cannot be verified in application database");
      const accounts = (profileSupplement.accounts ?? []).map(account => {
        if (!account.sourceEvidence?.length) throw new Error("Profile supplement is missing original work evidence");
        const sourceKeys = account.sourceEvidence.map(evidence => {
          const original = source.rows.find(row => row.sheetId === evidence.sheetId && row.sourceRow === evidence.sourceRow);
          const independent = candidateAudit?.evidence?.find(row => row.sheetId === evidence.sheetId && row.sourceRow === evidence.sourceRow);
          const candidate = evidence.candidate;
          if (!original || !candidate || independent?.strictStatus !== "ready"
            || identity(original.douyinId) !== identity(account.id) || identity(original.name) !== identity(account.name)
            || canonicalUrl(original.shareUrl) !== canonicalUrl(evidence.shareUrl)
            || candidate.secUid !== account.secUid || candidate.provenance !== "public-video-detail"
            || identity(candidate.publicDouyinId || candidate.uniqueId || candidate.shortId) !== identity(account.id)
            || identity(candidate.nickname) !== identity(account.name)
            || canonicalUrl(candidate.sourceEvidenceUrl) !== canonicalUrl(original.shareUrl)
            || !independent.rawPublicResult?.candidates?.some(item => item.secUid === candidate.secUid
              && item.videoId === candidate.videoId && canonicalUrl(item.sourceEvidenceUrl) === canonicalUrl(candidate.sourceEvidenceUrl))) {
            throw new Error("Profile supplement is not supported by ready, same-ID/name original public work evidence");
          }
          return sourceRowKey(original);
        });
        const targetIds = locatorIndex.get(canonicalAccountLocator(account.secUid, "douyin")) ?? [];
        return { submittedId: account.id, submittedName: account.name, secUid: account.secUid,
          verifiedOriginalSourceRows: sourceKeys, independentStrictStatus: "ready", targetIds,
          inBoardTargetIds: targetIds.filter(id => boardTargetIds.has(id)) };
      });
      verifiedProfileSupplement = { fileName: profileSupplement.fileName, readAt: profileSupplement.readAt,
        sourceRevision: profileSupplement.sourceRevision, method: "normal_profile_supplement_file_import",
        liveCloudImport: false, addsOriginalSourceRows: 0, changesOriginalWorkQueueStatus: false,
        job: { id: job.id, status: job.status, fileName: job.file_name, sheetName: job.sheet_name,
          error: job.error, createdCount: json(job.result_json).createdCount ?? null }, accounts };
    }
    const queue = db.prepare("SELECT * FROM author_resolution_queue ORDER BY id").all();
    const observedIdentityEvidence = (candidateAudit?.evidence ?? []).map(evidence => {
      const original = source.rows.find(row => row.sheetId === evidence.sheetId && row.sourceRow === evidence.sourceRow);
      if (!original || text(original.douyinId) !== text(evidence.submittedId)
        || canonicalUrl(original.shareUrl) !== canonicalUrl(evidence.shareUrl)
        || text(original.videoId) !== text(evidence.videoId)) throw new Error("Public identity evidence cannot be traced to its original source row");
      const candidates = (evidence.rawPublicResult?.candidates ?? []).filter(candidate => {
        if (candidate.provenance !== "public-video-detail" || !/^MS4wLj[\w-]{12,220}$/.test(candidate.secUid || "")) return false;
        return original.shareUrl ? canonicalUrl(candidate.sourceEvidenceUrl) === canonicalUrl(original.shareUrl)
          : Boolean(original.videoId && candidate.videoId === original.videoId);
      }).map(candidate => {
        const publicId = String(candidate.publicDouyinId || candidate.uniqueId || candidate.shortId || "");
        const byLocator = locatorIndex.get(canonicalAccountLocator(candidate.secUid, "douyin")) ?? [];
        return { videoId: candidate.videoId, secUid: candidate.secUid, publicId, publicName: candidate.nickname,
          provenance: candidate.provenance, sourceEvidenceUrl: candidate.sourceEvidenceUrl,
          submittedIdMatches: identity(original.douyinId) === identity(publicId),
          targetIds: byLocator, inBoardTargetIds: byLocator.filter(id => boardTargetIds.has(id)) };
      });
      return { key: sourceRowKey(original), sheetId: original.sheetId, sheetName: original.sheetName,
        sourceRow: original.sourceRow, name: original.name, submittedId: original.douyinId,
        originalStrictStatus: evidence.strictStatus, originalStrictReason: evidence.strictReason,
        candidates, errors: evidence.rawPublicResult?.errors ?? [],
        explanation: "Independent public work identity is supporting evidence only; it does not certify a mismatched submitted ID or change the original queue status." };
    });
    const sourceRows = source.rows.map(row => {
      const mapping = rowMappings.get(sourceRowKey(row));
      const knownById = idIndex.get(identity(row.douyinId)) ?? [];
      const knownByLocator = locatorIndex.get(canonicalAccountLocator(row.locator, "douyin")) ?? [];
      const matchingQueue = queue.filter(item => evidenceMatches(row, item));
      const resolvedEvidence = matchingQueue.filter(item => item.status === "resolved"
        && item.verification_policy_version >= 2 && targetsById.has(item.resolved_target_id));
      const identityTargetIds = unique([...knownById, ...knownByLocator, ...resolvedEvidence.map(item => item.resolved_target_id)]);
      const inBoardTargetIds = identityTargetIds.filter(id => boardTargetIds.has(id));
      const hasEvidence = Boolean(row.videoId || row.shareUrl);
      const evidenceState = !hasEvidence ? "no_work_evidence"
        : resolvedEvidence.length ? "verified"
          : matchingQueue.some(item => ["pending", "retry"].includes(item.status)) ? "retry"
            : matchingQueue.some(item => item.status === "rejected") ? "rejected" : "not_verified";
      const observedEvidence = observedIdentityEvidence.filter(item => item.key === sourceRowKey(row));
      return {
        key: sourceRowKey(row), sheetId: row.sheetId, sheetName: row.sheetName, sourceRow: row.sourceRow,
        derivedFileName: manifest.fileName, derivedSheetName: manifest.preview.selectedSheet,
        derivedSourceRow: mapping.derivedSourceRow,
        name: row.name, submittedId: row.douyinId, locator: row.locator, videoId: row.videoId,
        shareUrl: row.shareUrl, parserStatus: row.status, parserReason: row.reason,
        identityTargetIds, inBoardTargetIds, ambiguousIdentity: identityTargetIds.length > 1,
        identityMapping: [knownById.length ? "exact_submitted_account_id" : "", knownByLocator.length ? "exact_account_locator" : "",
          resolvedEvidence.length ? "verified_submitted_identity_and_work_evidence" : ""].filter(Boolean),
        evidenceState,
        observedInBoardTargetIds: unique(observedEvidence.flatMap(item => item.candidates.flatMap(candidate => candidate.inBoardTargetIds))),
        observedIdentityEvidence: observedEvidence,
        queue: matchingQueue.map(item => ({ id: item.id, status: item.status, attempts: item.attempts,
          resolvedTargetId: item.resolved_target_id, verificationPolicyVersion: item.verification_policy_version,
          sourceFileName: item.file_name, sourceSheetName: item.sheet_name,
          sourceRows: json(item.source_rows_json, []), sourceMetadata: json(item.source_metadata_json),
          exactSourceWorkbook: String(json(item.source_metadata_json).sourceUrl || "").includes(SOURCE_TOKEN),
          exactDerivedSnapshotRow: item.file_name === manifest.fileName
            && item.sheet_name === manifest.preview.selectedSheet
            && json(item.source_rows_json, []).includes(mapping.derivedSourceRow),
          lastError: item.last_error || "", nextAttemptAt: item.next_attempt_at })),
      };
    });
    const latest = db.prepare("SELECT * FROM snapshots WHERE target_id=? ORDER BY captured_at DESC,id DESC LIMIT 1");
    const latestProfile = db.prepare(`SELECT * FROM snapshots WHERE target_id=? AND account_status='available'
      AND followers IS NOT NULL AND total_likes IS NOT NULL ORDER BY captured_at DESC,id DESC LIMIT 1`);
    const targets = boardRows.map(membership => {
      const target = targetsById.get(membership.target_id);
      const snapshot = latest.get(target.id);
      const profile = latestProfile.get(target.id);
      const rows = sourceRows.filter(row => row.inBoardTargetIds.includes(target.id));
      return { id: target.id, label: target.label, locator: target.locator, enabled: Boolean(target.enabled),
        publicDouyinId: target.metadata.resolution?.publicDouyinId || target.metadata.douyinId || "",
        metadataSubmittedId: target.metadata.douyinId || "", lastCheckedAt: target.last_checked_at,
        lastStatus: target.last_status, lastError: target.last_error, importSource: target.metadata.importSource ?? null,
        membership, sourceRowKeys: rows.map(row => row.key), submittedNames: unique(rows.map(row => row.name)),
        submittedIds: unique(rows.map(row => row.submittedId).filter(Boolean)),
        verifiedSourceWorkRows: rows.filter(row => row.evidenceState === "verified").map(row => row.key),
        latestSnapshot: snapshot ? { id: snapshot.id, capturedAt: snapshot.captured_at, followers: snapshot.followers,
          totalLikes: snapshot.total_likes, totalPosts: snapshot.total_posts, accountStatus: snapshot.account_status,
          worksCoverage: snapshot.works_coverage, qualityStatus: snapshot.quality_status } : null,
        latestAvailableProfile: profile ? { id: profile.id, capturedAt: profile.captured_at,
          followers: profile.followers, totalLikes: profile.total_likes, totalPosts: profile.total_posts } : null,
      };
    });
    const boardConflicts = boardRows.flatMap(membership => json(membership.conflicts_json, []).map(conflict => ({
      targetId: membership.target_id, field: conflict.field,
      kind: conflict.field === "note" && [conflict.storedValue, conflict.incomingValue].every(value =>
        text(value).includes(SOURCE_TOKEN) && /原表|来源|修订/.test(text(value)))
        ? "source_provenance_note_variation" : "board_metadata_difference",
      storedValue: conflict.storedValue, incomingValue: conflict.incomingValue,
      storedSource: conflict.storedSource, incomingSource: conflict.incomingSource,
    })));
    const preservation = {
      snapshots: compareTable(before, db, "snapshots"),
      postMetrics: compareTable(before, db, "post_metrics"),
      posts: compareTable(before, db, "posts", ["id", "target_id", "external_id", "first_seen_at"]),
      targets: compareTable(before, db, "targets", ["id", "type", "locator", "provider", "enabled", "created_at"]),
    };
    const originalBoards = before.prepare("SELECT * FROM target_boards ORDER BY target_id,board_key").all();
    const findBoard = db.prepare("SELECT * FROM target_boards WHERE target_id=? AND board_key=?");
    const missingBoards = [];
    const changedBoards = [];
    for (const row of originalBoards) {
      const now = findBoard.get(row.target_id, row.board_key);
      if (!now) missingBoards.push({ targetId: row.target_id, board: row.board_name });
      else if (!same(row, now)) changedBoards.push({ targetId: row.target_id, board: row.board_name, fields: changedFields(row, now) });
    }
    preservation.originalBoards = { beforeCount: originalBoards.length,
      originalRowsUnchanged: !missingBoards.length && !changedBoards.length, missing: missingBoards, changed: changedBoards };
    const evidenceCounts = Object.fromEntries(unique(sourceRows.map(row => row.evidenceState))
      .map(state => [state, sourceRows.filter(row => row.evidenceState === state).length]));
    const outsideSource = targets.filter(target => !target.sourceRowKeys.length).map(target => ({ id: target.id, label: target.label }));
    const unmatchedRows = sourceRows.filter(row => !row.inBoardTargetIds.length);
    const unmatchedIdentities = [...new Map(unmatchedRows.map(row => [row.submittedId ? `id:${identity(row.submittedId)}` : `row:${row.key}`,
      { submittedId: row.submittedId, name: row.name, sourceRowKeys: unmatchedRows.filter(other => row.submittedId
        ? identity(other.submittedId) === identity(row.submittedId) : other.key === row.key).map(other => other.key) }])).values()];
    const preserved = preservation.snapshots.originalRowsUnchanged && preservation.postMetrics.originalRowsUnchanged
      && preservation.posts.protectedFieldsUnchanged && preservation.targets.protectedFieldsUnchanged
      && preservation.originalBoards.originalRowsUnchanged;
    const result = {
      readAt: new Date().toISOString(), board: BOARD,
      source: { url: source.url, title: source.title, revision: source.revision, readAt: source.readAt,
        sourceAuditPath: manifest.sourceAuditPath,
        sourceValuesSha256: source.sourceValuesSha256, rowCount: source.rowCount,
        authorNameCount: source.authorNameCount, submittedIdCount: source.submittedIdCount, ...savedSource },
      importSnapshot: { mode: "audited_saved_snapshot_file_import", fileName: manifest.fileName,
        selectedSheet: manifest.preview.selectedSheet, contentSha256: manifest.contentSha256,
        sourceRevision: manifest.sourceRevision, sourceReadAt: manifest.sourceReadAt,
        mappedRows: rowMappings.size, liveCloudImport: false },
      implementationEvidence: { existingIdAssignment, verifiedProfileSupplement },
      acceptance: { originalDataPreserved: preserved, savedSourceComplete: savedSource.complete,
        everyBoardTargetMappedByStrongIdentityOrVerifiedEvidence: !outsideSource.length,
        ambiguousSourceRows: sourceRows.filter(row => row.ambiguousIdentity).map(row => row.key) },
      summary: { targetCount: targets.length, enabledCount: targets.filter(target => target.enabled).length,
        pausedCount: targets.filter(target => !target.enabled).length,
        availableProfileCount: targets.filter(target => target.latestAvailableProfile).length,
        enabledAvailableProfileCount: targets.filter(target => target.enabled && target.latestAvailableProfile).length,
        mappedSourceRows: sourceRows.length - unmatchedRows.length, unmatchedSourceRows: unmatchedRows.length,
        unmatchedSourceRowsWithObservedBoardIdentity: unmatchedRows.filter(row => row.observedInBoardTargetIds.length).length,
        unmatchedSubmittedIdentityEntries: unmatchedIdentities.length, evidenceCounts },
      outsideSource, unmatchedIdentities, observedIdentityEvidence, boardConflicts, preservation, targets, sourceRows,
    };
    await writeFile(`${DIRECTORY}/receipt.json`, `${JSON.stringify(result, null, 2)}\n`);
    const stateLabels = { no_work_evidence: "未提供作品证据", verified: "作品归属已核验", retry: "作品证据待重试", rejected: "作品证据未通过", not_verified: "未找到通过的作品证据" };
    const lines = ["# 一条小团团切片矩阵 · 导入与监控核对", "", `核对时间：${result.readAt}（UTC）。`, "",
      `[打开本板块](http://127.0.0.1:4188/?board=${encodeURIComponent(BOARD)}#targets)`, "",
      `来源：[${md(source.title)}](${source.url})，修订 ${source.revision}；已保存并核对 ${source.sheets.length} 个子表。`, "",
      `原表在读取期间持续编辑，本次导入固定使用 ${manifest.sourceReadAt} 保存的已审计修订 ${manifest.sourceRevision} 快照（${md(manifest.fileName)}），不是实时云表同步；每条派生记录均可追溯原子表与行号。较早读取版本单独保留。`, "",
      `原表共有 ${source.rowCount} 条有效记录、${source.authorNameCount} 个名称写法、${source.submittedIdCount} 个非空账号 ID 值。名称和提交号码含别名、差异及重复，不将它们直接作为作者人数。`, "",
      `本板块当前有 ${result.summary.targetCount} 个独立监控目标：${result.summary.enabledCount} 个启用、${result.summary.pausedCount} 个暂停；${result.summary.availableProfileCount} 个已有粉丝及累计获赞快照，其中启用账号 ${result.summary.enabledAvailableProfileCount} 个。`, "",
      "## 完整来源范围", "", "| 子表 | 实际读取范围 | 有效范围 | 有效记录 | 完整性核对 |", "|---|---|---|---:|---|",
      ...savedSource.sheets.map(sheet => `| ${md(sheet.title)} | ${sheet.actualRange} | ${sheet.dataRange} | ${sheet.recognizedRows} | ${sheet.complete ? "通过" : "未通过，见收据"} |`), "",
      "## 账号与公开采集数据", "", "| 作者 | 核实账号 ID | 状态 | 粉丝 | 累计获赞 | 作品数 | 快照时间（UTC） | 对应源行数 |", "|---|---|---|---:|---:|---:|---|---:|",
      ...targets.map(target => { const snapshot = target.latestAvailableProfile; return `| ${md(target.label)} | ${md(target.publicDouyinId)} | ${target.enabled ? "启用" : "保留暂停"} | ${number(snapshot?.followers)} | ${number(snapshot?.totalLikes)} | ${number(snapshot?.totalPosts)} | ${snapshot?.capturedAt || "尚无有效快照"} | ${target.sourceRowKeys.length} |`; }), "",
      "## 身份与作品证据分开计数", "",
      `- ${result.summary.mappedSourceRows} 条源记录通过强账号 ID、主页或已通过的作品证据对应到本板块目标；${result.summary.unmatchedSourceRows} 条尚未按这些条件对应。`,
      ...Object.entries(evidenceCounts).map(([state, count]) => `- ${stateLabels[state]}：${count} 条源记录。`),
      "- 一个作者可以有多条作品证据；作品未确认数量不是未监控人数。原填号码有差异的源行不因同名或其他行通过而自动视为通过。",
      "- 同一证据在不同子表重复时可复用既有严格核验；收据逐行保留本次子表、行号、原填号码、作品链接及实际匹配的核验记录。",
      `- 板块资料差异中，${boardConflicts.filter(item => item.kind === "source_provenance_note_variation").length} 条只是不同源行的来源备注差异，保留为多处来源记录，不视为账号身份或数据指标错误；其他 ${boardConflicts.filter(item => item.kind !== "source_provenance_note_variation").length} 条资料差异见收据。`,
      "- 表中粉丝和累计获赞来自监控快照，不使用原表登记的播放、点赞、评论、收藏或结算数充当实时指标。每日增量需要两次可比快照；估算每日新增播放量 = 每日新增点赞 × 100，并非平台实测播放量。", "",
      "## 已落地的归属与主页补全", "",
      ...(existingIdAssignment ? [
        `- 原表「${md(existingIdAssignment.sheetName)}」第 ${existingIdAssignment.sourceRow} 行「${md(existingIdAssignment.submittedName)}」，账号 ${md(existingIdAssignment.submittedId)}，精确匹配既有目标 ${existingIdAssignment.targetId}（当前名称「${md(existingIdAssignment.currentName)}」）。已通过正常板块归属接口追加，当前${existingIdAssignment.inBoard ? "在本板块" : "尚未出现在本板块"}；名称差异不按昵称猜测匹配，原作品核验队列未通过此次归属操作改写。`,
      ] : []),
      ...(verifiedProfileSupplement ? [
        `- 「${md(verifiedProfileSupplement.fileName)}」用于补全已经通过独立公开作品严格核验的 ${verifiedProfileSupplement.accounts.length} 个作者主页。每个作品返回的账号 ID、名称与原填值一致，取得 sec_uid 后通过普通文件/主页补全流程写入；这不是原云表直连导入，也不将原作品重试记录改为通过。`,
        `- 补全任务 ${verifiedProfileSupplement.job.id} 当前状态：${verifiedProfileSupplement.job.status}；原表来源仍是 ${source.rowCount} 行，补全账号已经包含在原名单及本板块目标统计中，不额外增加原表作者人数。采集结果以“账号与公开采集数据”表中的实际快照为准。`, "",
        "| 补全作者 | 原填且已核实 ID | 原作品来源 | 板块目标 ID | 独立核验 |", "|---|---|---|---|---|",
        ...verifiedProfileSupplement.accounts.map(account => `| ${md(account.submittedName)} | ${md(account.submittedId)} | ${account.verifiedOriginalSourceRows.map(key => { const row = source.rows.find(item => sourceRowKey(item) === key); return `${md(row.sheetName)} / ${row.sourceRow}`; }).join("、")} | ${account.inBoardTargetIds.join("、") || "尚未加入"} | 同原 ID、同名、公开作品核验通过 |`),
        "", "补全的独立证据与原导入队列分开留痕，下面的未通过记录表仍展示原队列实际状态。",
      ] : []), "",
      "## 原填号码与公开作品发布者差异", "",
      "以下仅列公开作品返回的身份旁证，不修改原表，也不把号码不一致的原记录改成核验通过。目标归属按公开主页的 sec_uid 精确匹配。", "",
      "| 子表 / 行 | 原名称 | 原填号码 | 公开号码 | 公开作者名 | 对应板块目标 ID | 原记录状态 |", "|---|---|---|---|---|---|---|",
      ...observedIdentityEvidence.flatMap(item => item.candidates.filter(candidate => !candidate.submittedIdMatches)
        .map(candidate => `| ${md(item.sheetName)} / ${item.sourceRow} | ${md(item.name)} | ${md(item.submittedId)} | ${md(candidate.publicId)} | ${md(candidate.publicName)} | ${candidate.inBoardTargetIds.join("、") || "尚未加入"} | ${md(item.originalStrictReason)} |`)), "",
      "## 原有数据保全", "",
      `- 历史快照：原 ${preservation.snapshots.beforeCount} 条，${preservation.snapshots.originalRowsUnchanged ? "全部逐字段一致" : "存在差异，必须检查 receipt.json"}。`,
      `- 历史作品指标：原 ${preservation.postMetrics.beforeCount} 条，${preservation.postMetrics.originalRowsUnchanged ? "全部逐字段一致" : "存在差异，必须检查 receipt.json"}。`,
      `- 历史作品：原 ${preservation.posts.beforeCount} 条；${preservation.posts.missingIds.length} 条缺失；${preservation.posts.changedCount} 条更新。作品 ID、所属目标及首次发现时间${preservation.posts.protectedFieldsUnchanged ? "均保留" : "存在差异"}；采集更新的字段逐条记入收据。`,
      `- 原目标：${preservation.targets.beforeCount} 个；稳定身份、启停状态和创建时间${preservation.targets.protectedFieldsUnchanged ? "全部保留" : "存在差异"}；${preservation.targets.changedCount} 个目标的名称、元数据或检查状态有变化，详见下表与收据。`,
      `- 原板块关系：${preservation.originalBoards.beforeCount} 条，${preservation.originalBoards.originalRowsUnchanged ? "原值全部保留" : "存在差异"}。`,
      "- 名单来源文件、原始云端单元格、导入凭证、导入前数据库备份保存在本报告同目录；本验收程序仅以只读方式打开生产数据库。", "",
      "### 原目标变化明细", "", "| 目标 ID | 原名称 | 当前名称 | 变更字段 | 元数据变更键 |", "|---:|---|---|---|---|",
      ...preservation.targets.changed.map(item => `| ${item.id} | ${md(item.labelBefore)} | ${md(item.labelAfter)} | ${md(item.fields.join("、"))} | ${md((item.metadataFields ?? []).join("、"))} |`),
      ...(preservation.targets.changed.length ? [] : ["| — | — | — | 无原目标字段变化 | — |"]), "",
      "## 尚未通过的源记录", "", "以下保留原表身份值，不擅自修正。‘已对应账号’不代表本行作品已经核验通过。", "",
      "| 子表 / 行 | 原名称 | 原填账号 ID | 已对应目标 ID | 证据状态 | 具体原因 |", "|---|---|---|---|---|---|",
      ...sourceRows.filter(row => row.evidenceState !== "verified").map(row => `| ${md(row.sheetName)} / ${row.sourceRow} | ${md(row.name)} | ${md(row.submittedId) || "未填"} | ${row.inBoardTargetIds.join("、") || "未对应"} | ${stateLabels[row.evidenceState]} | ${md(unique(row.queue.map(item => item.lastError).filter(Boolean)).join("；") || (row.evidenceState === "no_work_evidence" ? "原行没有作品链接；有强身份匹配的账号可沿用已有监控" : row.parserReason || "没有严格核验通过的相同身份及作品证据"))} |`), "",
      ...(outsideSource.length ? ["## 需要处理的归属疑点", "", ...outsideSource.map(target => `- 目标 ${target.id}（${md(target.label)}）尚无强身份或已通过源作品证据映射，不能宣称来源覆盖已完成。`), ""] : []),
    ];
    await writeFile(`${DIRECTORY}/一条小团团导入核对.md`, `${lines.join("\n")}\n`);
    console.log(JSON.stringify({ acceptance: result.acceptance, summary: result.summary, outsideSource,
      changedTargets: preservation.targets.changedCount, changedPosts: preservation.posts.changedCount,
      report: `${DIRECTORY}/一条小团团导入核对.md`, receipt: `${DIRECTORY}/receipt.json` }));
    if (!preserved || !savedSource.complete || outsideSource.length || result.acceptance.ambiguousSourceRows.length) process.exitCode = 2;
  } finally {
    db.close();
    before.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

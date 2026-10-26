// Re-runnable, read-only acceptance for the additional Tuantuan hotspot roster.
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compareTable, evidenceMatches } from "./report-tuantuan-import.mjs";
import { canonicalAccountLocator } from "../lib/author-spreadsheet.mjs";

const DIRECTORY = "data/tuantuan-hotspot-onikEQ";
const BOARD = "一条小团团切片矩阵";
const TOKEN = "YR58sxWa0hyIW6tqGPCcoxhGnYd";
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const optionalJson = async path => {
  try { return await readJson(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const normalized = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const identifier = value => normalized(value).replace(/^@/, "").toLowerCase();
const unique = values => [...new Set(values)];
const md = value => normalized(value).replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const number = value => value == null ? "—" : Number(value).toLocaleString("zh-CN");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fieldsChanged = (a, b) => unique([...Object.keys(a), ...Object.keys(b)]).filter(key => !same(a[key], b[key]));
const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function storedPayloadCoversEvidence(target, incoming) {
  const metadata = target.metadata ?? parse(target.metadata_json);
  const resolution = metadata.resolution ?? {};
  const evidence = resolution.verifiedEvidence ?? [];
  if (!Array.isArray(evidence) || resolution.verificationPolicy !== "all-submitted-evidence-v2"
    || resolution.verifiedEvidenceTruncated || resolution.verifiedEvidenceCount !== evidence.length
    || resolution.verifiedEvidenceSha256 !== sha256(evidence)) return false;
  const expected = canonicalAccountLocator(target.locator, "douyin");
  const covered = new Set(evidence.filter(item => canonicalAccountLocator(item.canonicalAccountId, "douyin") === expected
    && item.provenance === "public-video-detail" && (!item.shareUrl || item.shareUrl === item.sourceEvidenceUrl))
    .flatMap(item => [item.videoId ? `v:${item.videoId}` : "", item.shareUrl ? `s:${item.shareUrl}` : ""].filter(Boolean)));
  const required = [...parse(incoming.video_ids_json, []).map(id => `v:${id}`), ...parse(incoming.share_urls_json, []).map(url => `s:${url}`)];
  return Boolean(expected && required.length && required.every(item => covered.has(item)));
}

export function auditPreviewSource(rows, preview) {
  if (!preview?.rows) return { available: false, passed: false, differences: [] };
  const differences = [];
  for (const row of rows) {
    const parsed = preview.rows.find(item => item.sourceRow === row.sourceRow);
    if (!parsed) { differences.push({ sourceRow: row.sourceRow, field: "row", kind: "missing", source: row.name }); continue; }
    for (const field of ["name", "douyinId", "videoLink", "shareUrl"]) {
      if (normalized(row[field]) === normalized(parsed[field])) continue;
      differences.push({ sourceRow: row.sourceRow, field, source: row[field] ?? null,
        preview: parsed[field] ?? null, kind: field === "videoLink" && normalized(row.shareUrl) === normalized(parsed.shareUrl)
          ? "share_text_representation_difference" : "identity_or_visible_evidence_difference" });
    }
  }
  const blockingDifferences = differences.filter(item => item.kind !== "share_text_representation_difference");
  return { available: true, rowCount: preview.rows.length, passed: rows.length === preview.rows.length && !blockingDifferences.length,
    differences, blockingDifferenceCount: blockingDifferences.length,
    additionalHyperlinkEvidenceRows: preview.rows.filter(row => row.videoHyperlink || row.hyperlink).map(row => ({
      sourceRow: row.sourceRow, hyperlink: row.videoHyperlink || row.hyperlink, videoId: row.videoId || "", locator: row.locator || "" })),
    note: "Visible account IDs and original share URLs must be retained. Extra XLSX hyperlink evidence is independent metadata, never an inferred unlabelled-column-D video ID." };
}

export function sourceRowsWithVerifiedEvidence(rows, preview) {
  if (!preview?.rows) return rows.map(row => ({ ...row, evidenceFieldsFrom: "saved-visible-source" }));
  const audit = auditPreviewSource(rows, preview);
  if (!audit.passed) throw new Error("Verified native preview does not retain every original visible identity/share URL");
  return rows.map(row => {
    const enriched = preview.rows.find(item => item.sourceRow === row.sourceRow);
    return { ...row, ...enriched, sheetId: row.sheetId, sheetName: row.sheetName,
      unlabelledColumnD: row.unlabelledColumnD || "", visibleSourceVideoId: row.videoId || "",
      evidenceFieldsFrom: "verified-native-preview-with-independent-hyperlink-evidence" };
  });
}

export function compareMemberships(before, current) {
  const rows = before.prepare("SELECT * FROM target_boards ORDER BY target_id,board_key").all();
  const find = current.prepare("SELECT * FROM target_boards WHERE target_id=? AND board_key=?");
  const missing = [], changed = [];
  for (const row of rows) {
    const now = find.get(row.target_id, row.board_key);
    if (!now) missing.push({ targetId: row.target_id, board: row.board_name });
    else if (!same(row, now)) changed.push({ targetId: row.target_id, board: row.board_name, fields: fieldsChanged(row, now) });
  }
  return { beforeCount: rows.length, unchanged: !missing.length && !changed.length, missing, changed };
}

async function main() {
  const source = await readJson(`${DIRECTORY}/source-audit.json`);
  const matching = await readJson(`${DIRECTORY}/matching-audit.json`);
  const assignment = await readJson(`${DIRECTORY}/existing-assignment.json`);
  const sourceCloud = await readJson(`${DIRECTORY}/cloud-d8a44f.json`);
  const oldPreview = await optionalJson(`${DIRECTORY}/app-preview.json`);
  const fixedPreview = await optionalJson(`${DIRECTORY}/app-preview-verified.json`);
  const previewValidation = await optionalJson(`${DIRECTORY}/preview-validation.json`);
  const directIdentity = await optionalJson(`${DIRECTORY}/identity-candidates.json`);
  const refreshedIdentity = await optionalJson(`${DIRECTORY}/identity-candidates-fresh-session.json`);
  const auxiliaryIdentity = await optionalJson(`${DIRECTORY}/identity-candidates-unlabelled-d-auxiliary.json`);
  const storedReuse = await optionalJson(`${DIRECTORY}/stored-evidence-reuse.json`);
  if (source.revision !== 2346 || source.rowCount !== 405 || !source.url?.includes(TOKEN)
    || matching.source.sourceValuesSha256 !== source.sourceValuesSha256
    || assignment.sourceValuesSha256 !== source.sourceValuesSha256) throw new Error("Unexpected or inconsistent audited source snapshot");
  const rawMismatchRows = source.rows.filter(row => {
    const raw = sourceCloud.data.rows.find(item => item.row_number === row.sourceRow);
    return !raw || normalized(raw.values.A) !== normalized(row.name)
      || normalized(raw.values.B) !== normalized(row.douyinId)
      || normalized(raw.values.C) !== normalized(row.videoLink)
      || normalized(raw.values.D) !== normalized(row.unlabelledColumnD);
  }).map(row => row.sourceRow);
  const sourceComplete = matching.rawAudit.completeAndConsistent && !rawMismatchRows.length
    && sourceCloud.data.revision === source.revision && sourceCloud.data.rows.length === 595
    && sourceCloud.data.rows.every((row, index) => row.row_number === index + 1);
  const verifiedEvidenceRows = sourceRowsWithVerifiedEvidence(source.rows, fixedPreview);
  const db = new DatabaseSync("data/douyin-monitor.sqlite", { readOnly: true });
  const before = new DatabaseSync(`${DIRECTORY}/before.sqlite`, { readOnly: true });
  try {
    db.exec("BEGIN"); before.exec("BEGIN");
    const allTargets = db.prepare("SELECT * FROM targets ORDER BY id").all().map(row => ({ ...row, metadata: parse(row.metadata_json) }));
    const targetMap = new Map(allTargets.map(row => [row.id, row]));
    const oldIds = new Set(before.prepare("SELECT id FROM targets").all().map(row => row.id));
    const oldBoardIds = new Set(before.prepare("SELECT target_id FROM target_boards WHERE board_key=?").all(BOARD).map(row => row.target_id));
    const memberships = db.prepare("SELECT * FROM target_boards WHERE board_key=? ORDER BY target_id").all(BOARD);
    const boardIds = new Set(memberships.map(row => row.target_id));
    const idIndex = new Map(), locatorIndex = new Map();
    for (const target of allTargets) {
      if (target.type !== "account" || target.provider !== "public-web" || (target.metadata.platform && target.metadata.platform !== "douyin")) continue;
      for (const id of unique([target.metadata.douyinId, target.metadata.resolution?.publicDouyinId].map(identifier).filter(Boolean))) {
        if (!idIndex.has(id)) idIndex.set(id, []);
        idIndex.get(id).push(target.id);
      }
      const locator = canonicalAccountLocator(target.locator, "douyin");
      if (locator) { if (!locatorIndex.has(locator)) locatorIndex.set(locator, []); locatorIndex.get(locator).push(target.id); }
    }
    const queue = db.prepare("SELECT * FROM author_resolution_queue ORDER BY id").all();
    let storedEvidenceReuse = null;
    if (storedReuse) {
      const queueById = new Map(queue.map(row => [row.id, row]));
      const oldQueue = before.prepare("SELECT * FROM author_resolution_queue WHERE id=?");
      const oldTarget = before.prepare("SELECT * FROM targets WHERE id=?");
      const reusedRows = (storedReuse.reusable ?? []).map(item => {
        const current = queueById.get(item.queueId);
        const prior = oldQueue.get(item.priorReceipt.id);
        const originalTarget = oldTarget.get(item.proof.targetId);
        const currentTarget = targetMap.get(item.proof.targetId);
        const provenance = parse(current?.source_metadata_json).evidenceReuse;
        const issues = [];
        if (!current || !prior || !originalTarget || !currentTarget) {
          return { queueId: item.queueId, passed: false, issues: ["Referenced current/original row is missing"] };
        }
        if (current.status !== "resolved" || current.resolved_target_id !== item.proof.targetId
          || prior.resolved_target_id !== item.proof.targetId) issues.push("Resolved target differs from the prior receipt");
        if (prior.status !== "resolved" || prior.verification_policy_version < 2
          || !same(prior, item.priorReceipt)) issues.push("Original strict receipt differs from its preserved snapshot");
        if (!provenance || provenance.newPublicCollection !== false || provenance.mode !== "stored-strict-queue-receipt"
          || provenance.receiptSnapshotSha256 !== sha256(item.priorReceipt)
          || provenance.sourceEvidenceSha256 !== item.proof.sourceEvidenceSha256) issues.push("Stored provenance/hash does not match the reuse record");
        const allowedFields = ["status", "resolved_target_id", "last_error", "updated_at", "source_metadata_json"];
        if (fieldsChanged(item.before, current).some(field => !allowedFields.includes(field))) issues.push("Queue evidence or non-reuse fields changed");
        if (identifier(item.before.douyin_id) !== identifier(prior.douyin_id)
          || identifier(item.before.name) !== identifier(prior.name)
          || identifier(currentTarget.metadata.resolution?.publicDouyinId) !== identifier(item.before.douyin_id)) issues.push("Submitted identity/name constraint differs");
        if (originalTarget.locator !== currentTarget.locator || item.before.account_locator !== currentTarget.locator
          || item.proof.canonicalAccountId !== currentTarget.locator || originalTarget.enabled !== currentTarget.enabled) issues.push("Expected stable identity or pause state differs");
        for (const field of ["video_ids_json", "share_urls_json"]) {
          const previousValues = parse(prior[field], []);
          if (!parse(item.before[field], []).every(value => previousValues.includes(value))) issues.push(`Not all ${field} constraints are covered`);
        }
        return { queueId: item.queueId, priorQueueId: prior.id, targetId: item.proof.targetId,
          sourceRows: item.sourceRows, passed: issues.length === 0, issues,
          verificationTier: storedPayloadCoversEvidence(originalTarget, item.before) ? "full_stored_per_evidence_payload" : "strict_persisted_queue_receipt",
          newPublicCollection: false, snapshotHash: provenance?.receiptSnapshotSha256 ?? null };
      });
      storedEvidenceReuse = { appliedAt: storedReuse.checkedAt, action: storedReuse.action,
        declaredAppliedCount: storedReuse.reusable?.length ?? 0,
        actualResolvedAndVerifiedCount: reusedRows.filter(row => row.passed).length,
        fullStoredPayloadCount: reusedRows.filter(row => row.verificationTier === "full_stored_per_evidence_payload").length,
        strictLedgerOnlyCount: reusedRows.filter(row => row.verificationTier === "strict_persisted_queue_receipt").length,
        newNetworkRequests: 0, passed: reusedRows.every(row => row.passed), rows: reusedRows,
        explanation: "Both tiers reuse existing checked receipts, not new public API observations. The ledger-only tier does not claim to preserve or reconstruct an overwritten detailed network payload." };
    }
    const sourceRows = verifiedEvidenceRows.map(row => {
      const proofs = queue.filter(item => evidenceMatches(row, item));
      const resolved = proofs.filter(item => item.status === "resolved" && item.verification_policy_version >= 2 && targetMap.has(item.resolved_target_id));
      const targetIds = unique([...(idIndex.get(identifier(row.douyinId)) ?? []),
        ...(locatorIndex.get(canonicalAccountLocator(row.locator, "douyin")) ?? []), ...resolved.map(item => item.resolved_target_id)]);
      return { sourceRow: row.sourceRow, name: row.name, submittedId: row.douyinId || "", sourceShareUrl: row.shareUrl || "",
        declaredVideoId: row.videoId || "", visibleSourceVideoId: row.visibleSourceVideoId ?? row.videoId ?? "",
        independentVideoHyperlink: row.videoHyperlink || "", evidenceFieldsFrom: row.evidenceFieldsFrom,
        unlabelledColumnD: row.unlabelledColumnD || "",
        unlabelledColumnDIsConfirmedVideoId: false, targetIds, inBoardTargetIds: targetIds.filter(id => boardIds.has(id)),
        ambiguous: targetIds.length > 1,
        evidenceState: !row.shareUrl && !row.videoId ? "no_work_evidence" : resolved.length ? "verified"
          : proofs.some(item => ["pending", "retry"].includes(item.status)) ? "retry"
            : proofs.some(item => item.status === "rejected") ? "rejected" : "not_verified",
        queue: proofs.map(item => ({ id: item.id, status: item.status, resolvedTargetId: item.resolved_target_id,
          fileName: item.file_name, sourceRows: parse(item.source_rows_json, []), sourceMetadata: parse(item.source_metadata_json),
          lastError: item.last_error || "", attempts: item.attempts })),
      };
    });
    const latest = db.prepare("SELECT id,captured_at,followers,total_likes,total_posts,account_status,works_coverage,quality_status FROM snapshots WHERE target_id=? ORDER BY captured_at DESC,id DESC LIMIT 1");
    const targets = memberships.map(membership => {
      const target = targetMap.get(membership.target_id);
      const rows = sourceRows.filter(row => row.inBoardTargetIds.includes(target.id));
      return { id: target.id, label: target.label, locator: target.locator, enabled: Boolean(target.enabled),
        wasInBoard: oldBoardIds.has(target.id), existedBeforeImport: oldIds.has(target.id),
        publicAccountId: target.metadata.resolution?.publicDouyinId || target.metadata.douyinId || "",
        importSource: target.metadata.importSource, identityVerification: target.metadata.identityVerification,
        sourceRows: rows.map(row => row.sourceRow), latestSnapshot: latest.get(target.id) ?? null, membership };
    });
    const sourceFileName = `${source.title}.xlsx`;
    const jobs = db.prepare("SELECT * FROM author_resolution_jobs ORDER BY created_at,id").all()
      .filter(job => job.file_name === sourceFileName || String(parse(job.request_json).sourceUrl || "").includes(TOKEN))
      .map(job => { const request = parse(job.request_json), result = parse(job.result_json); return {
        id: job.id, status: job.status, phase: job.phase, createdAt: job.created_at, finishedAt: job.finished_at,
        fileName: job.file_name, sheetName: job.sheet_name, sourceType: request.sourceType || "author-spreadsheet",
        sourceUrl: request.sourceUrl || "", sourceRevision: request.sourceRevision || null,
        submittedRows: request.rows?.length ?? 0, originalVisibleSourceAudit: auditPreviewSource(source.rows, { rows: request.rows }),
        result: { createdCount: result.createdCount ?? null, reusedExistingCount: result.reusedExistingCount ?? null,
          boardMembershipsAdded: result.boardMembershipsAdded ?? null, queuedAuthors: result.queuedAuthors ?? null }, error: job.error,
      }; });
    const sourceQueue = queue.filter(item => item.file_name === sourceFileName || String(parse(item.source_metadata_json).sourceUrl || "").includes(TOKEN));
    const queueCounts = Object.fromEntries(unique(sourceQueue.map(row => row.status)).map(status => [status, sourceQueue.filter(row => row.status === status).length]));
    const evidenceCounts = Object.fromEntries(unique(sourceRows.map(row => row.evidenceState)).map(state => [state, sourceRows.filter(row => row.evidenceState === state).length]));
    const preservation = {
      targets: compareTable(before, db, "targets", ["id", "type", "locator", "provider", "enabled", "created_at"]),
      snapshots: compareTable(before, db, "snapshots"), postMetrics: compareTable(before, db, "post_metrics"),
      posts: compareTable(before, db, "posts", ["id", "target_id", "external_id", "first_seen_at"]),
      originalMemberships: compareMemberships(before, db),
    };
    const currentIntegrity = { quickCheck: db.prepare("PRAGMA quick_check").all(), foreignKeys: db.prepare("PRAGMA foreign_key_check").all() };
    const outsideSource = targets.filter(target => !target.wasInBoard && !target.sourceRows.length).map(target => ({ id: target.id, label: target.label }));
    const missingPreviousMembers = [...oldBoardIds].filter(id => !boardIds.has(id));
    const publicCandidateObservations = [directIdentity, refreshedIdentity].filter(Boolean).flatMap(audit => (audit.evidence || audit.rows || []).map(row => ({
      sourceRow: row.sourceRow, name: row.name, submittedId: row.submittedId, strictStatus: row.strictStatus,
      strictReason: row.strictReason, candidates: (row.rawPublicResult?.candidates || []).map(candidate => {
        const publicId = candidate.publicDouyinId || candidate.uniqueId || candidate.shortId || "";
        return { publicId, publicName: candidate.nickname, secUid: candidate.secUid, videoId: candidate.videoId,
          sourceEvidenceUrl: candidate.sourceEvidenceUrl, submittedIdMatches: identifier(publicId) === identifier(row.submittedId),
          inBoardTargetIds: (locatorIndex.get(canonicalAccountLocator(candidate.secUid, "douyin")) || []).filter(id => boardIds.has(id)) };
      }), errors: row.rawPublicResult?.errors || [],
    })));
    const preserved = preservation.targets.protectedFieldsUnchanged && preservation.snapshots.originalRowsUnchanged
      && preservation.postMetrics.originalRowsUnchanged && preservation.posts.protectedFieldsUnchanged && preservation.originalMemberships.unchanged;
    const result = {
      readAt: new Date().toISOString(), board: BOARD,
      source: { wikiUrl: source.wikiUrl, url: source.url, title: source.title, revision: source.revision,
        userSourceOrder: 2,
        readAt: source.readAt, physicalRange: "A1:U595", effectiveRange: "A1:D406", rowCount: source.rowCount,
        authorNameVariants: source.authorNameCount, submittedIdValues: source.submittedIdCount,
        sourceValuesSha256: source.sourceValuesSha256, rawMismatchRows, fullyRead: sourceComplete },
      additionalForm: { ...source.additionalForm, userSourceOrder: 1, recordsRead: false, includedInSourceCount: false,
        note: "未取得表单后台提交记录访问权限；仅可见的问题字段不等于已读作者名单，未计入本次405行。" },
      matchingBaseline: matching.summary, existingAssignment: assignment,
      parserAudit: { beforeFix: auditPreviewSource(source.rows, oldPreview), afterFix: auditPreviewSource(source.rows, fixedPreview),
        effectiveEvidenceSource: fixedPreview ? "app-preview-verified.json" : "source-audit.json (pre-import visible-only stage)",
        validationArtifact: previewValidation, dColumnPolicy: "337条无表头值只保留为原始未确认参考，不作为已声明作品ID。单独辅助查询也不证明原短链接已核验。" },
      acceptance: { sourceComplete, originalDataPreserved: preserved, previousBoardMembersRetained: !missingPreviousMembers.length,
        newBoardTargetsWithinSource: !outsideSource.length, ambiguousSourceRows: sourceRows.filter(row => row.ambiguous).map(row => row.sourceRow),
        storedEvidenceReuseVerified: storedEvidenceReuse?.passed ?? null,
        databaseIntegrity: currentIntegrity.quickCheck.every(row => row.quick_check === "ok") && !currentIntegrity.foreignKeys.length },
      summary: { boardTargetCount: targets.length, enabledCount: targets.filter(target => target.enabled).length,
        pausedCount: targets.filter(target => !target.enabled).length, previousBoardCount: oldBoardIds.size,
        addedBoardMembers: targets.filter(target => !target.wasInBoard).length,
        reusedExistingNewMemberships: targets.filter(target => !target.wasInBoard && target.existedBeforeImport).length,
        newlyCreatedTargets: targets.filter(target => !target.existedBeforeImport).length,
        newTargetsWithAvailableProfile: targets.filter(target => !target.existedBeforeImport && target.latestSnapshot?.account_status === "available"
          && target.latestSnapshot?.followers != null && target.latestSnapshot?.total_likes != null).length,
        sourceRowsMappedToBoard: sourceRows.filter(row => row.inBoardTargetIds.length).length,
        unmappedSourceRows: sourceRows.filter(row => !row.inBoardTargetIds.length).length,
        sourceQueueRecords: sourceQueue.length, queueCounts, evidenceCounts },
      outsideSource, missingPreviousMembers, preservation, currentIntegrity, jobs, targets, sourceRows, storedEvidenceReuse,
      publicCandidateObservations, unlabelledDAuxiliaryProbe: auxiliaryIdentity ? {
        checkedAt: auxiliaryIdentity.checkedAt, classification: auxiliaryIdentity.classification,
        note: auxiliaryIdentity.note, rows: auxiliaryIdentity.rows,
        originalShareLinkVerifiedByThisProbe: false, includedAsVerifiedOriginalEvidence: false } : null,
    };
    const states = { no_work_evidence: "未提供作品", verified: "原身份/作品证据已核验", retry: "待重试", rejected: "证据未通过", not_verified: "尚无通过证据" };
    const report = ["# 一条小团团补充名单 · 导入核对", "", `核对时间：${result.readAt}（UTC）。`, "",
      `[打开一条小团团切片矩阵](http://127.0.0.1:4188/?board=${encodeURIComponent(BOARD)}#targets)`, "",
      `已完整读取[${md(source.title)}](${source.wikiUrl || source.url})，修订 ${source.revision}，全网格 A1:U595，有效范围 A1:D406，共 ${source.rowCount} 行记录。`,
      `原表有 ${source.authorNameCount} 个名称写法、${source.submittedIdCount} 个非空 ID 值，不能直接当作作者人数。导入前强身份匹配 ${matching.summary.existingTargetCount} 个既有目标，另有 ${matching.summary.unmatchedGroupCount} 组 / ${matching.summary.unmatchedSourceRows} 行未匹配。`, "",
      `本板块现有 ${result.summary.boardTargetCount} 个目标：${result.summary.enabledCount} 个启用、${result.summary.pausedCount} 个保留暂停。原有 ${result.summary.previousBoardCount} 个板块成员全部保留情况：${missingPreviousMembers.length ? "未通过" : "通过"}；此次新增归属 ${result.summary.addedBoardMembers} 个，其中复用既有目标 ${result.summary.reusedExistingNewMemberships} 个、新建目标 ${result.summary.newlyCreatedTargets} 个。`,
      `本次新建目标中，${result.summary.newTargetsWithAvailableProfile} 个已有可用粉丝/累计获赞快照。账号采集与单条作品证据核验分开计数；公开作品窗口 limited 不等于账号采集失败。`, "",
      "## 第一个来源：表单提交名单尚未读取", "",
      `「${md(source.additionalForm?.name || "授权作者登记表")}」的后台提交记录没有访问权限。本次未读取其提交名单，未计入上述 ${source.rowCount} 行，也未把能看到表单问题误称为读取作者信息。`, "",
      "## 原字段与导入证据", "",
      "- 原始单元格、名称、ID、分享文案及无表头 D 列完整保留；D 列 337 个数值不擅自确认为作品 ID。辅助查询单独留痕，不代表对应原短链接通过核验。",
      `- 修复前原生预览与可见源字段存在 ${result.parserAudit.beforeFix.blockingDifferenceCount ?? 0} 项关键差异；修复后检查${result.parserAudit.afterFix.available ? (result.parserAudit.afterFix.passed ? "通过" : "尚有差异") : "尚无已核验预览文件"}。前后差异及验证凭证详见 audit.json。`,
      "- 富文本空值、隐藏超链接与可见文本分别核对；保留可见账号 ID、原短链接，额外超链接证据独立存储。/user/self 不作为作者主页。",
      "- 原行证据统计使用修复后原生预览的完整证据字段。第16、237行除可见短链接还含独立超链接中的作品ID，必须全部覆盖才算原行证据通过；旧短链接单独通过不代表本行完整证据通过。",
      `- 原生云表导入任务：${jobs.length ? jobs.map(job => `${job.id}（${job.status}，${job.submittedRows} 行）`).join("；") : "尚无已提交任务，仅存在已核验既有账号的归属追加"}。`,
      "- 原表的同名、多号、错号或不可用作品不会因其他行通过而自动改成通过；昵称不单独作为去重依据。", "",
      "## 作品证据状态（不是未监控作者数）", "",
      ...Object.entries(evidenceCounts).map(([state, count]) => `- ${states[state]}：${count} 条原表记录。`),
      `- 本来源独立后台证据记录 ${sourceQueue.length} 条：${Object.entries(queueCounts).map(([state, count]) => `${state} ${count}`).join("、") || "尚未进入后台证据队列"}。重复源行与独立证据记录数可以不同。`,
      ...(storedEvidenceReuse ? [
        `- 本次复用 ${storedEvidenceReuse.actualResolvedAndVerifiedCount} 条已存严格凭证，逐项确认同原 ID/名称、同 sec_uid、同目标公开账号及全部原作品/分享链接约束。其中 ${storedEvidenceReuse.fullStoredPayloadCount} 条仍有完整逐项 payload、数量与 SHA256 可核对；${storedEvidenceReuse.strictLedgerOnlyCount} 条复用政策 v2 的已通过队列流水，旧目标详细 payload 已被后续作品覆盖，不重建不存在的网络返回。`,
        "- 上述凭证复用没有重新请求平台，不算新增公开采样；原凭证快照及散列、新旧队列对应关系和验证结果保存在审计文件中。原目标启停、指标和作品数据不因复用而改变。",
      ] : []),
      "- 每日新增粉丝/点赞需要两次可比快照；估算新增播放 = 新增点赞 × 100，不是平台实测播放量。历史登记数不冒充实时快照。", "",
      "## 新增归属与新建账号", "", "| 目标 ID | 作者 | 类型 | 状态 | 粉丝 | 累计获赞 | 快照时间（UTC） | 原行 |", "|---:|---|---|---|---:|---:|---|---|",
      ...targets.filter(target => !target.wasInBoard).map(target => `| ${target.id} | ${md(target.label)} | ${target.existedBeforeImport ? "复用既有账号" : "新建账号"} | ${target.enabled ? "启用" : "原暂停保留"} | ${number(target.latestSnapshot?.followers)} | ${number(target.latestSnapshot?.total_likes)} | ${target.latestSnapshot?.captured_at || "尚无快照"} | ${target.sourceRows.join("、")} |`), "",
      "## 原有数据保全", "",
      `- 原目标 ${preservation.targets.beforeCount} 个：稳定身份、启停、创建时间${preservation.targets.protectedFieldsUnchanged ? "保留" : "存在差异"}；${preservation.targets.changedCount} 个目标其他字段有变化，逐字段列入 audit.json。`,
      `- 原快照 ${preservation.snapshots.beforeCount} 条：${preservation.snapshots.originalRowsUnchanged ? "逐字段全部一致" : "存在差异"}。`,
      `- 原作品指标 ${preservation.postMetrics.beforeCount} 条：${preservation.postMetrics.originalRowsUnchanged ? "逐字段全部一致" : "存在差异"}。`,
      `- 原作品 ${preservation.posts.beforeCount} 条：${preservation.posts.missingIds.length} 条缺失，${preservation.posts.changedCount} 条更新；身份和首次发现时间${preservation.posts.protectedFieldsUnchanged ? "保留" : "存在差异"}。`,
      `- 原板块关系 ${preservation.originalMemberships.beforeCount} 条：${preservation.originalMemberships.unchanged ? "原值全部保留" : "存在差异"}。`,
      `- SQLite 完整性：${result.acceptance.databaseIntegrity ? "quick_check 通过，外键无异常" : "存在异常"}。`, "",
      "## 尚未严格对应的源记录", "", "| 原行 | 原名称 | 原填 ID | 已对应目标 | 原作品状态 | 具体原因 |", "|---:|---|---|---|---|---|",
      ...sourceRows.filter(row => !row.inBoardTargetIds.length || row.evidenceState !== "verified").map(row => `| ${row.sourceRow} | ${md(row.name)} | ${md(row.submittedId) || "未填"} | ${row.inBoardTargetIds.join("、") || "未对应"} | ${states[row.evidenceState]} | ${md(unique(row.queue.map(item => item.lastError).filter(Boolean)).join("；") || (row.evidenceState === "no_work_evidence" ? "原行缺作品；有精确身份可复用既有账号，否则保留待补信息" : "尚未取得原身份及该作品组合的通过记录"))} |`), "",
      "公开候选账号及号码差异单独写入 audit.json.publicCandidateObservations，不改写原记录核验状态。", "",
    ].join("\n");
    await writeFile(`${DIRECTORY}/audit.json`, `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(`${DIRECTORY}/一条小团团补充名单核对.md`, `${report}\n`);
    console.log(JSON.stringify({ acceptance: result.acceptance, summary: result.summary,
      parserAfterFix: { available: result.parserAudit.afterFix.available, passed: result.parserAudit.afterFix.passed,
        rowCount: result.parserAudit.afterFix.rowCount ?? 0, differenceCount: result.parserAudit.afterFix.differences.length,
        blockingDifferenceCount: result.parserAudit.afterFix.blockingDifferenceCount ?? 0,
        hyperlinkEvidenceRowCount: result.parserAudit.afterFix.additionalHyperlinkEvidenceRows?.length ?? 0 },
      storedEvidenceReuse: storedEvidenceReuse ? { passed: storedEvidenceReuse.passed,
        actualResolvedAndVerifiedCount: storedEvidenceReuse.actualResolvedAndVerifiedCount,
        fullStoredPayloadCount: storedEvidenceReuse.fullStoredPayloadCount, strictLedgerOnlyCount: storedEvidenceReuse.strictLedgerOnlyCount } : null,
      originalMemberships: preservation.originalMemberships,
      report: `${DIRECTORY}/一条小团团补充名单核对.md` }));
    if (!sourceComplete || !preserved || outsideSource.length || missingPreviousMembers.length
      || result.acceptance.ambiguousSourceRows.length || !result.acceptance.databaseIntegrity
      || storedEvidenceReuse?.passed === false) process.exitCode = 2;
  } finally { db.close(); before.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

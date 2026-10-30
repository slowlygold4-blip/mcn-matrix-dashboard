/**
 * Poll previously imported Feishu sheet sources without Codex, a model token,
 * or a paid data API. The local Feishu CLI remains the only cloud reader and
 * the workbench's existing preview/commit APIs keep the source revision and
 * content hash gate in place.
 *
 * Run once from launchd or a shell:
 *   node scripts/source-poller.mjs --once
 * Run continuously (the launchd service uses this mode):
 *   node scripts/source-poller.mjs --loop
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveLarkCliCommand, larkWorkbookInfoArguments } from "../lib/lark-sheet-source.mjs";
import { sourcePollKey as sourceKey, sourceReadContract, sourceNeedsInitialCheck, hasRecoverableSourceJob, projectSourceJobSummary, completedSourceJobSummary } from "../lib/source-poller-status.mjs";
import { mapBitableAuthorRows } from "../lib/source-bitable-mapping.mjs";
import { createWorkSourcePollReader } from '../lib/work-source-poll.mjs';
import { SOURCE_POLLER_CAPABILITY_HEADER, normalizeLoopbackHttpOrigin, readSourcePollerCapability } from "../lib/internal-source-capability.mjs";
import { withPublisherRecoveryLock } from "./public-replica-publisher.mjs";
export { completedSourceJobSummary } from "../lib/source-poller-status.mjs";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = resolve(projectDir, process.env.DATA_DIR || "data");
const pollDir = join(dataDir, "source-poll");
const manifestPath = join(pollDir, "manifest.json");
const registryPath = join(pollDir, "registry.json");
const lockPath = join(pollDir, ".poll.lock");
const baseUrl = normalizeLoopbackHttpOrigin(process.env.SOURCE_POLL_BASE_URL || "http://127.0.0.1:4188");
export const DEFAULT_SOURCE_POLL_INTERVAL_MS = 24 * 60 * 60_000;
export const SOURCE_REGISTRY_DISCOVERY_INTERVAL_MS = 60_000;
export const DEFAULT_UNCHECKED_BATCH_SIZE = 5;
export const SOURCE_POLL_BEIJING_ANCHOR_HOUR = 0;
export const MAX_SOURCE_FAILURE_RETRY_MS = 6 * 60 * 60_000;
const intervalMs = Math.max(5 * 60_000, Number(process.env.SOURCE_POLL_INTERVAL_MS) || DEFAULT_SOURCE_POLL_INTERVAL_MS);
const retryDelayMs = Math.max(30_000, Number(process.env.SOURCE_POLL_RETRY_MS) || 5 * 60_000);
const requestTimeoutMs = Math.max(30_000, Number(process.env.SOURCE_POLL_REQUEST_TIMEOUT_MS) || 15 * 60_000);
const execFileAsync = promisify(execFile);

export async function trustedBitableRequestHeaders(headers, { dataDirectory = dataDir } = {}) {
  const capability = await readSourcePollerCapability(dataDirectory);
  return { ...(headers || {}), [SOURCE_POLLER_CAPABILITY_HEADER]: capability };
}

function clean(value, limit = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/([?&](?:token|access_token|authorization|cookie|secret|key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(["'](?:access_token|refresh_token|authorization|cookie|password|secret|client_secret|api_key)["']\s*:\s*["'])[^"']*/gi, "$1[REDACTED]")
    .replace(/\b(?:access_token|refresh_token|authorization|password|secret|client_secret|api_key)\s*[=:]\s*[^\s,;&]+/gi, "[REDACTED]")
    .replace(/\b(?:Bearer\s+|token\s*[=:]\s*)[^\s,;]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanForSource(value, source, limit = 500) {
  let message = clean(value, limit);
  const secrets = [source?.baseToken, source?.accessToken, source?.appToken]
    .map((item) => String(item ?? "").trim()).filter((item) => item.length >= 6);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message;
}

function sourceRevision(source) {
  const revision = Number(source?.revision ?? source?.sourceRevision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

// The server stores this key in the same transaction as the job. A poller
// crash after HTTP 202 but before manifest persistence therefore replays the
// accepted job instead of creating a second import for the same source bytes.
export function sourceSubmissionIdentity(source) {
  const sourceSha256 = String(source?.sourceSha256 ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("来源内容校验值缺失；未提交无法去重的导入任务");
  const identity = [
    String(source?.sourceType ?? ""), String(source?.sourceUrl ?? ""),
    String(source?.sourceSheetId ?? ""), String(source?.sheetName ?? ""),
    sourceRevision(source), sourceSha256, String(source?.sourceTitle ?? ""),
    String(source?.defaultBoard ?? ""),
  ];
  const hash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// A public submission form is not permission to read its response database.
// Only an explicitly resolved, authorized table may take the bitable path.
export function sourceReadBlockReason(source) {
  if (source?.readPolicy === "unresolved-alias") return cleanForSource(source.blockedReason || "原始链接尚未核实与可读取数据表的映射；保留来源，不推测替换或导入", source, 500);
  let url;
  try { url = new URL(String(source?.sourceUrl || "")); }
  catch { return "来源链接无效；未执行读取"; }
  if (url.protocol !== "https:" || !/(^|\.)(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(url.hostname)) {
    return "此来源不属于已接入的飞书读取器；需要对应的授权读取方式";
  }
  if (source.sourceType === "lark-bitable" && source.baseToken && source.tableId) return null;
  if (source.sourceType === 'lark-work-source') return source.readPolicy === 'authorized-work-facts'
    && source.kind === 'work-statistics' && source.monitorOnly !== true ? null : '作品来源缺少明确的整表入库策略；未走作者导入通道';
  if (/\/share\/base\/form\//i.test(url.pathname)) return "仅有公开填写表单链接，无法读取提交记录；需要已授权的原数据表链接";
  if (source.sourceType === "lark-bitable") return "多维表缺少原数据表定位信息；未读取或导入任何记录";
  return null;
}

export async function readMonitorOnlyMetadata(source, { commandRunner = execFileAsync, command = null } = {}) {
  const executable = command || await resolveLarkCliCommand();
  const result = await commandRunner(executable, larkWorkbookInfoArguments(source.sourceUrl), {
    timeout: requestTimeoutMs, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LARK_CLI_NO_PROXY: "1" },
  });
  const envelope = parseCliJson(result.stdout);
  if (!envelope?.ok) throw new Error(cleanForSource(envelope?.error?.message || "飞书元数据读取失败", source, 500));
  const data = envelope.data || {};
  const revision = Number(data.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("来源未返回有效修订号；不能判断信息是否变化");
  return { revision, title: clean(data.title || source.sourceTitle || source.title, 200),
    sheetCount: Array.isArray(data.sheets) ? data.sheets.length : null, readMode: "workbook-metadata" };
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function sourcePollBusinessDate(value, { anchorHour = SOURCE_POLL_BEIJING_ANCHOR_HOUR } = {}) {
  const date = validDate(value);
  if (!date) return null;
  const safeHour = Math.max(0, Math.min(23, Math.trunc(Number(anchorHour) || 0)));
  return new Date(date.getTime() + (8 - safeHour) * 60 * 60_000).toISOString().slice(0, 10);
}

function nextSourcePollAnchor(value, { anchorHour = SOURCE_POLL_BEIJING_ANCHOR_HOUR } = {}) {
  const date = validDate(value);
  if (!date) return null;
  const safeHour = Math.max(0, Math.min(23, Math.trunc(Number(anchorHour) || 0)));
  const shifted = new Date(date.getTime() + (8 - safeHour) * 60 * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1)
    - (8 - safeHour) * 60 * 60_000;
}

export function nextSourcePollDelay(manifest, { now = new Date(), anchorHour = SOURCE_POLL_BEIJING_ANCHOR_HOUR } = {}) {
  const current = validDate(now);
  if (!current) return 0;
  const finishedValue = manifest && Object.hasOwn(manifest, "lastFinishedAt")
    ? manifest.lastFinishedAt
    : manifest?.updatedAt;
  const finished = validDate(finishedValue);
  // A missing, future or corrupt receipt is not permission to skip a source check.
  if (!finished || finished.getTime() > current.getTime()) return 0;
  const currentBusinessDate = sourcePollBusinessDate(current, { anchorHour });
  const finishedBusinessDate = sourcePollBusinessDate(finished, { anchorHour });
  const explicitBusinessDate = /^\d{4}-\d{2}-\d{2}$/.test(String(manifest?.lastFullBusinessDate || ""))
    ? manifest.lastFullBusinessDate : null;
  if (explicitBusinessDate && explicitBusinessDate !== finishedBusinessDate) return 0;
  const recordedBusinessDate = explicitBusinessDate || finishedBusinessDate;
  if (recordedBusinessDate !== currentBusinessDate) return 0;
  return Math.max(0, nextSourcePollAnchor(current, { anchorHour }) - current.getTime());
}

export function sourceFailureRetryPlan(receipt, { now = new Date(), retryDelay = 5 * 60_000,
  maxRetryDelay = MAX_SOURCE_FAILURE_RETRY_MS } = {}) {
  if (receipt?.lastStatus !== "failed") return { due: false, delayMs: Infinity };
  const current = validDate(now);
  if (!current) return { due: true, delayMs: 0 };
  const retryAt = validDate(receipt?.nextRetryAt);
  if (!retryAt || retryAt.getTime() <= current.getTime()) return { due: true, delayMs: 0 };
  const cap = Math.max(30_000, Number(maxRetryDelay) || MAX_SOURCE_FAILURE_RETRY_MS);
  return { due: false, delayMs: Math.min(cap, retryAt.getTime() - current.getTime()) };
}

function failedSourceReceipt(previous, current, error, source, { now, retryDelay }) {
  const failureCount = previous?.lastStatus === "failed"
    ? Math.max(0, Math.trunc(Number(previous.consecutiveFailureCount) || 0)) + 1
    : 1;
  const baseDelay = Math.max(30_000, Number(retryDelay) || 5 * 60_000);
  const delay = Math.min(MAX_SOURCE_FAILURE_RETRY_MS, baseDelay * (2 ** Math.min(10, failureCount - 1)));
  return {
    ...previous,
    ...current,
    lastStatus: "failed",
    lastError: cleanForSource(error, source, 500),
    lastFailureAt: now.toISOString(),
    consecutiveFailureCount: failureCount,
    nextRetryAt: new Date(now.getTime() + delay).toISOString(),
  };
}

function successfulSourceReceipt(value) {
  return { ...value, consecutiveFailureCount: 0, nextRetryAt: null };
}

export function sourcePollLoopPlan(manifest, { now = new Date(), registry = [], interval = DEFAULT_SOURCE_POLL_INTERVAL_MS,
  retryDelay = 5 * 60_000, discoveryIntervalMs = SOURCE_REGISTRY_DISCOVERY_INTERVAL_MS } = {}) {
  const fullCheckDelayMs = nextSourcePollDelay(manifest, { now });
  const hasPending = Object.values(manifest?.sources || {}).some((source) => source.lastStatus === "pending");
  const recoverablePendingCount = Object.values(manifest?.sources || {}).filter(hasRecoverableSourceJob).length;
  const unrecoverablePendingCount = Object.values(manifest?.sources || {}).filter((source) => source.lastStatus === "pending" && !hasRecoverableSourceJob(source)).length;
  const uncheckedKeys = [...new Set(registry.filter((source) => clean(source?.sourceUrl))
    .filter((source) => sourceNeedsInitialCheck(source, manifest?.sources?.[sourceKey(source)]))
    .map(sourceKey))];
  const sincePending = now.getTime() - Date.parse(manifest?.lastPendingCheckedAt || "");
  const pendingDelayMs = recoverablePendingCount > 0
    ? Number.isFinite(sincePending) && sincePending >= 0 ? Math.max(0, retryDelay - sincePending) : 0
    : Infinity;
  const failedEntries = Object.entries(manifest?.sources || {})
    .filter(([, source]) => source?.lastStatus === "failed")
    .map(([key, source]) => ({ key, ...sourceFailureRetryPlan(source, { now, retryDelay }) }));
  const failedKeys = failedEntries.filter((entry) => entry.due).map((entry) => entry.key);
  const failedRetryDelayMs = failedEntries.length
    ? Math.min(...failedEntries.map((entry) => entry.delayMs))
    : Infinity;
  const workLinkEntries=registry.filter(s=>s.sourceType==='lark-work-source'&&s.resolveWorkLinks===true)
    .map(s=>({key:sourceKey(s),receipt:manifest?.sources?.[sourceKey(s)]}))
    .filter(({receipt})=>receipt&&receipt.lastStatus!=='failed'&&Number.isFinite(Date.parse(receipt.workLinkResolution?.retryAt)))
    .map(({key,receipt})=>({key,delay:Math.max(0,Date.parse(receipt.workLinkResolution.retryAt)-now.getTime())}));
  const workLinkKeys=workLinkEntries.filter(e=>e.delay===0).map(e=>e.key);
  const workLinkDelayMs=workLinkEntries.length?Math.min(...workLinkEntries.map(e=>e.delay)):Infinity;
  const mode = fullCheckDelayMs === 0 ? "full"
    : uncheckedKeys.length ? "unchecked"
      : pendingDelayMs === 0 ? "pending"
        : failedKeys.length ? "failed" : workLinkKeys.length ? 'work-links' : "idle";
  return { mode, hasPending, recoverablePendingCount, unrecoverablePendingCount, uncheckedKeys, uncheckedCount: uncheckedKeys.length, fullCheckDelayMs,
    resumePendingOnly: mode === "pending", uncheckedOnly: mode === "unchecked",
    retryFailedOnly: mode === "failed", failedKeys, failedCount: failedEntries.length, failedRetryDelayMs,
    workLinksOnly:mode==='work-links',workLinkKeys,workLinkDelayMs,
    nextDelayMs: mode !== "idle" ? 0 : Math.min(fullCheckDelayMs, pendingDelayMs, failedRetryDelayMs,workLinkDelayMs,
      Math.max(1_000, Number(discoveryIntervalMs) || SOURCE_REGISTRY_DISCOVERY_INTERVAL_MS)) };
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function readManifest() {
  try {
    const value = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!value || typeof value !== "object" || !value.sources || typeof value.sources !== "object") throw new Error("来源轮询清单格式无效");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, updatedAt: null, sources: {} };
    throw error;
  }
}

async function readRegistry() {
  try {
    const value = JSON.parse(await readFile(registryPath, "utf8"));
    if (!Array.isArray(value?.sources)) throw new Error("来源目录缺少 sources 数组；未执行来源检查");
    return value.sources.filter((source) => source && typeof source === "object");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeManifest(manifest) {
  await mkdir(pollDir, { recursive: true, mode: 0o700 });
  const temporary = `${manifestPath}.${process.pid}.${randomUUID()}.partial`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, manifestPath);
}

export async function acquireSourcePollLock() {
  await mkdir(pollDir, { recursive: true, mode: 0o700 });
  // The OS mutex covers *both* initial claims and stale recovery. Otherwise
  // another process can claim the pathname in the unlink/open gap.
  const createOwner = async () => {
    const handle = await open(lockPath, "wx", 0o600);
    const token = randomUUID();
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      await handle.sync();
      const identity = await handle.stat();
      return { token, ino: identity.ino, dev: identity.dev };
    } finally { await handle.close(); }
  };
  try {
    return await withPublisherRecoveryLock(lockPath, async () => {
      try { return await createOwner(); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
    let stale = false;
    try {
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      if (lock?.pid) {
        try { process.kill(Number(lock.pid), 0); }
        catch (probeError) { stale = probeError?.code !== "EPERM"; }
      } else stale = age > intervalMs * 2;
      // A large source roster can legitimately run for more than 30 minutes.
      // Never steal the lock from a live process merely because it is old.
    } catch {
      // A competing process may have created the exclusive lock but not yet
      // written its PID. Do not steal an empty, freshly created lock.
      try { stale = Date.now() - (await stat(lockPath)).mtimeMs > 30_000; }
      catch (statError) { if (statError?.code !== "ENOENT") throw statError; return createOwner(); }
    }
    if (stale) {
      try { await unlink(lockPath); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
      return createOwner();
    }
    return false;
    });
  } catch (error) {
    if (error?.code === "publisher-recovery-busy") return false;
    throw error;
  }
}

export async function releaseSourcePollLock(owner) {
  if (!owner?.token) return;
  try {
    const identity = await stat(lockPath);
    if (identity.ino !== owner.ino || identity.dev !== owner.dev) return;
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    if (lock.token !== owner.token) return;
    await unlink(lockPath);
  } catch (error) { if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
}

function responseCookies(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function fetchJson(path, options = {}) {
  const { timeoutMs = requestTimeoutMs, ...requestOptions } = options;
  const response = await fetch(`${baseUrl}${path}`, { ...requestOptions, signal: AbortSignal.timeout(timeoutMs) });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`${response.status}: 服务返回了无法识别的内容`); }
  if (!response.ok) throw new Error(`${response.status}: ${clean(payload?.error || "本地服务请求失败", 400)}`);
  return payload;
}

export async function readSession() {
  const response = await fetch(`${baseUrl}/api/source-poll/bootstrap`, { signal: AbortSignal.timeout(requestTimeoutMs) });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`${response.status}: 本地工作台尚未就绪`); }
  if (!response.ok) {
    throw new Error(`${response.status}: ${clean(payload?.error || "来源维护连接失败", 300)}`);
  }
  if (!payload?.auth?.csrfToken || !payload.auth?.permissions?.edit) {
    throw new Error("本地工作台没有可用的编辑权限，来源轮询已暂停");
  }
  const cookie = responseCookies(response);
  const headers = { "content-type": "application/json", cookie, "x-csrf-token": payload.auth.csrfToken, origin: baseUrl };
  return { bootstrap: payload, headers };
}

async function apiRequest(path, headers, body) {
  return fetchJson(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function waitForJob(id, headers) {
  // One bounded status observation, not a 15-minute wait per pending source.
  // Queued/running work remains durable and must not starve other sources.
  return fetchJson(`/api/author-spreadsheet/jobs/${encodeURIComponent(id)}`, {
    headers, timeoutMs: Math.min(requestTimeoutMs, 15_000),
  });
}

function jobPollStatus(job) {
  return job?.status === "completed" ? "submitted" : job?.status === "failed" ? "failed" : "pending";
}

function parseCliJson(stdout) {
  const text = String(stdout ?? "").trim();
  try { return JSON.parse(text); }
  catch { throw new Error("飞书多维表读取组件返回了无法识别的结果"); }
}

export async function readBitable(source, { commandRunner = execFileAsync, command = null } = {}) {
  // launchd starts with a deliberately minimal PATH. Resolve the user's
  // existing local lark-cli installation explicitly instead of relying on an
  // interactive shell PATH (no credential material is passed in the plist).
  const executable = command || await resolveLarkCliCommand();
  const rows = [];
  let fields = [];
  let revision = 0;
  let offset = 0;
  let pageCount = 0;
  const seenRecordIds = new Set();
  const pageSize = 200;
  for (;;) {
    const args = ["base", "+record-list", "--base-token", String(source.baseToken || ""), "--table-id", String(source.tableId || ""), "--offset", String(offset), "--limit", String(pageSize), "--format", "json", "--as", "user"];
    let result;
    try {
      result = await commandRunner(executable, args, { timeout: requestTimeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LARK_CLI_NO_PROXY: "1" } });
    } catch (error) {
      throw new Error(cleanForSource(error?.stderr || error?.message || "飞书多维表读取失败", source, 500));
    }
    const envelope = parseCliJson(result.stdout);
    if (!envelope?.ok) throw new Error(cleanForSource(envelope?.error?.message || envelope?.error || "飞书多维表读取失败", source, 500));
    const data = envelope.data || {};
    if (!Array.isArray(data.data)) throw new Error("飞书多维表记录格式无法识别；未将错误响应视为空表");
    // An absent/loosely typed terminal marker is an incomplete response, not
    // permission to declare the accumulated rows a complete source version.
    if (typeof data.has_more !== "boolean") throw new Error("飞书多维表缺少有效分页结束标志；未导入部分数据");
    if (fields.length && Array.isArray(data.fields) && JSON.stringify(fields) !== JSON.stringify(data.fields)) {
      throw new Error("飞书多维表分页字段发生变化；未按旧列顺序拼接或导入部分数据");
    }
    if (!fields.length) fields = Array.isArray(data.fields) ? data.fields : [];
    // Preserve a real revision zero, but never invent it for missing metadata
    // or coerce null/booleans into a valid source revision.
    const revisionValue = data.rev;
    const pageRevision = typeof revisionValue === "number"
      || typeof revisionValue === "string" && /^\d+$/.test(revisionValue)
      ? Number(revisionValue) : NaN;
    if (!Number.isSafeInteger(pageRevision) || pageRevision < 0) throw new Error("飞书多维表返回无效修订号；未导入部分数据");
    if (pageCount && pageRevision !== revision) throw new Error("飞书多维表分页修订号发生变化；未拼接不同版本或导入部分数据");
    revision = pageRevision;
    pageCount += 1;
    const values = Array.isArray(data.data) ? data.data : [];
    const ids = Array.isArray(data.record_id_list) ? data.record_id_list : [];
    if (ids.length !== values.length) throw new Error("飞书多维表记录 ID 与数据行数量不一致；未导入无法核对的记录");
    for (const id of ids) {
      if (typeof id !== "string" || !/^rec[A-Za-z0-9_-]{6,120}$/.test(id) || seenRecordIds.has(id)) {
        throw new Error("飞书多维表记录 ID 缺失、无效或重复；未导入无法核对的记录");
      }
      seenRecordIds.add(id);
    }
    for (let index = 0; index < values.length; index += 1) rows.push({ values: values[index], recordId: ids[index] || "" });
    if (data.has_more && !values.length) throw new Error("飞书多维表仍有后续分页但返回空页；未将不完整读取视为全表");
    if (!data.has_more) break;
    offset += values.length;
    if (offset > 20_000) throw new Error("飞书多维表超过自动轮询上限 20,000 行");
  }
  const hash = createHash("sha256").update(JSON.stringify({ fields, rows })).digest("hex");
  const mapped = await mapBitableAuthorRows({ fields, rows, defaultBoard: source.defaultBoard });
  return { revision, sourceSha256: hash, sourceReadAt: new Date().toISOString(), rows: mapped, fields, count: rows.length };
}

function comparableRevision(source, previous) {
  const currentRevision = sourceRevision(source);
  const previousRevision = sourceRevision(previous);
  const currentHash = clean(source?.sourceSha256).toLowerCase();
  const previousHash = clean(previous?.sourceSha256).toLowerCase();
  if (currentHash && previousHash) return currentHash !== previousHash;
  if (currentRevision && previousRevision) {
    return currentRevision !== previousRevision;
  }
  return clean(source?.readAt) !== clean(previous?.readAt) || clean(source?.sourceSha256) !== clean(previous?.sourceSha256);
}

/**
 * Poll all source cards belonging to the authenticated local owner. The
 * function is exported for a deterministic test and remains side-effect free
 * when no source revision changed.
 */
export async function pollOnce({ session = null, now = new Date(), resumePendingOnly = false, uncheckedOnly = false,
  retryFailedOnly = false, retrySourceKeys = [], failureRetryDelay = retryDelayMs,
  workLinksOnly=false,workLinkSourceKeys=[],
  maxSources = DEFAULT_UNCHECKED_BATCH_SIZE, monitorMetadataReader = readMonitorOnlyMetadata, workSourceReader = null } = {}) {
  if ([resumePendingOnly, uncheckedOnly, retryFailedOnly,workLinksOnly].filter(Boolean).length > 1) {
    throw new Error("来源补查、失败重试与导入恢复不能同时指定");
  }
  const incrementalLimit = Math.max(1, Math.min(50, Math.trunc(Number(maxSources) || DEFAULT_UNCHECKED_BATCH_SIZE)));
  const failedKeyFilter = new Set(Array.isArray(retrySourceKeys) ? retrySourceKeys.map(String) : []);
  const linkKeyFilter=new Set(Array.isArray(workLinkSourceKeys)?workLinkSourceKeys.map(String):[]);
  const acquired = await acquireSourcePollLock();
  if (!acquired) return { status: "skipped", reason: "poll-locked", changed: 0, sources: [] };
  try {
    const currentSession = session || await readSession();
    const registry = await readRegistry();
    const sourceList = [
      ...(!uncheckedOnly && !workLinksOnly && Array.isArray(currentSession.bootstrap?.authorSources) ? currentSession.bootstrap.authorSources : []),
      ...registry,
    ];
    const sourceMap = new Map(sourceList.map((source) => [sourceKey(source), source]));
    const manifest = await readManifest();
    for (const [key, receipt] of Object.entries(manifest.sources)) {
      if (hasRecoverableSourceJob(receipt) && !sourceMap.has(key)) {
        sourceMap.set(key, { ...receipt, resumeReceiptOnly: true });
      }
    }
    const nextSources = { ...manifest.sources };
    const results = [];
    const readWorkSource = workSourceReader || createWorkSourcePollReader({ dataDirectory: dataDir });
    let pendingPolled = false;
    const savePendingJob = async (current, submitted, previous) => {
      if (!submitted?.id) throw new Error("导入任务未返回可恢复的任务编号");
      nextSources[current.key] = { ...current, lastStatus: "pending", lastJobId: submitted.id,
        sourceJobSummary: null,
        lastJobSubmittedAt: new Date().toISOString(), lastSuccessfulAt: previous?.lastSuccessfulAt || null, lastError: null };
      // Persist the job receipt before the first status GET. A network error
      // must resume this exact job, not enqueue identical imports next time.
      await writeManifest({ ...manifest, version: 2, intervalMs, sources: nextSources });
    };
    for (const [key, source] of sourceMap) {
      if (!clean(source?.sourceUrl)) continue;
      let previous = nextSources[key] || null;
      if(workLinksOnly&&(source.sourceType!=='lark-work-source'||source.resolveWorkLinks!==true
        ||linkKeyFilter.size&&!linkKeyFilter.has(key)||previous?.lastStatus==='failed'
        ||!Number.isFinite(Date.parse(previous?.workLinkResolution?.retryAt))
        ||Date.parse(previous.workLinkResolution.retryAt)>now.getTime()))continue;
      if (uncheckedOnly && !sourceNeedsInitialCheck(source, previous)) continue;
      if (uncheckedOnly && results.length >= incrementalLimit) break;
      if (resumePendingOnly && previous?.lastStatus !== "pending") continue;
      if (retryFailedOnly && (previous?.lastStatus !== "failed"
        || failedKeyFilter.size && !failedKeyFilter.has(key)
        || !sourceFailureRetryPlan(previous, { now, retryDelay: failureRetryDelay }).due)) continue;
      try {
        if (previous?.lastStatus === "pending" && !hasRecoverableSourceJob(previous)) {
          const blocked = { ...previous, lastError: "导入回执缺少可恢复的任务编号；未重新提交重复任务" };
          nextSources[key] = blocked;
          results.push({ ...blocked, status: "pending", recoveryBlocked: true });
          continue;
        }
        if (hasRecoverableSourceJob(previous)) {
          pendingPolled = true;
          const job = await waitForJob(previous.lastJobId, currentSession.headers);
          const observed = { ...previous, lastStatus: jobPollStatus(job),
            sourceJobSummary: completedSourceJobSummary(job, previous.lastJobId),
            lastJobCheckedAt: new Date().toISOString(), lastError: job.status === "failed" ? cleanForSource(job.error, source, 500) : null };
          previous = job.status === "failed"
            ? failedSourceReceipt(previous, observed, job.error || "来源导入任务失败", source,
              { now, retryDelay: failureRetryDelay })
            : job.status === "completed" ? successfulSourceReceipt(observed) : observed;
          if (job.status === "completed") previous.lastSuccessfulAt = previous.lastCheckedAt;
          nextSources[key] = previous;
          await writeManifest({ ...manifest, version: 2, intervalMs, sources: nextSources });
          if (job.status === "failed") {
            // The failure was just observed. Its new backoff starts now; a
            // daily/full pass must not immediately resubmit the same source.
            results.push({ ...previous, status: "failed", resumed: true });
            continue;
          }
          if (previous.lastStatus === "pending" || resumePendingOnly || source.resumeReceiptOnly) { results.push({ ...previous, status: previous.lastStatus, resumed: true }); continue; }
        }
        const blockedReason = sourceReadBlockReason(source);
        if (blockedReason) {
          const blocked = { ...previous, key, sourceUrl: clean(source.sourceUrl, 1_000),
            readContract: sourceReadContract(source),
            sourceTitle: clean(source.sourceTitle || source.title, 200), defaultBoard: clean(source.defaultBoard, 120),
            monitorOnly: source.monitorOnly === true, readPolicy: clean(source.readPolicy, 80),
            readMode: source.readPolicy === "unresolved-alias" ? "unresolved-alias" : source.monitorOnly === true ? "workbook-metadata" : "author-table",
            lastCheckedAt: now.toISOString(), lastStatus: "blocked", lastError: blockedReason,
            consecutiveFailureCount: 0, nextRetryAt: null };
          nextSources[key] = blocked;
          results.push({ ...blocked, status: "blocked" });
          continue;
        }
        if (source.sourceType === 'lark-work-source') {
          const edition = await readWorkSource(source);
          const status = edition.status === 'imported' ? 'changed' : 'unchanged';
          nextSources[key] = successfulSourceReceipt({ key, sourceType: source.sourceType,
            sourceUrl: clean(source.sourceUrl, 1_000), sourceTitle: clean(source.sourceTitle || source.title, 200),
            readContract: sourceReadContract(source), readPolicy: source.readPolicy, kind: source.kind,
            resolveWorkLinks:source.resolveWorkLinks===true,
            monitorOnly: false, readMode: 'whole-workbook-facts', contentImported: true,
            sourceRevision: edition.sourceRevision, sourceSha256: edition.sourceSha256,
            sourceVersionId: edition.versionId, workFactCount: edition.factCount, sourceReadAt: edition.sourceReadAt,
            ...(edition.workLinkResolution?{workLinkResolution:edition.workLinkResolution}:{}),
            lastCheckedAt: now.toISOString(), lastSuccessfulAt: now.toISOString(), lastStatus: status, lastError: null });
          results.push({ ...nextSources[key], status });
          continue;
        }
        if (source.monitorOnly === true) {
          const metadata = await monitorMetadataReader(source);
          const status = previous && sourceRevision(previous) === metadata.revision ? "unchanged" : "changed";
          const current = { key, sourceUrl: clean(source.sourceUrl, 1_000), sourceTitle: metadata.title,
            readContract: sourceReadContract(source), readPolicy: clean(source.readPolicy, 80),
            sourceRevision: metadata.revision, sheetCount: metadata.sheetCount, readMode: metadata.readMode,
            monitorOnly: true, kind: clean(source.kind, 80), lastCheckedAt: now.toISOString(), lastSuccessfulAt: now.toISOString(),
            lastStatus: status, lastError: null, contentImported: false };
          nextSources[key] = successfulSourceReceipt(current);
          results.push({ ...nextSources[key], status });
          continue;
        }
        if (source.sourceType === "lark-bitable") {
          const bitable = await readBitable(source);
          const current = {
            key, sourceType: "lark-bitable", sourceUrl: clean(source.sourceUrl, 1_000), sourceTitle: clean(source.sourceTitle || source.title, 200),
            readContract: sourceReadContract(source), readPolicy: clean(source.readPolicy, 80), monitorOnly: false,
            sourceRevision: bitable.revision, sourceSha256: bitable.sourceSha256, sourceReadAt: bitable.sourceReadAt,
            sourceSheetId: clean(source.tableId, 120), sheetName: clean(source.sheetName || "数据表", 120),
            defaultBoard: clean(source.defaultBoard, 120), lastCheckedAt: now.toISOString(),
          };
          const baseline = previous || { sourceRevision: sourceRevision(source), sourceSha256: clean(source.sourceSha256, 64).toLowerCase() };
          const changed = previous?.lastStatus === "failed" || Boolean(previous && sourceNeedsInitialCheck(source, previous)) || comparableRevision(current, baseline);
          if (!changed) {
            nextSources[key] = successfulSourceReceipt({ ...previous, ...current,
              lastSuccessfulAt: now.toISOString(), lastStatus: "unchanged", lastError: null });
            results.push({ ...nextSources[key], status: "unchanged" });
            continue;
          }
          // Read the private capability immediately before every Bitable
          // submission so a restarted server can be adopted without placing
          // the secret in the registry, manifest or job payload.
          const trustedHeaders = await trustedBitableRequestHeaders(currentSession.headers);
          const submitted = await apiRequest("/api/author-spreadsheet/auto-monitor", {
            ...trustedHeaders, "idempotency-key": sourceSubmissionIdentity(current),
          }, {
            sourceType: "lark-bitable", fileName: `${current.sourceTitle}-rev${current.sourceRevision}.json`, sheetName: current.sheetName,
            sourceUrl: current.sourceUrl, sourceTitle: current.sourceTitle, sourceRevision: current.sourceRevision,
            sourceSheetId: current.sourceSheetId, sourceSha256: current.sourceSha256, sourceReadAt: current.sourceReadAt,
            defaultBoard: current.defaultBoard, uploadSha256: current.sourceSha256, rows: bitable.rows,
          });
          await savePendingJob(current, submitted, previous);
          pendingPolled = true;
          const job = await waitForJob(submitted.id, currentSession.headers);
          const status = jobPollStatus(job);
          const observed = { ...nextSources[key], ...current, sourceJobSummary: completedSourceJobSummary(job, submitted.id),
            lastJobCheckedAt: new Date().toISOString(), lastSuccessfulAt: status === "submitted" ? now.toISOString() : previous?.lastSuccessfulAt || null,
            lastStatus: status, lastJobId: submitted.id, lastError: status === "failed" ? cleanForSource(job.error, source, 500) : null };
          nextSources[key] = status === "failed"
            ? failedSourceReceipt(previous, observed, job.error || "来源导入任务失败", source,
              { now, retryDelay: failureRetryDelay })
            : status === "submitted" ? successfulSourceReceipt(observed) : observed;
          results.push({ ...nextSources[key], status, jobId: submitted.id, jobStatus: job.status, rows: bitable.count });
          continue;
        }
        const preview = await apiRequest("/api/author-spreadsheet/lark-preview", currentSession.headers, {
          url: source.sourceUrl,
          ...(source.sheetName ? { sheetName: source.sheetName } : {}),
        });
        const current = {
          key,
          sourceType: "lark-sheet",
          readContract: sourceReadContract(source), readPolicy: clean(source.readPolicy, 80), monitorOnly: false,
          sourceUrl: clean(preview?.source?.url || source.sourceUrl, 1_000),
          sourceTitle: clean(preview?.source?.title || source.title, 200),
          sourceRevision: sourceRevision(preview?.source),
          sourceSheetId: clean(preview?.source?.selectedSheetId || source.sheetId, 120),
          sheetName: clean(preview?.source?.selectedSheet || source.sheetName, 120),
          sourceSha256: clean(preview?.source?.contentSha256, 64).toLowerCase(),
          sourceExportSha256: clean(preview?.source?.exportSha256, 64).toLowerCase(),
          sourceReadAt: clean(preview?.source?.readAt || now.toISOString(), 40),
          defaultBoard: clean(source.defaultBoard, 120),
          lastCheckedAt: now.toISOString(),
        };
        const baseline = previous || {
          sourceRevision: sourceRevision(source),
          sourceSha256: clean(source.contentSha256, 64).toLowerCase(),
          sourceReadAt: clean(source.readAt, 40),
        };
        const changed = previous?.lastStatus === "failed"
          || Boolean(previous && sourceNeedsInitialCheck(source, previous))
          || comparableRevision({ revision: current.sourceRevision, readAt: current.sourceReadAt, sourceSha256: current.sourceSha256 }, baseline);
        if (!changed) {
          nextSources[key] = successfulSourceReceipt({ ...previous, ...current,
            lastSuccessfulAt: now.toISOString(), lastStatus: "unchanged", lastError: null });
          results.push({ ...nextSources[key], status: "unchanged" });
          continue;
        }
        const submitted = await apiRequest("/api/author-spreadsheet/auto-monitor", {
          ...currentSession.headers, "idempotency-key": sourceSubmissionIdentity(current),
        }, {
          sourceType: "lark-sheet",
          sourceUrl: current.sourceUrl,
          sourceRevision: current.sourceRevision,
          sourceSheetId: current.sourceSheetId,
          sourceSha256: current.sourceSha256,
          sourceExportSha256: current.sourceExportSha256,
          sourceReadAt: current.sourceReadAt,
          sourceTitle: current.sourceTitle,
          sheetName: current.sheetName,
          defaultBoard: current.defaultBoard,
          uploadSha256: current.sourceSha256,
        });
        await savePendingJob(current, submitted, previous);
        pendingPolled = true;
        const job = await waitForJob(submitted.id, currentSession.headers);
        const status = jobPollStatus(job);
        const observed = { ...nextSources[key], ...current, sourceJobSummary: completedSourceJobSummary(job, submitted.id),
          lastJobCheckedAt: new Date().toISOString(), lastSuccessfulAt: status === "submitted" ? now.toISOString() : previous?.lastSuccessfulAt || null,
          lastStatus: status, lastJobId: submitted.id, lastError: status === "failed" ? cleanForSource(job.error, source, 500) : null };
        nextSources[key] = status === "failed"
          ? failedSourceReceipt(previous, observed, job.error || "来源导入任务失败", source,
            { now, retryDelay: failureRetryDelay })
          : status === "submitted" ? successfulSourceReceipt(observed) : observed;
        results.push({ ...nextSources[key], status, jobId: submitted.id, jobStatus: job.status });
      } catch (error) {
        if (nextSources[key]?.lastStatus === "pending" && nextSources[key]?.lastJobId) {
          const pending = { ...nextSources[key], lastJobCheckedAt: new Date().toISOString(), lastError: cleanForSource(error?.message ?? error, source, 500) };
          nextSources[key] = pending;
          results.push({ ...pending, status: "pending" });
          continue;
        }
        const failure = failedSourceReceipt(previous, {
          ...previous,
          key,
          readContract: sourceReadContract(source),
          sourceUrl: clean(source.sourceUrl, 1_000),
          sourceTitle: clean(source.sourceTitle || source.title, 200),
          monitorOnly: source.monitorOnly === true,
          readMode: source.sourceType === 'lark-work-source' ? 'whole-workbook-facts' : source.monitorOnly === true ? "workbook-metadata" : previous?.readMode || "author-table",
          kind: clean(source.kind, 80), readPolicy: clean(source.readPolicy, 80),
          sourceRevision: sourceRevision(previous) || sourceRevision(source),
          sourceSheetId: clean(previous?.sourceSheetId || source.sheetId, 120),
          sheetName: clean(previous?.sheetName || source.sheetName, 120),
          defaultBoard: clean(previous?.defaultBoard || source.defaultBoard, 120),
          lastCheckedAt: now.toISOString(),
        }, error?.message ?? error, source, { now, retryDelay: failureRetryDelay });
        nextSources[key] = failure;
        results.push({ ...failure, status: "failed" });
      }
    }
    const completedAt = now.toISOString();
    const partial = resumePendingOnly || uncheckedOnly || retryFailedOnly || workLinksOnly;
    // Incremental/failed recovery must never promote a generic legacy
    // `updatedAt` into proof that a complete daily scan occurred.
    const previousFullFinishedAt = Object.hasOwn(manifest, "lastFinishedAt") ? manifest.lastFinishedAt : null;
    const next = { ...manifest, version: 2, updatedAt: completedAt,
      lastFinishedAt: partial ? previousFullFinishedAt : completedAt,
      lastFullBusinessDate: partial ? manifest.lastFullBusinessDate || null : sourcePollBusinessDate(now),
      ...(uncheckedOnly ? { lastIncrementalFinishedAt: completedAt } : {}),
      ...(retryFailedOnly ? { lastFailedRetryAt: completedAt } : {}),
      ...(workLinksOnly ? {lastWorkLinksCheckedAt:completedAt}:{}),
      ...(pendingPolled ? { lastPendingCheckedAt: completedAt } : {}), intervalMs, sources: nextSources };
    await writeManifest(next);
    const failedCount = results.filter((item) => item.status === "failed").length;
    const blockedCount = results.filter((item) => item.status === "blocked").length;
    const pendingCount = Object.values(nextSources).filter((item) => item.lastStatus === "pending").length;
    const businessPendingCount = Object.values(nextSources).filter((item) => projectSourceJobSummary(item.sourceJobSummary)?.businessStatus === "pending").length;
    const processedSourceCount = results.filter((item) => item.status === "submitted").length;
    const workLinkIncompleteCount=Object.values(nextSources).filter(s=>s.workLinkResolution?.unresolved>0
      ||s.workLinkResolution&&s.workLinkResolution.status!=='completed').length;
    return { status: failedCount || blockedCount || pendingCount || businessPendingCount || workLinkIncompleteCount ? "warning" : "ok",
      mode: uncheckedOnly ? "unchecked" : resumePendingOnly ? "pending" : retryFailedOnly ? "failed" : workLinksOnly?'work-links':"full",
      uncheckedRemainingCount: new Set(registry.filter((source) => clean(source?.sourceUrl) && sourceNeedsInitialCheck(source, nextSources[sourceKey(source)])).map(sourceKey)).size,
      changed: results.filter((item) => ["submitted", "changed"].includes(item.status)).length,
      processedSourceCount,
      importedSourceCount: processedSourceCount,
      importedSourceCountDeprecated: true,
      processedSourceCountMeaning: "completed-import-jobs-not-all-authors-onboarded",
      businessPendingCount, businessPendingCountUnit: "sources-with-pending-business-outcome-not-authors",
      workLinkIncompleteCount,workLinkIncompleteCountUnit:'sources-with-unresolved-work-references-not-sampling-coverage',
      businessSummaryMissingCount: Object.values(nextSources).filter((item) => item.lastJobId && !projectSourceJobSummary(item.sourceJobSummary)).length,
      checkedCount: results.length, successfulCount: results.filter((item) => ["unchanged", "submitted", "changed"].includes(item.status)).length,
      failedCount, blockedCount, pendingCount, sources: results };
  } finally {
    await releaseSourcePollLock(acquired);
  }
}

async function main() {
  const loop = process.argv.includes("--loop");
  const uncheckedOnly = process.argv.includes("--unchecked-only");
  const sizeArgument = process.argv.indexOf("--max-sources");
  const maxSources = sizeArgument >= 0 ? Number(process.argv[sizeArgument + 1]) : DEFAULT_UNCHECKED_BATCH_SIZE;
  do {
    try {
      // Read only local receipts/catalog at most once per minute while idle.
      // Newly registered sources are checked without resetting the older
      // sources' full-check deadline. A due full cycle always takes priority.
      const plan = sourcePollLoopPlan(await readManifest(), { registry: await readRegistry(), interval: intervalMs, retryDelay: retryDelayMs });
      if (loop && plan.mode === "idle") {
        await new Promise((resolve) => setTimeout(resolve, plan.nextDelayMs));
        continue;
      }
      const result = await pollOnce({ resumePendingOnly: loop && plan.resumePendingOnly,
        uncheckedOnly: loop ? plan.uncheckedOnly : uncheckedOnly,
        retryFailedOnly: loop && plan.retryFailedOnly,
        retrySourceKeys: plan.failedKeys,
        workLinksOnly:loop&&plan.workLinksOnly,workLinkSourceKeys:plan.workLinkKeys,
        maxSources });
      console.log(`[${new Date().toISOString()}] 来源轮询：${JSON.stringify(result)}`);
      // A launchd RunAtLoad race is normal: if the workbench has not bound
      // port 4188 yet, retry soon rather than sleeping for the full daily cycle.
      if (loop && result.status === "skipped") await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    } catch (error) {
      console.error(`[${new Date().toISOString()}] 来源轮询失败：${clean(error?.message ?? error, 500)}`);
      if (loop) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    if (!loop) break;
  } while (!process.exitCode);
}

if (isMainModule()) main().catch((error) => { console.error(error); process.exitCode = 1; });

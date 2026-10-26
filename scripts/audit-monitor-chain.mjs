#!/usr/bin/env node

/**
 * Cross-check the original Jixuan monitor against this command center without
 * opening either web UI. It reads launchd/JSON evidence and the local audit API.
 * No credentials, browser session, or external monitoring service is used.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { schedulerScheduleHealthy } from "../lib/runtime-audit.mjs";

const DEFAULTS = {
  jixuanRoot: process.env.JIXUAN_SKILL_HUB_ROOT || "/Users/tyke/skill-hub",
  plistPath: process.env.JIXUAN_MONITOR_PLIST || "/Users/tyke/Library/LaunchAgents/com.slowly.douyin-monitor.plist",
  launchdLabel: process.env.JIXUAN_MONITOR_LABEL || "com.slowly.douyin-monitor",
  commandCenterUrl: process.env.COMMAND_CENTER_URL || "http://127.0.0.1:4188",
};

export function parseLaunchdPrint(text = "") {
  const find = (pattern) => text.match(pattern)?.[1] ?? null;
  const numberOrNull = (value) => value === null ? null : Number(value);
  const exitCode = find(/last exit code\s*=\s*(-?\d+)/);
  return {
    available: Boolean(text.trim()),
    state: find(/\bstate\s*=\s*([^\n]+)/)?.trim() || null,
    runs: Number(find(/\bruns\s*=\s*(\d+)/)) || 0,
    lastExitCode: exitCode === null ? null : Number(exitCode),
    scheduleHour: numberOrNull(find(/"Hour"\s*=>\s*(\d+)/)),
    scheduleMinute: numberOrNull(find(/"Minute"\s*=>\s*(\d+)/)),
  };
}

export function latestFreshness(generated, scheduleHour, scheduleMinute, now = new Date()) {
  if (!generated) return { fresh: false, reason: "缺少最近快照时间" };
  const captured = new Date(String(generated).replace(" ", "T"));
  if (Number.isNaN(captured.getTime())) return { fresh: false, reason: "快照时间无法解析" };
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const capturedKey = `${captured.getFullYear()}-${String(captured.getMonth() + 1).padStart(2, "0")}-${String(captured.getDate()).padStart(2, "0")}`;
  if (capturedKey === todayKey) return { fresh: true, reason: "今日已生成快照" };
  const dueToday = new Date(now);
  dueToday.setHours(Number(scheduleHour ?? 10), Number(scheduleMinute ?? 0), 0, 0);
  if (now < dueToday && capturedKey !== todayKey) return { fresh: true, reason: "今日计划时点尚未到" };
  return { fresh: false, reason: `计划时点已过，最近快照为 ${capturedKey}` };
}

function parseLatest(latest, historyCount, logText = "", scheduleHour = 10, scheduleMinute = 0) {
  if (!latest || typeof latest !== "object") {
    return { available: false, historyCount, lastLogRun: null, freshness: { fresh: false, reason: "缺少最新快照" } };
  }
  const runLines = String(logText).split(/\r?\n/).filter((line) => /抖音监控 @/.test(line));
  return {
    available: true,
    generated: latest.generated || null,
    targetCount: Number(latest.count) || 0,
    successCount: Number(latest.ok) || 0,
    failureCount: Number(latest.fail) || 0,
    historyCount,
    lastLogRun: runLines.at(-1) || null,
    freshness: latestFreshness(latest.generated, scheduleHour, scheduleMinute),
  };
}

function parsePlist(plistPath) {
  if (!existsSync(plistPath)) return { available: false, path: plistPath };
  try {
    const text = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], { encoding: "utf8" });
    const plist = JSON.parse(text);
    const calendar = plist.StartCalendarInterval || {};
    const numberOrNull = (value) => value === undefined || value === null ? null : Number(value);
    return {
      available: true,
      path: plistPath,
      label: plist.Label || null,
      hour: numberOrNull(calendar.Hour),
      minute: numberOrNull(calendar.Minute),
      runAtLoad: plist.RunAtLoad === true,
      programArguments: Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [],
    };
  } catch (error) {
    return { available: false, path: plistPath, error: error.message };
  }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function readText(path) {
  try { return await readFile(path, "utf8"); } catch { return ""; }
}

async function historyCount(path) {
  try {
    const files = await readdir(path);
    return files.filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).length;
  } catch { return 0; }
}

function inspectLaunchd(label) {
  try {
    return parseLaunchdPrint(execFileSync("/bin/launchctl", ["print", `gui/${process.getuid?.() || 0}/${label}`], { encoding: "utf8" }));
  } catch (error) {
    return { available: false, state: null, runs: 0, lastExitCode: null, error: error.message };
  }
}

async function fetchAudit(baseUrl) {
  try {
    const controller = new AbortController();
    // Deep SQLite/backup verification can legitimately exceed the old 3.5 s
    // probe window while the UI remains healthy. Keep the audit strict, but
    // give the local endpoint enough time to finish its evidence check.
    const timer = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/system-audit`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { available: false, status: response.status };
    return { available: true, ...(await response.json()) };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

export function buildVerdict({ plist, launchd, latest }, commandCenter) {
  const originalHealthy = Boolean(
    plist.available && launchd.available && launchd.lastExitCode === 0 &&
    latest.available && latest.targetCount > 0 && latest.successCount + latest.failureCount === latest.targetCount && latest.freshness?.fresh === true,
  );
  const auditHealthy = Boolean(
    commandCenter?.available && commandCenter.ok === true &&
    commandCenter?.sourceStatus !== "degraded" &&
    schedulerScheduleHealthy(commandCenter.scheduler) &&
    commandCenter.database?.status === "ok" &&
    commandCenter.database?.dataQuality?.status === "ok" &&
    Number(commandCenter.database?.dataQuality?.violationCount || 0) === 0,
  );
  return {
    originalJixuan: originalHealthy,
    commandCenter: auditHealthy,
    noBrowserCollection: commandCenter?.browserCollection === false,
    noRuntimeAI: commandCenter?.runtimeAI === false,
    noPaidApi: commandCenter?.paidAPI === false,
    sourceStatus: commandCenter?.sourceStatus ?? null,
    overall: originalHealthy && auditHealthy,
  };
}

export async function collect(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const dataRoot = `${config.jixuanRoot}/data/douyin_monitor`;
  const [latest, logText, history] = await Promise.all([
    readJson(`${dataRoot}/latest.json`),
    readText(options.logPath || `${process.env.HOME || "/Users/tyke"}/Library/Logs/douyin_monitor.log`),
    historyCount(`${dataRoot}/history`),
  ]);
  const launchd = inspectLaunchd(config.launchdLabel);
  const plist = parsePlist(config.plistPath);
  const original = {
    root: config.jixuanRoot,
    plist,
    launchd,
    latest: parseLatest(latest, history, logText, plist.hour ?? launchd.scheduleHour ?? 10, plist.minute ?? launchd.scheduleMinute ?? 0),
  };
  const commandCenter = await fetchAudit(config.commandCenterUrl);
  return {
    generatedAt: new Date().toISOString(),
    original,
    commandCenter: {
      url: config.commandCenterUrl,
      ok: commandCenter.ok ?? false,
      scheduler: commandCenter.scheduler || null,
      database: commandCenter.database || null,
      sourceProbe: commandCenter.sourceProbe || null,
      runtimeAI: commandCenter.runtimeAI ?? null,
      paidAPI: commandCenter.paidAPI ?? null,
      browserCollection: commandCenter.browserCollection ?? null,
      sourceStatus: commandCenter.sourceStatus ?? null,
      available: commandCenter.available === true,
      error: commandCenter.error || null,
    },
    verdict: buildVerdict(original, commandCenter),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const strict = process.argv.includes("--strict");
  const result = await collect();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (strict && !result.verdict.overall) process.exitCode = 1;
}

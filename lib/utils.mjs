import { createHash } from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function safeJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function asNonNegativeInteger(value, fallback = null) {
  // Platform counters are exact integers. Coercing booleans/blanks or rounding
  // a fraction creates an observation that the source never reported.
  if (typeof value === "string") {
    value = value.trim();
    if (!/^\d+$/.test(value)) return fallback;
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function asIsoDate(value, fallback = null) {
  if (!value) return fallback;
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && /^\d{10,13}$/.test(value)
      ? Number(value)
      : null;
  const candidate = numeric === null ? new Date(value) : new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(candidate.getTime()) ? fallback : candidate.toISOString();
}

export function checksum(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function clampText(value, max = 4000) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function normalizeTag(value) {
  return String(value ?? "").trim().replace(/^#+/, "").replace(/\s+/g, " ");
}

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Product reporting uses Beijing time regardless of the host process timezone.
// Keep this separate from localDateKey(), which is retained for scheduler
// internals and backwards compatibility with existing stored run dates.
export const DEFAULT_BUSINESS_TIME_ZONE = "Asia/Shanghai";

// Formatters depend only on these fixed options and the time zone, never on a
// snapshot or its date. Bound the cache; leave non-string zone coercion uncached.
const businessDateFormatters = new Map();
function businessDateFormatter(timeZone) {
  if (typeof timeZone === "string" && businessDateFormatters.has(timeZone)) {
    return businessDateFormatters.get(timeZone);
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  if (typeof timeZone === "string") {
    if (businessDateFormatters.size >= 32) businessDateFormatters.delete(businessDateFormatters.keys().next().value);
    businessDateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function businessDateKey(value = new Date(), timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  if (value === null || value === undefined || value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = businessDateFormatter(timeZone).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function shiftCalendarDate(value, days) {
  if (!isCalendarDate(value) || !Number.isFinite(Number(days))) return "";
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

// Return the UTC instant at midnight of a business date. Asia/Shanghai has a
// fixed UTC+08:00 offset; the explicit conversion prevents tests or deployments
// running in another host timezone from shifting snapshot boundaries.
export function businessDateStartUtc(value, timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  if (!isCalendarDate(value)) return null;
  const utcMidnight = Date.parse(`${value}T00:00:00Z`);
  const offsetHours = timeZone === DEFAULT_BUSINESS_TIME_ZONE ? 8 : 0;
  return new Date(utcMidnight - offsetHours * 60 * 60 * 1000);
}

export function parseTimeOfDay(value, fallback = "08:30") {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    : fallback;
}

export function nextDailyRun(time, from = new Date()) {
  const [hour, minute] = parseTimeOfDay(time).split(":").map(Number);
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

export function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvTextEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet applications can interpret text cells beginning with these
  // characters as formulas, even after leading control/format/space characters.
  // Prefixing an apostrophe forces a literal text cell. Numeric exports continue
  // to use csvEscape directly and are therefore unchanged.
  const literal = /^[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return csvEscape(literal);
}

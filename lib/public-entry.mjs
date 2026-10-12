import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PUBLIC_ENTRY_FILE = "public-entry.json";

// Configuration is an operator-supplied destination, not proof of DNS,
// reachability, ownership, HTTPS readiness or authentication safety. Keep it
// separate from the short-lived Quick Tunnel heartbeat below.
export function normalizeConfiguredPublicEntry(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const text = value.trim();
  // Parse the raw authority before URL canonicalization: URL would otherwise
  // hide a default :443 port or accept abbreviated/numeric IP spellings.
  const match = /^https:\/\/([a-z0-9.-]+)\/?$/i.exec(text);
  if (!match) return null;
  const hostname = match[1].toLowerCase();
  // Quick Tunnel hostnames expire and must always be backed by a fresh
  // supervisor heartbeat, never promoted into permanent configuration.
  if (hostname === "trycloudflare.com" || hostname.endsWith(".trycloudflare.com")) return null;
  const labels = hostname.split(".");
  if (hostname.length > 253 || labels.length < 2
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^[a-z][a-z0-9-]*[a-z0-9]$/.test(labels.at(-1))) return null;
  const reserved = ["localhost", "local", "localdomain", "internal", "lan", "home", "test", "invalid", "onion", "home.arpa"];
  if (reserved.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) return null;
  try {
    const url = new URL(text);
    if (url.hostname !== hostname || url.protocol !== "https:" || url.port || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) return null;
    return { url: url.origin, status: "configured", source: "configuration",
      verificationStatus: "unverified", verifiedAt: null, updatedAt: null };
  } catch {
    return null;
  }
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return null;
    if (!/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function normalizePublicEntry(value, now = Date.now(), maxAgeMs = 90_000) {
  if (!value || typeof value !== "object" || value.status !== "running") return null;
  const url = safeHttpsUrl(value.url);
  const updatedAt = Date.parse(value.updatedAt || "");
  if (!url || !Number.isFinite(updatedAt) || now - updatedAt > maxAgeMs || updatedAt - now > 30_000) return null;
  return { url, updatedAt: new Date(updatedAt).toISOString(), status: "running" };
}

export function publicEntryPath(dataDir) {
  return join(dataDir, PUBLIC_ENTRY_FILE);
}

export function tunnelLogEvent(line) {
  const url = String(line).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0];
  return { url: url ? safeHttpsUrl(url) : null, connected: /Registered tunnel connection/.test(line) };
}

export function readPublicEntry(dataDir, options = {}) {
  const configured = Object.hasOwn(options, "publicBaseUrl") ? options.publicBaseUrl : process.env.PUBLIC_BASE_URL;
  // Older installers persisted a one-off Quick Tunnel URL in this variable.
  // It is a stale address cache, not a fixed-origin override. Keep using the
  // supervisor's current, short-lived entry rather than resurrecting that URL.
  const legacyTunnelCache = typeof configured === "string"
    && !/[\u0000-\u001f\u007f\\]/.test(configured)
    && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/i.test(configured.trim());
  // Only absent/blank configuration permits the legacy tunnel fallback.
  // An invalid explicit destination must never silently select another host.
  if (!legacyTunnelCache && configured !== undefined && configured !== null && !(typeof configured === "string" && !configured.trim())) {
    return normalizeConfiguredPublicEntry(configured);
  }
  const path = publicEntryPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    return normalizePublicEntry(JSON.parse(readFileSync(path, "utf8")), options.now ?? Date.now(), options.maxAgeMs ?? 90_000);
  } catch {
    return null;
  }
}

export function writePublicEntry(dataDir, value) {
  const path = publicEntryPath(dataDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

#!/usr/bin/env node
// One authorised, read-only navigation using the installed browser defaults.
// No credential refresh, API replay, fingerprint patches, challenge handling or DB writes.
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { collectorOwnershipClient, createOwnedCollectorExecutor } from "../../lib/collector-ownership.mjs";
import { runReadOnlyProbe, validateProbeInput } from "./douyin-profile-render-probe.mjs";

const HERE = fileURLToPath(import.meta.url);
const ERROR_KINDS = ["ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_REFUSED", "ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_DATE_INVALID", "ERR_SSL_PROTOCOL_ERROR", "ERR_ABORTED", "ERR_BLOCKED_BY_CLIENT", "ERR_FAILED"];
export function resourceKind(request) {
  return ["document", "script", "stylesheet", "xhr", "fetch", "image", "font"].includes(request.resourceType()) ? request.resourceType() : "other";
}
export function failureKind(text) {
  return ERROR_KINDS.find(kind => typeof text === "string" && text.includes(kind)) ?? "unclassified";
}
export function projectDocumentStructure() {
  const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none");
  const any = selector => [...document.querySelectorAll(selector)].slice(0, 100).some(visible);
  return {
    readyState: ["loading", "interactive", "complete"].includes(document.readyState) ? document.readyState : "unknown",
    bodyPresent: Boolean(document.body), scriptCount: Math.min(document.scripts.length, 10_000),
    renderDataPresent: Boolean(document.querySelector('script#RENDER_DATA[type="application/json"]')),
    worksRegionPresent: any('[data-e2e="user-post-list"],[data-e2e="user-post-item-list"]'),
    gate: any('[id^="captcha"],[class*="captcha"],iframe[src*="/captcha/"],[data-e2e="verify-dialog"]') ? "challenge"
      : any('[role="dialog"] input[type="tel"],[role="dialog"] input[type="password"],form[action*="/login"] input') ? "authentication-dialog" : "none",
  };
}
export async function runNativeEnvironmentProbe(input, runtime = {}) {
  const counters = { requested: {}, finished: {}, failed: {}, pending: {}, failureKinds: {}, rejectedStatuses: {}, pageErrorCount: 0, domContentLoaded: false, load: false };
  const pending = new Map(); let structure = null;
  const bump = (object, key) => { object[key] = Math.min(10_000, (object[key] ?? 0) + 1); };
  const result = await runReadOnlyProbe(input, {
    // Share the same sequence across hello, launch, register and release.
    ownership: runtime.ownership,
    connect: async (endpoint, options) => {
      const browser = await chromium.connect(endpoint, options);
      return new Proxy(browser, { get(target, key) {
        if (key === "newContext") return async contextOptions => {
          const { userAgent: _legacyOverride, ...nativeOptions } = contextOptions;
          const context = await target.newContext(nativeOptions);
          return new Proxy(context, { get(contextTarget, contextKey) {
            if (contextKey === "newPage") return async () => {
              const page = await contextTarget.newPage();
              page.on("request", request => { const kind = resourceKind(request); pending.set(request, kind); bump(counters.requested, kind); });
              page.on("requestfinished", request => { bump(counters.finished, resourceKind(request)); pending.delete(request); });
              page.on("requestfailed", request => { bump(counters.failed, resourceKind(request)); bump(counters.failureKinds, failureKind(request.failure()?.errorText)); pending.delete(request); });
              page.on("response", response => {
                const status = response.status();
                if (status >= 400 && status <= 599) bump(counters.rejectedStatuses, String(status));
                // Stop on explicit rejection; do not try another identity/configuration.
                if ([401, 403, 429].includes(status)) void page.close().catch(() => {});
              });
              page.on("pageerror", () => { counters.pageErrorCount = Math.min(10_000, counters.pageErrorCount + 1); });
              page.on("domcontentloaded", () => { counters.domContentLoaded = true; });
              page.on("load", () => { counters.load = true; });
              return new Proxy(page, { get(pageTarget, pageKey) {
                if (pageKey === "goto") return async (...args) => {
                  try { return await pageTarget.goto(...args); }
                  finally {
                    if (!pageTarget.isClosed()) {
                      let timer;
                      try { structure = await Promise.race([pageTarget.evaluate(projectDocumentStructure), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1_000); })]); }
                      catch { structure = null; } finally { clearTimeout(timer); }
                    }
                    for (const kind of pending.values()) bump(counters.pending, kind);
                  }
                };
                const value = Reflect.get(pageTarget, pageKey); return typeof value === "function" ? value.bind(pageTarget) : value;
              } });
            };
            const value = Reflect.get(contextTarget, contextKey); return typeof value === "function" ? value.bind(contextTarget) : value;
          } });
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
    },
  });
  return { ...result, environment: "installed-browser-defaults", structure, counters };
}
async function main() {
  let source = "";
  for await (const chunk of process.stdin) { source += chunk; if (source.length > 2_048) throw new Error("invalid input"); }
  const input = validateProbeInput(JSON.parse(source));
  if (process.argv.includes("--child")) {
    const ownership = collectorOwnershipClient();
    await ownership?.send("hello");
    const result = await runNativeEnvironmentProbe(input, { ownership });
    await ownership?.send("complete");
    process.stdout.write(JSON.stringify(result));
    if (process.connected) process.disconnect();
    return;
  }
  const executor = createOwnedCollectorExecutor();
  const result = await new Promise(resolve => {
    const child = executor.exec(process.execPath, [HERE, "--child"], { timeout: 45_000, cleanupTimeoutMs: 3_000, maxBuffer: 32_000 }, (error, stdout) => {
      if (error) return resolve({ ok: false, code: "ownership-or-process-failure", cleanup: executor.state() });
      try { resolve({ ...JSON.parse(stdout), cleanup: executor.state(), cleanupConfirmed: true }); }
      catch { resolve({ ok: false, code: "invalid-probe-output", cleanup: executor.state() }); }
    });
    child?.stdin?.end(JSON.stringify(input));
  });
  process.stdout.write(JSON.stringify(result));
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => {
  process.stdout.write(JSON.stringify({ ok: false, code: "probe-stopped", readOnly: true }));
  if (process.connected) process.disconnect();
  process.exitCode = 1;
});

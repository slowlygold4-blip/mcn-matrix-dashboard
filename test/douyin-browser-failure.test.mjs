import test from "node:test";
import assert from "node:assert/strict";
import { classifyBrowserWorksFailure, safeBrowserCollectorException } from "../lib/douyin-browser-failure.mjs";

test("browser works failure distinguishes 401, 403, 429 and connection failures", () => {
  for (const [status, expected] of [[401, "login_required"], [403, "blocked"], [429, "rate_limited"], [502, "network_error"]]) {
    const result = classifyBrowserWorksFailure({ httpStatuses: [status] });
    assert.equal(result.errorCode, expected);
    if (status !== 502) assert.match(result.error, new RegExp(`HTTP ${status}`));
  }
  assert.equal(classifyBrowserWorksFailure().errorCode, "network_error");
});

test("mixed failures use deterministic precedence and matching status text", () => {
  for (const statuses of [[429, 403, 401], [401, 429, 403]]) {
    assert.equal(classifyBrowserWorksFailure({ httpStatuses: statuses }).errorCode, "login_required");
    assert.match(classifyBrowserWorksFailure({ httpStatuses: statuses }).error, /HTTP 401/);
  }
  const forbidden = classifyBrowserWorksFailure({ httpStatuses: [502, 429, 403] });
  assert.equal(forbidden.errorCode, "blocked");
  assert.match(forbidden.error, /HTTP 403/);
  assert.doesNotMatch(forbidden.error, /HTTP 502/);
});

test("only official login locations are authentication evidence, never query text", () => {
  for (const pageUrl of ["https://www.douyin.com/passport/login", "https://passport.douyin.com/", "https://www.douyin.com/login?next=public"]) {
    assert.equal(classifyBrowserWorksFailure({ pageUrl }).errorCode, "login_required", pageUrl);
  }
  for (const pageUrl of ["https://www.douyin.com/user/passport123?login=1", "https://www.douyin.com/user/id#login", "https://douyin.com.evil.example/login", "https://example.com/passport", "https://secret@www.douyin.com/login", "not a URL"]) {
    assert.equal(classifyBrowserWorksFailure({ pageUrl }).errorCode, "network_error", pageUrl);
  }
  assert.equal(classifyBrowserWorksFailure({ httpStatuses: [403], pageUrl: "https://www.douyin.com/login" }).errorCode, "blocked");
});

test("classification ignores arbitrary bodies, headers, credentials and malformed statuses", () => {
  const secret = "TEST_PRIVATE_COOKIE_SIGNATURE";
  const result = classifyBrowserWorksFailure({
    httpStatuses: [null, {}, `403 ${secret}`, NaN, Infinity],
    pageUrl: `https://www.douyin.com/user/id?signature=${secret}`,
    body: secret, headers: { cookie: secret }, error: new Error(secret),
  });
  assert.equal(result.errorCode, "network_error");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.deepEqual(Object.keys(result).sort(), ["error", "errorCode"]);
});

test("unexpected exceptions are never echoed; only exact local messages survive", () => {
  const safe = "抖音浏览器会话为空；请重新授权";
  assert.deepEqual(safeBrowserCollectorException(new Error(safe)), { errorCode: "login_required", error: safe });
  for (const error of [new Error("page.goto: https://www.douyin.com/?signature=TEST_PRIVATE_SECRET Cookie=TEST_PRIVATE_SECRET"), new Error(`${safe} TEST_PRIVATE_SECRET`), "TEST_PRIVATE_SECRET", null]) {
    const result = safeBrowserCollectorException(error);
    assert.equal(result.errorCode, "collector_error");
    assert.doesNotMatch(JSON.stringify(result), /TEST_PRIVATE_SECRET|page\.goto|signature=/);
  }
});

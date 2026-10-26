import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runReadOnlyProbe, projectRenderEvidence, sanitizeRenderProjection, validateProbeInput } from "../scripts/probes/douyin-profile-render-probe.mjs";
const input = { secUid: "MS4wLjABAAAAReadOnlyProbeFixture12345", uid: "1234567890" };
const profile = `https://www.douyin.com/user/${input.secUid}`;
const privateText = "SECRET_SHOULD_NOT_APPEAR";
function project(data, selectors = {}) {
  const before = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = { querySelector: () => data === null ? null : { textContent: typeof data === "string" ? data : encodeURIComponent(JSON.stringify(data)) },
    querySelectorAll: selector => selectors[selector] ?? [] };
  globalThis.getComputedStyle = () => ({ visibility: "visible", display: "block" });
  try { return projectRenderEvidence(input); }
  finally { globalThis.document = before.document; globalThis.getComputedStyle = before.getComputedStyle; }
}
test("bounded fixed projection identifies old schema without returning IDs, content, metrics or auth state", () => {
  const result = project({ 41: { user: { user: { secUid: input.secUid, uid: input.uid } },
    post: { data: [{ authorInfo: { secUid: input.secUid, uid: input.uid }, desc: privateText }] } } });
  assert.equal(result.schema, "legacy-user-post"); assert.equal(result.profileIdentityMatches, true);
  assert.equal(result.postIdentityMatches, 1);assert.equal(result.postCount, 1);
  for (const forbidden of [privateText, input.uid, input.secUid]) assert.equal(JSON.stringify(result).includes(forbidden), false);
});
test("unknown app structure and empty/malformed render data never invent works", () => {
  assert.equal(project({ app: { user: { uid: input.uid }, post: { data: [] } } }).schema, "app-uninterpreted");
  assert.equal(project(null).postCount, null);assert.equal(project("not-json").renderValid, false);
  assert.equal(project("x".repeat(2_000_001)).schema, "over-limit");
  let nested = {};for (let i = 0; i < 16; i++) nested = { x: nested };
  assert.equal(project(nested).schema, "over-limit");
});
test("projection boundary rejects arbitrary strings/keys and invalid counts", () => {
  const result = sanitizeRenderProjection({ gate: privateText, schema: privateText, postCount: -1, cookie: privateText, profileIdentityMatches: "yes" });
  assert.equal(result.gate, "unknown");assert.equal(result.postCount, null);assert.equal(result.profileIdentityMatches, null);
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.throws(() => validateProbeInput({ secUid: input.secUid, uid: "wrong" }));
});
function runtime(status = 200, options = {}) {
  const calls = [], handle = { pid: 12345, exitCode: null, signalCode: null };
  const destination = options.destination ?? profile;
  const page = new EventEmitter();page.frame = { url: () => destination };page.mainFrame = () => page.frame;page.url = () => destination;
  page.close = async () => { calls.push("page-close"); };
  page.goto = async (url, options) => {
    calls.push({ goto: url, options });
    const request = { frame: () => page.frame, isNavigationRequest: () => true, url: () => destination };
    page.emit("request", request);page.emit("framenavigated", page.frame);
    page.emit("response", { request: () => request, status: () => status });
  };
  page.evaluate = async () => { calls.push("evaluate"); return options.projection ?? project(null); };
  const context = { newPage: async () => page, close: async () => calls.push("context-close") };
  const browser = { newContext: async () => context, close: async () => calls.push("browser-close") };
  const server = { process: () => handle, wsEndpoint: () => privateText,
    close: async () => { calls.push("server-close");if (!options.unconfirmedCleanup) handle.exitCode = 0; },
    kill: async () => { calls.push("server-kill");if (!options.unconfirmedCleanup) handle.signalCode = "SIGKILL"; } };
  return { calls, runtime: { readState: async () => ({ cookies: [{ privateText }] }), launchServer: async () => server,
    connect: async () => browser, ownership: { send: async (...args) => calls.push(args) } } };
}
test("normal single-page fixture closes private resources, no retries or extra requests", async () => {
  const fixture = runtime();const result = await runReadOnlyProbe(input, fixture.runtime);
  assert.equal(result.ok, true);assert.equal(result.documentStatus, 200);
  assert.equal(fixture.calls.filter(x => x?.goto).length, 1);
  assert.equal(fixture.calls.find(x => x?.goto).options.waitUntil, "domcontentloaded");
  assert.deepEqual(fixture.calls.filter(Array.isArray), [["launch"], ["register", 12345], ["released", 12345]]);
  assert.equal(JSON.stringify(result).includes(privateText), false);
});
test("document HTTP denial stops before DOM read and still closes; no alternate attempt", async () => {
  for (const status of [401, 403, 429]) {
    const fixture = runtime(status);const result = await runReadOnlyProbe(input, fixture.runtime);
    assert.equal(result.ok, false);assert.equal(result.code, "http-rejection");
    assert.equal(fixture.calls.includes("evaluate"), false);assert.equal(fixture.calls.filter(x => x?.goto).length, 1);
    assert.ok(fixture.calls.includes("server-close"));
  }
});
test("navigation outside exact original profile stops without document read or retry", async () => {
  for (const destination of ["https://www.douyin.com/login", "https://www.douyin.com/user/OTHER", `${profile}?modal_id=123`]) {
    const fixture = runtime(200, { destination });const result = await runReadOnlyProbe(input, fixture.runtime);
    assert.equal(result.ok, false);assert.equal(result.code, "navigation-changed");
    assert.equal(fixture.calls.includes("evaluate"), false);assert.equal(fixture.calls.filter(x => x?.goto).length, 1);
    assert.ok(fixture.calls.includes("server-close"));
  }
});
test("ordinary login button is not interpreted as a login wall; visible challenge/auth form stops projection", async () => {
  const visible = { getClientRects: () => [1] };
  const ordinary = project(null, { 'button': [visible] });assert.equal(ordinary.gate, "none");
  const challenge = project({ shouldNeverRead: privateText }, { '[id^="captcha"],[class*="captcha"],iframe[src*="/captcha/"],[data-e2e="verify-dialog"]': [visible] });
  assert.equal(challenge.gate, "challenge");assert.equal(challenge.renderPresent, false);
  const auth = project(null, { '[role="dialog"] input[type="tel"],[role="dialog"] input[type="password"],form[action*="/login"] input': [visible] });
  assert.equal(auth.gate, "authentication-dialog");
  const fixture = runtime(200, { projection: challenge });const result = await runReadOnlyProbe(input, fixture.runtime);
  assert.equal(result.ok, false);assert.equal(result.code, "page-gate");assert.ok(fixture.calls.includes("server-close"));
});
test("private process exit not confirmed must reject, never release ownership or report success", async () => {
  const fixture = runtime(200, { unconfirmedCleanup: true });
  await assert.rejects(runReadOnlyProbe(input, fixture.runtime), error => error.code === "cleanup-unconfirmed");
  assert.ok(fixture.calls.includes("server-kill"));
  assert.equal(fixture.calls.some(call => Array.isArray(call) && call[0] === "released"), false);
});
test("ambiguous multiple user-post branches and mismatched identities are observations, never accepted works", () => {
  const branch = { user: { user: { secUid: input.secUid, uid: "9999999" } }, post: { data: [{ authorInfo: { secUid: "wrong", uid: input.uid } }] } };
  const mismatch = project({ 41: branch });assert.equal(mismatch.profileIdentityMatches, false);
  assert.equal(mismatch.postIdentityConflicts, 1);
  const ambiguous = project({ 41: branch, 42: branch });assert.equal(ambiguous.candidateNodes, 2);
  assert.equal(ambiguous.schema, "unknown");assert.equal(ambiguous.postCount, null);
});

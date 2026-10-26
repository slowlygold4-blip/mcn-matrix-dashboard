import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";

const CLOUD_URL = "https://example.feishu.cn/sheets/BoardCatalogHttpTest?sheet=authors";

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function request(instance, path, { method = "GET", cookie, csrf, body } = {}) {
  const response = await fetch(`${instance.origin}${path}`, {
    method,
    headers: {
      Origin: instance.origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

function sessionFrom(result) {
  return {
    cookie: String(result.response.headers.get("set-cookie") ?? "").split(";")[0],
    csrf: result.payload.csrfToken,
  };
}

async function startFixture(t, setup = async () => ({})) {
  const tempDir = await mkdtemp(join(tmpdir(), "douyin-board-ingestion-http-"));
  const dataDir = join(tempDir, "data");
  const fakePython = join(tempDir, "offline-public-provider.mjs");
  const noNetwork = join(tempDir, "deny-network.mjs");
  await writeFile(fakePython, `#!/usr/bin/env node
let source = "";
for await (const chunk of process.stdin) source += chunk;
const payload = JSON.parse(source || "{}");
console.log(JSON.stringify({ ok: true, data: { items: (payload.items || []).map((item) => ({
  key: item.key, candidates: [], errors: [{ error: "隔离测试临时公开读取失败" }]
})) } }));
`);
  await chmod(fakePython, 0o755);
  await writeFile(noNetwork, `import { MonitorDatabase } from ${JSON.stringify(new URL("../lib/database.mjs", import.meta.url).href)};
globalThis.fetch = async () => { throw new Error('External fetch disabled in board ingestion test'); };
const fail = MonitorDatabase.prototype.failAuthorResolutionJob;
MonitorDatabase.prototype.failAuthorResolutionJob = function(id, error, ...rest) {
  console.error(error?.stack || error);
  return fail.call(this, id, error, ...rest);
};
`);
  const extraEnv = await setup(tempDir);
  const port = await freePort();
  let logs = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
      PYTHON_BIN: fakePython,
      DOUYIN_AUTHOR_RESOLVER_MODE: "signed-only",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(noNetwork).href}`.trim(),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  let db;
  t.after(async () => {
    db?.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => child.exitCode === null ? child.once("exit", resolve) : resolve());
    await rm(tempDir, { recursive: true, force: true });
  });
  const instance = { origin: `http://127.0.0.1:${port}`, logs: () => logs, tempDir };
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(`${instance.origin}/api/health`)).ok) break; } catch {}
    if (child.exitCode !== null || attempt === 149) assert.fail(`server did not become ready: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const auth = await request(instance, "/api/auth/session");
  assert.equal(auth.payload.user.role, "admin");
  instance.owner = sessionFrom(auth);
  db = new DatabaseSync(join(dataDir, "douyin-monitor.sqlite"), { readOnly: true });
  instance.db = db;
  return instance;
}

async function joinRole(instance, role) {
  const invite = await request(instance, "/api/access/invites", {
    method: "POST", ...instance.owner, body: { role, hours: 1, maxUses: 1, label: "板块隔离验收" },
  });
  assert.equal(invite.response.status, 201);
  const joined = await request(instance, "/api/auth/join", {
    method: "POST", body: { code: invite.payload.code, displayName: `${role}板块测试员` },
  });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.payload.user.role, role);
  return sessionFrom(joined);
}

async function waitForJob(instance, session, id) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const read = await request(instance, `/api/author-spreadsheet/jobs/${id}`, session);
    assert.equal(read.response.status, 200);
    if (read.payload.status === "completed") return read.payload;
    assert.notEqual(read.payload.status, "failed", `${read.payload.error || ""}\n${JSON.stringify(instance.db.prepare("SELECT error FROM author_resolution_jobs WHERE id=?").get(id))}\n${instance.logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`board import job did not complete: ${instance.logs()}`);
}

test('late import failure rolls back catalog, queue, targets and audit with the job receipt', { timeout: 15000 }, async t => {
  const instance = await startFixture(t, async directory => {
    const preload = join(directory, 'fail-after-author-targets.mjs');
    await writeFile(preload, `import { MonitorDatabase } from ${JSON.stringify(new URL('../lib/database.mjs', import.meta.url).href)};
const original = MonitorDatabase.prototype.importAuthorTargets;
MonitorDatabase.prototype.importAuthorTargets = function(...args) {
  original.apply(this, args);
  throw new Error('injected late import failure');
};
`);
    return { NODE_OPTIONS: `--import=${pathToFileURL(join(directory, 'deny-network.mjs')).href} --import=${pathToFileURL(preload).href}` };
  });
  const count = table => instance.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const before = Object.fromEntries(['board_catalog', 'author_resolution_queue', 'author_resolution_import_sources', 'targets', 'audits']
    .map(table => [table, count(table)]));
  const workbook = new ExcelJS.Workbook();
  const catalog = workbook.addWorksheet('板块配置');
  catalog.addRow(['板块名称']); catalog.addRow(['事务目录']);
  const authors = workbook.addWorksheet('作者名单');
  authors.addRow(['板块', '平台', '作者账号名称', '抖音号', '视频链接']);
  authors.addRow(['事务分类', '抖音', '测试作者', 'atomicfixture123', 'https://www.douyin.com/video/7686424948055891786']);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const submitted = await request(instance, '/api/author-spreadsheet/auto-monitor', {
    method: 'POST', ...instance.owner, body: {
      fileName: 'atomic-fixture.xlsx', sheetName: '作者名单',
      uploadSha256: createHash('sha256').update(buffer).digest('hex'),
      contentBase64: buffer.toString('base64'),
    },
  });
  assert.equal(submitted.response.status, 202, JSON.stringify(submitted.payload));
  let failed;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const read = await request(instance, `/api/author-spreadsheet/jobs/${submitted.payload.id}`, instance.owner);
    if (read.payload.status === 'failed') { failed = read.payload; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(failed, `injected failure did not settle: ${instance.logs()}`);
  assert.match(failed.error, /injected late import failure/);
  for (const [table, expected] of Object.entries(before)) assert.equal(count(table), expected, `${table} must roll back`);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action='authors.auto-monitor.complete'").get().n, 0);
});

test('single authorised import detail requires editor, CSRF, ownership and exact saved row; no monitoring mutation', { timeout: 15000 }, async t => {
  const instance = await startFixture(t, async directory => {
    const preload = join(directory, 'authorised-detail-fixture.mjs');
    await writeFile(preload, `import { PublicWebProvider } from ${JSON.stringify(new URL('../lib/providers/public-web.mjs', import.meta.url).href)};
PublicWebProvider.prototype.resolveAuthorisedDetail = async function(payload) {
  if (this.authorisedDetailEnabled !== true || payload.items.length !== 1) throw new Error('Bad probe configuration');
  const i=payload.items[0],at=new Date().toISOString();
  return {status:'unavailable',key:i.key,videoId:i.videoId,submittedId:i.submittedId,errorCode:'blocked',requestStartedAt:at,requestFinishedAt:at};
};
`);
    return { NODE_OPTIONS: `--import=${pathToFileURL(join(directory, 'deny-network.mjs')).href} --import=${pathToFileURL(preload).href}` };
  });
  const viewer = await joinRole(instance, 'viewer'), other = await joinRole(instance, 'editor');
  const submission = await request(instance, '/api/author-spreadsheet/auto-monitor', {
    method: 'POST', ...instance.owner, body: { fileName: '单项证据测试.xlsx', rows: [
      { sourceRow: 682, platform: 'douyin', name: '原表作者', douyinId: '80336194274', videoId: '7686424948055891786', status: 'resolvable' },
    ] },
  });
  assert.equal(submission.response.status, 202);
  const job = await waitForJob(instance, instance.owner, submission.payload.id);
  const path = `/api/author-spreadsheet/jobs/${job.id}/authorised-detail`, body = { sourceRow: 682 };
  for (const session of [viewer, other, { cookie: instance.owner.cookie }]) {
    const denied = await request(instance, path, { method: 'POST', ...session, body });
    assert.equal(denied.response.status, 403);
  }
  for (const invalid of [{ sourceRow: '682' }, { sourceRow: 999 }, { ...body, videoId: '7686424948055891787' }]) {
    const denied = await request(instance, path, { method: 'POST', ...instance.owner, body: invalid });
    assert.equal(denied.response.status, 400);
  }
  const before = instance.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(job.id);
  const accepted = await request(instance, path, { method: 'POST', ...instance.owner, body });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.payload));
  assert.equal(accepted.payload.monitoringChanged, false); assert.equal(accepted.payload.sourceRow, 682);
  assert.equal(accepted.payload.result.submittedId, '80336194274'); assert.equal(accepted.payload.result.errorCode, 'blocked');
  assert.deepEqual(instance.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(job.id), before);
  assert.equal(instance.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
  assert.equal(instance.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
  const attempted=instance.db.prepare("SELECT details_json FROM activity_log WHERE resource_id=? AND action='author-resolution.authorised-attempt'").all(job.id);
  assert.equal(attempted.length,1);assert.equal(JSON.parse(attempted[0].details_json).payload.errorCode,'blocked');
  assert.equal(JSON.parse(attempted[0].details_json).payload.startedAt,accepted.payload.result.requestStartedAt);
  const repeat = await request(instance, path, { method: 'POST', ...instance.owner, body });
  assert.equal(repeat.response.status, 429);
});

test('source-bound authorised monitoring commits a real-shaped proof, not a client identity, and preserves original job', {timeout:15000}, async t=>{
  const instance=await startFixture(t,async directory=>{
    const preload=join(directory,'authorised-monitor-fixture.mjs');
    await writeFile(preload,`import {createHash} from 'node:crypto';
import {PublicWebProvider} from ${JSON.stringify(new URL('../lib/providers/public-web.mjs',import.meta.url).href)};
PublicWebProvider.prototype.resolveAuthorisedDetail=async function({items:[input]}){
const at=new Date().toISOString(),secUid='MS4wLjABAAAAAuthorisedDetailFixture0000001',uid='12345678901';
const response={status_code:0,aweme_detail:{aweme_id:input.videoId,author:{sec_uid:secUid,uid,unique_id:input.submittedId}}};
const responseSha256=createHash('sha256').update(JSON.stringify(response)).digest('hex'),responseSha256Scope='public-identity-projection-v1';
return {status:'ok',...input,requestStartedAt:at,requestFinishedAt:at,
candidate:{videoId:input.videoId,secUid,uid,uniqueId:input.submittedId,shortId:'',provenance:'authorised-browser-natural-detail',observedAt:at,responseSha256,responseSha256Scope},
evidence:{version:1,kind:'natural-main-frame-detail-response',origin:'https://www.douyin.com',path:'/aweme/v1/web/aweme/detail/',method:'GET',httpStatus:200,requestedVideoId:input.videoId,observedAt:at,responseSha256,responseSha256Scope,response},
provenance:{mode:'authorised-browser-natural-detail',authorisedSessionUsed:true,authenticated:null,authenticationStatus:'not-verified',noChallengeBypass:true,runtimeAI:false,paidAPI:false}};
};`);
    return {NODE_OPTIONS:`--import=${pathToFileURL(join(directory,'deny-network.mjs')).href} --import=${pathToFileURL(preload).href}`};
  });
  const submission=await request(instance,'/api/author-spreadsheet/auto-monitor',{method:'POST',...instance.owner,
    body:{fileName:'原始表.xlsx',sheetName:'原表',rows:[{sourceRow:682,platform:'douyin',name:'原表作者',douyinId:'80336194274',videoId:'7686424948055891786',status:'resolvable',board:'一条小团团切片矩阵'}]}});
  assert.equal(submission.response.status,202);
  const job=await waitForJob(instance,instance.owner,submission.payload.id);
  const path=`/api/author-spreadsheet/jobs/${job.id}/authorised-monitor`;
  const before=instance.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(job.id);
  assert.equal((await request(instance,path,{method:'POST',cookie:instance.owner.cookie,body:{sourceRow:682}})).response.status,403);
  const result=await request(instance,path,{method:'POST',...instance.owner,body:{sourceRow:682}});
  assert.equal(result.response.status,200,JSON.stringify(result.payload));assert.equal(result.payload.monitoringChanged,true);
  assert.equal(result.payload.admission.created,true);assert.equal(result.payload.admission.target.enabled,true);
  assert.equal(instance.db.prepare('SELECT count(*) n FROM snapshots').get().n,0,'Identity proof must not create a metric sample');
  assert.equal(instance.db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n,1);
  const receipt=JSON.parse(instance.db.prepare('SELECT payload_json FROM author_resolution_success_receipts').get().payload_json);
  assert.equal(receipt.resolution.authorisedDetailReceipt.source.jobId,job.id);
  assert.equal(receipt.resolution.authorisedDetailReceipt.source.sourceRow,682);
  assert.equal(receipt.resolution.verificationPolicy,'all-submitted-evidence-v2');
  assert.deepEqual(instance.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(job.id),before);
  assert.equal(instance.db.prepare('SELECT board_name FROM target_boards').get().board_name,'一条小团团切片矩阵');
});

test("board HTTP writes require editor and CSRF; empty catalogs and strict assignments are idempotent and atomic", { timeout: 15_000 }, async (t) => {
  const instance = await startFixture(t);
  const viewer = await joinRole(instance, "viewer");
  const editor = await joinRole(instance, "editor");
  for (const path of ["/api/boards", "/api/boards/assign"]) {
    const body = { name: "不得写入", targetIds: [1] };
    const noCsrf = await request(instance, path, { method: "POST", cookie: editor.cookie, body });
    assert.equal(noCsrf.response.status, 403);
    assert.equal(noCsrf.payload.code, "csrf_failed");
    const readOnly = await request(instance, path, { method: "POST", ...viewer, body });
    assert.equal(readOnly.response.status, 403);
    assert.equal(readOnly.payload.code, "insufficient_role");
  }
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM board_catalog").get().n, 0);
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const created = await request(instance, "/api/boards", { method: "POST", ...editor, body: { name: "暂无作者板块" } });
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.board.name, "暂无作者板块");
    assert.equal(created.payload.board.targetCount, 0);
    assert.equal(created.payload.boards.length, 1);
  }
  const visibleEmpty = await request(instance, "/api/targets?board=" + encodeURIComponent("暂无作者板块"), viewer);
  assert.equal(visibleEmpty.payload.boards[0].name, "暂无作者板块");
  assert.deepEqual(visibleEmpty.payload.targets, []);
  const ids = [];
  for (const [type, enabled] of [["account", true], ["account", false], ["hashtag", true]]) {
    const created = await request(instance, "/api/targets", {
      method: "POST", ...editor, body: { type, enabled, label: `${type}-${ids.length}`, locator: `isolated-${ids.length}`, provider: "manual" },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    ids.push(created.payload.id);
  }
  const beforeTargets = instance.db.prepare("SELECT * FROM targets ORDER BY id").all();
  for (const [targetIds, reason] of [
    [[ids[0], 999_999], /不存在/],
    [[ids[0], String(ids[1])], /正整数/],
    [[ids[0], ids[1] + 0.5], /正整数/],
    [[], /至少选择/],
  ]) {
    const invalid = await request(instance, "/api/boards/assign", { method: "POST", ...editor, body: { name: "无部分写入板块", targetIds } });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.payload.error, reason);
    assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM target_boards").get().n, 0);
    assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM board_catalog WHERE board_name=?").get("无部分写入板块").n, 0);
  }
  const topicAssign = await request(instance, "/api/boards/assign", { method: "POST", ...editor, body: { name: "已确认话题板块", targetIds: [ids[2]] } });
  assert.equal(topicAssign.response.status, 200);
  assert.equal(topicAssign.payload.added, 1);
  assert.equal(instance.db.prepare("SELECT board_name FROM target_boards WHERE target_id=?").get(ids[2]).board_name, "已确认话题板块");
  const assign = (note) => request(instance, "/api/boards/assign", {
    method: "POST", ...editor, body: { name: "已确认作者板块", targetIds: [ids[0], ids[1], ids[0]], note },
  });
  const first = await assign("原始归属依据");
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.added, 2);
  assert.equal(first.payload.uniqueTargetCount, 2);
  assert.equal(first.payload.board.targetCount, 1, "暂停作者不应计入启用数");
  const beforeMemberships = instance.db.prepare("SELECT * FROM target_boards ORDER BY target_id").all();
  const repeated = await assign("不应覆盖第一次来源");
  assert.equal(repeated.payload.added, 0);
  assert.equal(repeated.payload.existing, 2);
  assert.deepEqual(instance.db.prepare("SELECT * FROM target_boards ORDER BY target_id").all(), beforeMemberships);
  assert.deepEqual(instance.db.prepare("SELECT * FROM targets ORDER BY id").all(), beforeTargets, "归类不能改变采集、启用状态或作者原始资料");
});

test("file import persists default and explicit boards in job and queue, including independent empty catalog entries", { timeout: 15_000 }, async (t) => {
  const instance = await startFixture(t);
  const rows = Array.from({ length: 37 }, (_, index) => ({
    sourceRow: index + 2,
    name: `队列作者${index + 1}`,
    platform: "douyin",
    douyinId: `board-fixture-${index + 1}`,
    videoId: String(7_670_000_000_000_000_000n + BigInt(index)),
    status: "resolvable",
    ...(index === 0 ? { board: "显式单板块" } : index === 1 ? { boards: [{ name: "显式多板块甲" }, { name: "显式多板块乙" }] } : {}),
  }));
  rows.push({ sourceRow: 39, name: "缺证据作者", status: "needs_locator", board: "明确审查板块" });
  rows.push({
    sourceRow: 40, name: "冲突作者", status: "identity_conflict", identityConflict: "不同作者身份冲突",
    locator: "MS4wLjABAAAAblockedConflictMustNotImport1234567890",
  });
  const submitted = await request(instance, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", ...instance.owner, body: {
      fileName: "板块隔离名单.xlsx", sheetName: "作者名单", rows,
      defaultBoard: "本次默认板块", boardCatalog: [{ name: "目录中的空板块" }],
    },
  });
  assert.equal(submitted.response.status, 202, JSON.stringify(submitted.payload));
  const job = await waitForJob(instance, instance.owner, submitted.payload.id);
  assert.equal(job.result.createdCount, 0);
  assert.equal(job.result.queuedAuthors, 37);
  assert.equal(job.result.queuedAuthorsDeprecated, true);
  assert.equal(job.result.queuedEvidenceRequestCount, 37);
  assert.equal(job.result.queuedAccountIdentitySummary.distinctAccountCount, 37);
  assert.equal(job.result.resolution.deferredEvidenceRequestCount, 37);
  assert.equal(job.result.resolution.fetchFailedEvidenceRequestCount, 0);
  assert.equal(job.result.resolution.fetchFailedAuthors, 0);
  assert.equal(job.result.resolution.evidenceErrors, 0);
  assert.equal(job.result.resolution.failedAuthors, 0);
  assert.equal(job.totalWorkItemCount, job.totalAuthors);
  assert.equal(job.totalAuthorsDeprecated, true);
  assert.equal(job.inputAccountIdentitySummary.unknownIdentityItemCount, 2);
  assert.equal(job.inputAccountIdentitySummary.distinctAccountCount, null);
  assert.equal(job.result.resultScope, "job-completion-history-not-live-resolution-queue");
  assert.equal(job.result.needsLocatorReviewCount, 1);
  assert.equal(job.result.identityConflictCount, 1);
  const monitoringPath = `/api/author-spreadsheet/jobs/${job.id}/monitoring`;
  const beforeMonitoring = instance.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(job.id);
  const currentMonitoring = await request(instance, monitoringPath, instance.owner);
  assert.equal(currentMonitoring.response.status, 200);
  assert.equal(currentMonitoring.payload.counts.submittedIdentities, 37);
  assert.equal(currentMonitoring.payload.counts.unknown, 37, 'no installed source projection must not pretend all authors are pending or monitored');
  assert.equal(currentMonitoring.payload.identitySummary.unknownIdentityItemCount, 2);
  assert.equal(currentMonitoring.payload.items.length, 20);
  assert.deepEqual(instance.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(job.id), beforeMonitoring);
  const currentViewer = await joinRole(instance, 'viewer');
  const otherEditor = await joinRole(instance, 'editor');
  assert.equal((await request(instance, monitoringPath, currentViewer)).response.status, 403);
  assert.equal((await request(instance, monitoringPath, otherEditor)).response.status, 403);
  assert.equal((await request(instance, monitoringPath + '?limit=101', instance.owner)).response.status, 400);
  assert.equal((await request(instance, monitoringPath + '?status=invalid', instance.owner)).response.status, 400);
  assert.equal((await request(instance, '/api/author-spreadsheet/jobs/00000000-0000-4000-8000-000000000000/monitoring', instance.owner)).response.status, 404);
  const stored = JSON.parse(instance.db.prepare("SELECT request_json FROM author_resolution_jobs WHERE id=?").get(job.id).request_json);
  assert.equal(stored.defaultBoard, "本次默认板块");
  assert.equal(stored.rows[0].board, "显式单板块");
  assert.deepEqual(stored.rows[1].boards.map((board) => board.name), ["显式多板块甲", "显式多板块乙"]);
  assert.equal(stored.rows[2].board, "本次默认板块");
  assert.equal(stored.rows[37].board, "明确审查板块");
  assert.equal(stored.rows[38].board, "本次默认板块");
  const queue = instance.db.prepare("SELECT douyin_id,boards_json FROM author_resolution_queue ORDER BY id").all();
  assert.equal(queue.length, 37);
  const byAccount = new Map(queue.map((row) => [row.douyin_id, JSON.parse(row.boards_json).map((board) => board.name)]));
  assert.deepEqual(byAccount.get("board-fixture-1"), ["显式单板块"]);
  assert.deepEqual(byAccount.get("board-fixture-2"), ["显式多板块甲", "显式多板块乙"]);
  for (let number = 3; number <= 37; number += 1) assert.deepEqual(byAccount.get(`board-fixture-${number}`), ["本次默认板块"]);
  const catalog = (await request(instance, "/api/targets", instance.owner)).payload.boards;
  assert.equal(catalog.find((board) => board.name === "目录中的空板块")?.targetCount, 0);
  assert.equal(catalog.find((board) => board.name === "目录中的空板块")?.queuedCount, 0);
  assert.equal(catalog.find((board) => board.name === "本次默认板块")?.pendingCount, 35);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM targets").get().n, 0);
});

test("HTTP import projects an isolated strict-reuse contract without losing duplicate source rows or inventing author samples", { timeout: 15_000 }, async (t) => {
  const instance = await startFixture(t, async (directory) => {
    const preload = join(directory, "queue-outcome-contract.mjs");
    await writeFile(preload, `import { MonitorDatabase } from ${JSON.stringify(new URL("../lib/database.mjs", import.meta.url).href)};
// This fixture tests the server's queue-result contract. Actual strict proof
// validation and writes are covered separately in database reuse tests.
let importCalls = 0;
MonitorDatabase.prototype.enqueueAuthorResolutions = function(items) {
  const keys = [...new Set(items.map(item => item.key))];
  const repeated = ++importCalls > 1;
  return { total: 8000, pending: 7998, evidenceReusedKeys: repeated ? [] : keys.slice(0, 2),
    verifiedExistingEvidenceRequestKeys: repeated ? keys.slice(0, 2) : [],
    resolvedEvidenceRequestKeys: keys.slice(0, 3), pendingEvidenceRequestKeys: keys.slice(3),
    evidenceReusedCount: 2, pendingEvidenceRequestCount: keys.length - 3,
    alreadyResolvedEvidenceRequestCount: 1, leaseDeferredEvidenceRequestCount: 0 };
};
`);
    return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(directory, "deny-network.mjs")).href} --import=${pathToFileURL(preload).href}`.trim() };
  });
  const locator = "MS4wLjABAAAAreuseContractNoDisplayName1234567890";
  const rows = Array.from({ length: 37 }, (_, index) => ({ sourceRow: index + 2, name: "", platform: "douyin", locator,
    videoId: String(7_679_000_000_000_000_000n + BigInt(index)), status: "resolvable" }));
  rows.splice(1, 0, { ...rows[0], sourceRow: 50, board: "第二来源板块" });
  const submitted = await request(instance, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", ...instance.owner, body: { fileName: "复用回执合同.xlsx", rows },
  });
  assert.equal(submitted.response.status, 202);
  const job = await waitForJob(instance, instance.owner, submitted.payload.id);
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.result.submittedEvidenceRequestCount, 37);
  assert.equal(job.result.queuedEvidenceRequestCount, 34);
  assert.equal(job.result.queuedAccountIdentitySummary.distinctAccountCount, 1);
  assert.equal(job.result.evidenceReusedEvidenceRequestCount, 2);
  assert.equal(job.result.evidenceReusedRowCount, 3, "two proof keys can cover three source rows");
  assert.equal(job.result.alreadyResolvedEvidenceRequestCount, 1);
  assert.equal(job.result.reviewRequiredCount, 35, "only strict reused rows leave review; weak existing success is not promoted");
  assert.equal(job.result.createdCount, 0);
  const allSkipped = await request(instance, `/api/author-spreadsheet/jobs/${job.id}/skipped?offset=0&limit=100`, instance.owner);
  assert.equal(allSkipped.response.status, 200);
  const skipped = allSkipped.payload.items;
  assert.equal(skipped.length, 38);
  const reused = skipped.filter(item => item.status === "evidence_reused");
  assert.equal(reused.length, 3);
  assert.deepEqual(reused.map(item => item.sourceRow), [2, 50, 3]);
  assert.ok(reused.every(item => item.evidenceRequestKeys.length === 1 && /未新采集/.test(item.reason)));
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM targets").get().n, 0);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM snapshots").get().n, 0);
  const repeatedSubmission = await request(instance, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", ...instance.owner, body: { fileName: "复用回执合同.xlsx", rows },
  });
  assert.equal(repeatedSubmission.response.status, 202);
  assert.notEqual(repeatedSubmission.payload.id, job.id);
  const repeated = await waitForJob(instance, instance.owner, repeatedSubmission.payload.id);
  assert.equal(repeated.result.evidenceReusedEvidenceRequestCount, 0);
  assert.equal(repeated.result.evidenceReusedRowCount, 0);
  assert.equal(repeated.result.verifiedExistingEvidenceRequestCount, 2);
  assert.equal(repeated.result.evidenceVerifiedExistingRowCount, 3);
  assert.equal(repeated.result.reviewRequiredCount, job.result.reviewRequiredCount);
  assert.equal(repeated.result.queuedEvidenceRequestCount, job.result.queuedEvidenceRequestCount);
  assert.equal(repeated.result.createdCount, 0);
  assert.ok(repeated.result.skipped.filter(item => item.status === "evidence_reused")
    .every(item => item.historicalEvidenceOutcome === "verified-existing" && /原核验时间保留/.test(item.reason)));
  const unchangedFirst = await request(instance, `/api/author-spreadsheet/jobs/${job.id}`, instance.owner);
  assert.deepEqual(unchangedFirst.payload.result, job.result, "repeat import must not rewrite the first completed job receipt");
});

test("cloud board catalog is re-read, included in content hash and cannot be replaced by client-supplied catalog or rows", { timeout: 15_000 }, async (t) => {
  let workbookPath;
  async function writeCloudWorkbook(extraBoard) {
    const workbook = new ExcelJS.Workbook();
    const config = workbook.addWorksheet("板块配置");
    config.addRow(["板块名称"]);
    config.addRow(["老飞宇切片矩阵"]);
    config.addRow([extraBoard]);
    const authors = workbook.addWorksheet("作者名单");
    authors.addRow(["", "平台", "作者账号名称", "抖音号"]);
    authors.addRow(["老飞宇切片矩阵", "抖音", "云端原作者", "cloud-original-account"]);
    await workbook.xlsx.writeFile(workbookPath);
  }
  const instance = await startFixture(t, async (tempDir) => {
    workbookPath = join(tempDir, "source.xlsx");
    await writeCloudWorkbook("预览时空板块");
    const fakeCli = join(tempDir, "lark-cli.mjs");
    await writeFile(fakeCli, `#!/usr/bin/env node
import { copyFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
const args = process.argv.slice(2);
if (args[0] !== "sheets") process.exit(2);
if (args[1] === "+workbook-info") {
  console.log(JSON.stringify({ ok: true, identity: "user", data: { title: "云板块隔离源", revision: 71, sheets: [
    { sheet_id: "config", sheet_name: "板块配置", row_count: 3, column_count: 1, is_hidden: false },
    { sheet_id: "authors", sheet_name: "作者名单", row_count: 2, column_count: 4, is_hidden: false }
  ] } }));
} else if (args[1] === "+workbook-export") {
  const destination = resolve(process.cwd(), args[args.indexOf("--output-path") + 1]);
  copyFileSync(process.env.BOARD_CLOUD_FIXTURE, destination);
  console.log(JSON.stringify({ ok: true, identity: "user", data: { file_name: "云板块隔离源", file_size: statSync(destination).size } }));
} else process.exit(3);
`);
    await chmod(fakeCli, 0o755);
    return { LARK_CLI_BIN: fakeCli, BOARD_CLOUD_FIXTURE: workbookPath };
  });
  const preview = async () => {
    const result = await request(instance, "/api/author-spreadsheet/lark-preview", { method: "POST", ...instance.owner, body: { url: CLOUD_URL } });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    return result.payload;
  };
  const submit = (source) => request(instance, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", ...instance.owner, body: {
      sourceType: "lark-sheet", sourceUrl: CLOUD_URL, sourceRevision: source.source.revision,
      sourceSha256: source.source.contentSha256, sheetName: source.selectedSheet,
      boardCatalog: [{ name: "客户端注入目录" }], defaultBoard: "不得覆盖云端显式归属",
      rows: [{ sourceRow: 2, name: "客户端注入作者", board: "客户端注入归属", status: "needs_locator" }],
    },
  });
  const first = await preview();
  assert.deepEqual(first.boardCatalog, [{ name: "老飞宇切片矩阵" }, { name: "预览时空板块" }]);
  assert.equal(first.rows[0].board, "老飞宇切片矩阵");
  await writeCloudWorkbook("更新后的空板块");
  const stale = await submit(first);
  assert.equal(stale.response.status, 409, "仅目录变化且 revision 未变也必须阻止旧预览提交");
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM board_catalog").get().n, 0);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM author_resolution_jobs").get().n, 0);
  const current = await preview();
  assert.notEqual(current.source.contentSha256, first.source.contentSha256);
  const accepted = await submit(current);
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.payload));
  await waitForJob(instance, instance.owner, accepted.payload.id);
  const stored = JSON.parse(instance.db.prepare("SELECT request_json FROM author_resolution_jobs WHERE id=?").get(accepted.payload.id).request_json);
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].name, "云端原作者");
  assert.equal(stored.rows[0].board, "老飞宇切片矩阵");
  assert.deepEqual(stored.boardCatalog, [{ name: "老飞宇切片矩阵" }, { name: "更新后的空板块" }]);
  assert.deepEqual(instance.db.prepare("SELECT board_name FROM board_catalog ORDER BY board_name").all().map((row) => row.board_name).sort(), ["老飞宇切片矩阵", "更新后的空板块"].sort());
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM targets").get().n, 0);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM author_resolution_queue").get().n, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sourcePollKey, inspectSourcePollManifest } from '../lib/source-poller-status.mjs';

// Independent boundary review. Only cloud/HTTP boundaries and temporary JSON
// files are substituted. The real poller, loop plan and status projector run.
const stamp = '2026-09-27T20:00:00.000Z';
const sheet = (name, extra = {}) => ({ sourceUrl: `https://fixture.feishu.cn/sheets/${name}`,
  sourceType: 'lark-sheet', sourceTitle: name, defaultBoard: '团团', ...extra });
const metadata = source => ({ revision: 7, title: source.sourceTitle, sheetCount: 1, readMode: 'workbook-metadata' });
function respond(res, code, data) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }
async function fixture(t, registry = []) {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-incremental-review-'));
  const folder = join(dir, 'source-poll'); await mkdir(folder);
  const manifestPath = join(folder, 'manifest.json'), registryPath = join(folder, 'registry.json');
  const calls = { preview: [], posts: [], gets: [] };
  let jobReply = { status: 'completed' }, jobCode = 200, revision = 8;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    if (req.url === '/api/author-spreadsheet/lark-preview') {
      calls.preview.push(body);
      return respond(res, 200, { source: { url: body.url, title: 'fixture', revision,
        contentSha256: 'a'.repeat(64), exportSha256: 'b'.repeat(64), readAt: stamp } });
    }
    if (req.url === '/api/author-spreadsheet/auto-monitor') {
      calls.posts.push(body); return respond(res, 202, { id: `fixture-${calls.posts.length}` });
    }
    if (req.url?.startsWith('/api/author-spreadsheet/jobs/')) {
      calls.gets.push(req.url); return respond(res, jobCode, jobReply);
    }
    return respond(res, 500, { error: 'unexpected network path' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldData = process.env.DATA_DIR, oldBase = process.env.SOURCE_POLL_BASE_URL;
  process.env.DATA_DIR = dir; process.env.SOURCE_POLL_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const subject = await import(`../scripts/source-poller.mjs?independent=${randomUUID()}`);
  if (oldData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldData;
  if (oldBase === undefined) delete process.env.SOURCE_POLL_BASE_URL; else process.env.SOURCE_POLL_BASE_URL = oldBase;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const setRegistry = entries => writeFile(registryPath, JSON.stringify({ sources: entries }));
  await setRegistry(registry);
  await writeFile(manifestPath, JSON.stringify({ version: 2, lastFinishedAt: stamp, updatedAt: stamp, sources: {} }));
  const readManifest = async () => JSON.parse(await readFile(manifestPath, 'utf8'));
  const session = { headers: {}, bootstrap: { authorSources: [] } };
  return { ...subject, calls, session, manifestPath, registryPath, setRegistry, readManifest,
    writeManifest: value => writeFile(manifestPath, JSON.stringify(value)),
    setJob(reply, code = 200) { jobReply = reply; jobCode = code; },
    setRevision(value) { revision = value; },
    inspect: () => inspectSourcePollManifest(manifestPath, { registryPath, now: new Date('2026-09-27T23:00:00Z') }),
    run: options => subject.pollOnce({ session, now: new Date(stamp), ...options }) };
}

test('independent: bounded catalog addition checks only new sources and preserves full daily deadline', async t => {
  const old = sheet('Known', { monitorOnly: true }), a = sheet('NewA', { monitorOnly: true }), b = sheet('NewB', { monitorOnly: true });
  const f = await fixture(t, [old]); const reads = [];
  const reader = async s => { reads.push(s.sourceUrl); return metadata(s); };
  await f.run({ uncheckedOnly: true, monitorMetadataReader: reader });
  await f.setRegistry([old, a, b]);
  const before = await f.readManifest();
  const plan = f.sourcePollLoopPlan(before, { registry: [old, a, b], now: new Date('2026-09-27T21:00:00Z') });
  assert.equal(plan.mode, 'unchecked'); assert.equal(plan.uncheckedCount, 2);
  const first = await f.run({ uncheckedOnly: true, maxSources: 1, monitorMetadataReader: reader });
  assert.equal(first.checkedCount, 1); assert.equal(first.uncheckedRemainingCount, 1);
  const second = await f.run({ uncheckedOnly: true, maxSources: 1, monitorMetadataReader: reader });
  assert.equal(second.checkedCount, 1); assert.equal(second.uncheckedRemainingCount, 0);
  const last = await f.run({ uncheckedOnly: true, maxSources: 1, monitorMetadataReader: reader });
  assert.equal(last.checkedCount, 0);
  assert.deepEqual(reads, [old.sourceUrl, a.sourceUrl, b.sourceUrl]);
  assert.equal((await f.readManifest()).lastFinishedAt, before.lastFinishedAt);
  assert.equal(f.calls.posts.length, 0); assert.equal(f.calls.preview.length, 0);
});

test('independent: metadata success, blocked alias and failed reads remain distinct without import', async t => {
  const sources = [sheet('Metadata', { monitorOnly: true }), sheet('Failure', { monitorOnly: true }),
    { sourceUrl: 'https://fixture.feishu.cn/wiki/Unresolved', sourceType: 'lark-wiki-alias', monitorOnly: true,
      readPolicy: 'unresolved-alias', blockedReason: '需要确认实际原表' }];
  const f = await fixture(t, sources); const reads = [];
  const r = await f.run({ uncheckedOnly: true, monitorMetadataReader: async s => {
    reads.push(s.sourceUrl); if (s.sourceTitle === 'Failure') throw new Error('403: 授权不足'); return metadata(s);
  } });
  assert.equal(r.checkedCount, 3); assert.equal(r.successfulCount, 1); assert.equal(r.failedCount, 1); assert.equal(r.blockedCount, 1);
  assert.equal(r.importedSourceCount, 0); assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.posts.length, 0);
  assert.deepEqual(reads, sources.slice(0, 2).map(s => s.sourceUrl));
  const s = f.inspect(); assert.equal(s.sourceCount, 3); assert.equal(s.successfulTodayCount, 1);
  assert.equal(s.sources.find(v => v.title === 'Metadata').readMode, 'workbook-metadata');
  assert.equal(s.sources.find(v => v.title === 'Failure').lastStatus, 'failed');
  assert.equal(s.sources.find(v => v.readMode === 'unresolved-alias').lastStatus, 'blocked');
});

test('independent: failed new entry cannot starve following catalog entries and receives an isolated retry', async t => {
  const a = sheet('Failed', { monitorOnly: true }), b = sheet('Healthy', { monitorOnly: true });
  const f = await fixture(t, [a, b]); let failedReads = 0;
  const reader = async s => { if (s.sourceTitle === 'Failed') { failedReads++; throw new Error('temporary failure'); } return metadata(s); };
  assert.equal((await f.run({ uncheckedOnly: true, maxSources: 1, monitorMetadataReader: reader })).failedCount, 1);
  assert.equal((await f.run({ uncheckedOnly: true, maxSources: 1, monitorMetadataReader: reader })).successfulCount, 1);
  const plan = f.sourcePollLoopPlan(await f.readManifest(), { registry: [a, b], now: new Date('2026-09-27T21:00:00Z') });
  assert.equal(plan.mode, 'failed'); assert.deepEqual(plan.failedKeys, [sourcePollKey(a)]);
  assert.equal(failedReads, 1); assert.equal(plan.nextDelayMs, 0);
});

test('independent: pending receipt resumes one job GET, survives transport failure and never duplicates POST', async t => {
  const s = sheet('Author'); const f = await fixture(t, [s]); f.setJob({ status: 'running' });
  const first = await f.run({ uncheckedOnly: true });
  assert.equal(first.pendingCount, 1); assert.equal(first.successfulCount, 0);
  assert.equal(f.calls.posts.length, 1); assert.equal(f.calls.gets.length, 1);
  await f.setRegistry([]); f.setJob({ error: 'temporary failure' }, 503);
  const interrupted = await f.run({ resumePendingOnly: true });
  assert.equal(interrupted.pendingCount, 1); assert.equal(f.calls.gets.length, 2);
  f.setJob({ status: 'completed' });
  const complete = await f.run({ resumePendingOnly: true });
  assert.equal(complete.pendingCount, 0); assert.equal(f.calls.gets.length, 3);
  assert.equal(f.calls.posts.length, 1); assert.equal(f.calls.preview.length, 1);
  assert.equal((await f.readManifest()).lastFinishedAt, stamp);
});

test('independent: single-flight lock skips parallel increment without duplicate metadata or POST', async t => {
  const f = await fixture(t, [sheet('Only', { monitorOnly: true })]);
  let entered; const start = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const first = f.run({ uncheckedOnly: true, monitorMetadataReader: async s => { reads++; entered(); await gate; return metadata(s); } });
  await start;
  const second = await f.run({ uncheckedOnly: true, monitorMetadataReader: async () => { throw new Error('duplicate read'); } });
  assert.equal(second.status, 'skipped'); assert.equal(second.reason, 'poll-locked');
  release(); await first; assert.equal(reads, 1); assert.equal(f.calls.posts.length, 0);
});

test('independent: changed identity becomes unchecked rather than inheriting previous table success', async t => {
  const s = sheet('Workbook', { monitorOnly: true, sheetId: 'Tab1' });
  const f = await fixture(t, [s]); await f.run({ uncheckedOnly: true, monitorMetadataReader: async () => metadata(s) });
  const changed = { ...s, sheetId: 'Tab2' }; await f.setRegistry([changed]);
  assert.notEqual(sourcePollKey(s), sourcePollKey(changed));
  const plan = f.sourcePollLoopPlan(await f.readManifest(), { registry: [changed], now: new Date('2026-09-27T21:00:00Z') });
  assert.equal(plan.mode, 'unchecked'); assert.equal(plan.uncheckedCount, 1);
});

test('independent: catalog read-policy change invalidates prior successful observation', async t => {
  const s = sheet('Policy', { monitorOnly: true });
  const f = await fixture(t, [s]); await f.run({ uncheckedOnly: true, monitorMetadataReader: async () => metadata(s) });
  f.setRevision(7);
  const changed = { ...s, monitorOnly: false }; await f.setRegistry([changed]);
  const plan = f.sourcePollLoopPlan(await f.readManifest(), { registry: [changed], now: new Date('2026-09-27T21:00:00Z') });
  assert.equal(plan.mode, 'unchecked', 'new author-import policy has never been checked; metadata receipt is not author evidence');
  assert.equal(f.inspect().successfulTodayCount, 0, 'status must not recast metadata success as a verified author read');
  const next = await f.run({ uncheckedOnly: true });
  assert.equal(next.checkedCount, 1); assert.equal(f.calls.preview.length, 1); assert.equal(f.calls.posts.length, 1);
});

test('independent: removed catalog source stays durable and is explicitly distinguished from current catalog', async t => {
  const s = sheet('Removed', { monitorOnly: true });
  const f = await fixture(t, [s]); await f.run({ uncheckedOnly: true, monitorMetadataReader: async () => metadata(s) });
  await f.setRegistry([]);
  assert.ok((await f.readManifest()).sources[sourcePollKey(s)], 'raw receipt must remain intact');
  const result = f.inspect();
  assert.equal(result.sourceCount, 1, 'catalog omission is not authority to delete a historical source');
  assert.equal(result.registrySourceCount, 0);
  assert.equal(result.manifestOnlyCount, 1);
  assert.match(result.inventoryDefinition, /not implicitly retired/);
  const plan = f.sourcePollLoopPlan(await f.readManifest(), { registry: [], now: new Date('2026-09-27T21:00:00Z') });
  assert.equal(plan.mode, 'idle', 'removed catalog item must not be treated as a fresh addition');
});

test('independent: restricting a pending author source to metadata preserves its original job and never reposts', async t => {
  const source = sheet('PendingPolicy'), f = await fixture(t, [source]);
  f.setJob({ status: 'running' }); await f.run({ uncheckedOnly: true });
  const restricted = { ...source, monitorOnly: true }; await f.setRegistry([restricted]);
  let reads = 0;
  const reader = async s => { reads++; return metadata(s); };
  assert.equal((await f.run({ uncheckedOnly: true, monitorMetadataReader: reader })).checkedCount, 0);
  assert.equal(reads, 0); assert.equal(f.calls.posts.length, 1);
  f.setJob({ status: 'completed' }); await f.run({ resumePendingOnly: true });
  const next = f.sourcePollLoopPlan(await f.readManifest(), { registry: [restricted], now: new Date('2026-09-27T23:00:00Z') });
  assert.equal(next.mode, 'unchecked');
  await f.run({ uncheckedOnly: true, monitorMetadataReader: reader });
  assert.equal(reads, 1); assert.equal(f.calls.posts.length, 1);
  assert.equal(f.inspect().sources[0].readMode, 'workbook-metadata');
});

test('independent: unknown job state remains pending and cannot postpone full daily check', async t => {
  const source = sheet('UnknownJob'), f = await fixture(t, [source]);
  f.setJob({ status: 'unexpected-state' });
  const result = await f.run({ uncheckedOnly: true });
  assert.equal(result.successfulCount, 0); assert.equal(result.pendingCount, 1);
  const saved = await f.readManifest();
  const before = f.sourcePollLoopPlan(saved, { registry: [source], now: new Date('2026-09-28T15:59:59Z') });
  assert.notEqual(before.mode, 'full');
  const due = f.sourcePollLoopPlan(saved, { registry: [source], now: new Date('2026-09-28T16:00:00Z') });
  assert.equal(due.mode, 'full'); assert.equal(due.resumePendingOnly, false);
  assert.equal(f.calls.posts.length, 1);
});

test('independent: legacy pending receipt without job id cannot create a zero-delay empty polling loop', async t => {
  const f = await fixture(t);
  const source = sheet('OrphanPending');
  await f.writeManifest({ version: 2, updatedAt: stamp, lastFinishedAt: stamp, sources: {
    [sourcePollKey(source)]: { ...source, key: sourcePollKey(source), lastStatus: 'pending', lastCheckedAt: stamp },
  } });
  const before = f.sourcePollLoopPlan(await f.readManifest(), { registry: [], now: new Date('2026-09-27T21:00:00Z') });
  if (before.mode === 'pending') await f.run({ resumePendingOnly: true });
  const after = f.sourcePollLoopPlan(await f.readManifest(), { registry: [], now: new Date('2026-09-27T21:00:00Z') });
  assert.ok(after.mode !== 'pending' || after.nextDelayMs > 0, 'nonrecoverable pending record must not request another immediate empty cycle');
  assert.equal(f.calls.posts.length, 0); assert.equal(f.calls.gets.length, 0);
  assert.equal(f.inspect().successfulTodayCount, 0, 'invalid pending is never fake successful completion');
});

test('independent: changing read policy cannot hot-loop an unrecoverable pending receipt', async t => {
  const source = sheet('OrphanWithNewPolicy'), restricted = { ...source, monitorOnly: true };
  const f = await fixture(t, [restricted]);
  await f.writeManifest({ version: 2, updatedAt: stamp, lastFinishedAt: stamp, sources: {
    [sourcePollKey(source)]: { ...source, key: sourcePollKey(source), lastStatus: 'pending', lastCheckedAt: stamp },
  } });
  const before = f.sourcePollLoopPlan(await f.readManifest(), { registry: [restricted], now: new Date('2026-09-27T21:00:00Z') });
  if (before.mode === 'unchecked') await f.run({ uncheckedOnly: true, monitorMetadataReader: async () => { throw new Error('must not recollect'); } });
  const after = f.sourcePollLoopPlan(await f.readManifest(), { registry: [restricted], now: new Date('2026-09-27T21:00:00Z') });
  assert.equal(after.mode, 'idle', 'blocked recovery plus changed policy must not alternate into unchecked hot loop');
  assert.equal(f.calls.posts.length, 0); assert.equal(f.calls.gets.length, 0);
  assert.equal(f.inspect().successfulTodayCount, 0);
});

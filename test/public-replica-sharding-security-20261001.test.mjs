// Independent, synthetic-only sharding audit. No real DB, network or credential access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import { preparePublicReplicaPublication, createPublicReplicaSync,
  PUBLIC_REPLICA_SUMMARY_FIELDS } from '../lib/public-replica-sync.mjs';

const AS_OF = '2026-09-20T12:00:00.000Z';
const AT = '2026-09-20T02:00:00.000Z';
const SITE = process.env.MCN_SITE_ROOT?pathToFileURL(resolve(process.env.MCN_SITE_ROOT)+'/')
  :existsSync(new URL('../frontend/lib/replica-summary.mjs',import.meta.url))?new URL('../frontend/',import.meta.url)
  :new URL('../../mcn-public-site/', import.meta.url);
const hash = text => createHash('sha256').update(text).digest('hex');
const common = { version: 1, asOf: AS_OF, timeZone: 'Asia/Shanghai' };
const clone = value => structuredClone(value);
const { loadSummary } = await import(new URL('lib/replica-summary.mjs', SITE));
const { readReplicaPart } = await import(new URL('lib/replica-reader.mjs', SITE));

function sourceFixture({ accounts = 2, rows = 1253 } = {}) {
  const files = [];
  const add = (path, kind, count, body, targetId) => {
    const content = JSON.stringify({ ...common, ...body }) + '\n';
    files.push({ path, kind, ...(targetId ? { targetId } : {}), count,
      bytes: Buffer.byteLength(content), sha256: hash(content), content });
  };
  const latest = { value: 0, observedAt: AT, sourceChecksum: 'a'.repeat(64), date: '2026-09-20' };
  add('catalog.json', 'catalog', accounts, { classificationRuleVersion: 'audit-synthetic-v1', boards: [],
    accounts: Array.from({ length: accounts }, (_, i) => ({ id: i + 1, label: `Synthetic ${i + 1}`,
      platform: 'douyin', enabled: true, boardKeys: [],
      historyRevision: { snapshotMaxId: rows, postMaxId: 0, postMetricMaxId: 0 },
      latest: { followers: latest, likes: latest, posts: latest },
      classification: { theme: { key: 'unknown', label: 'unknown', confirmed: false, mode: 'test' },
        primaryKey: 'unknown', primaryLabel: 'unknown', labels: [], needsReview: true, mode: 'test' } })) });
  add('topics.json', 'topics', 0, { topics: [], items: [] });
  for (let id = 1; id <= accounts; id++) {
    const items = Array.from({ length: rows }, (_, i) => {
      const capturedAt = new Date(Date.parse(AT) - i * 86_400_000).toISOString();
      const row = { targetId: id, id: i + 1, date: capturedAt.slice(0, 10), capturedAt,
        sourceChecksum: 'a'.repeat(64), sampleCount: 1,
        followers: i === 0 ? 0 : i, likes: i, posts: null,
        estimatedPlays: i * 100, estimatedPlaysDelta: null, estimatedPlaysProxy: 'likes-times-100' };
      for (const name of ['followers', 'likes', 'posts']) Object.assign(row, {
        [`${name}Delta`]: null, [`${name}At`]: name === 'posts' ? null : capturedAt,
        [`${name}Checksum`]: name === 'posts' ? null : 'a'.repeat(64),
        [`${name}BaselineAt`]: null, [`${name}BaselineChecksum`]: null,
      });
      return row;
    });
    add(`daily/${id}.json`, 'daily', rows, { items }, id);
  }
  return { files, manifest: { ...common, counts: { accounts, enabledAccounts: accounts, boards: 0,
    daily: accounts * rows, works: 0, workMetrics: 0, topics: 0, topicDaily: 0,
    excludedAccountSnapshots: 0 }, policy: { readOnly: true, platformComplete: false,
    independentlyVerified: false, missingDatesFilled: false,
    accountDailyEvidence: 'checksum-and-normalized-vector-bound', worksMetricEvidence: 'saved-record-not-independently-verified',
    topicEvidence: 'per-snapshot-topic-identity-source-run-time-vector-bound', estimate: 'synthetic',
    note: 'synthetic', textRendering: 'textContent' }, files: files.map(({ content, ...meta }) => meta) } };
}

function editPart(publication, path, edit) {
  const file = publication.files.find(f => f.path === path);
  const body = JSON.parse(file.content); edit(body);
  file.content = JSON.stringify(body) + '\n'; file.bytes = Buffer.byteLength(file.content); file.sha256 = hash(file.content);
  Object.assign(publication.manifest.files.find(f => f.path === path), { bytes: file.bytes, sha256: file.sha256 });
}
function editShard(publication, path, edit) {
  editPart(publication, path, edit);
  const meta = publication.manifest.files.find(f => f.path === path);
  editPart(publication, 'summary.json', body => Object.assign(body.shards.find(f => f.path === path),
    { count: meta.count, bytes: meta.bytes, sha256: meta.sha256 }));
}
function editDateShard(publication, path, edit) {
  editPart(publication, path, edit);
  const meta = publication.manifest.files.find(f => f.path === path);
  editPart(publication, 'date-summary-index.json', body => Object.assign(body.shards.find(f => f.path === path),
    { count: meta.count, bytes: meta.bytes, sha256: meta.sha256 }));
}
function legacy(publication) {
  const value = clone(publication), items = [];
  for (const file of value.files.filter(f => f.kind === 'summaryShard')) items.push(...JSON.parse(file.content).items);
  value.files = value.files.filter(f => f.kind !== 'summaryShard');
  value.manifest.files = value.manifest.files.filter(f => f.kind !== 'summaryShard');
  editPart(value, 'summary.json', body => { for (const key of Object.keys(body)) delete body[key]; Object.assign(body, common, { items }); });
  return value;
}

async function routeHarness() {
  const route = await readFile(new URL('app/api/replica/route.ts', SITE), 'utf8');
  const require = createRequire(new URL('package.json', SITE));
  const ts = require('typescript');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE replica_files(generation TEXT,path TEXT,checksum TEXT,bytes INTEGER,PRIMARY KEY(generation,path)); CREATE TABLE replica_generations(generation TEXT PRIMARY KEY,manifest TEXT,published_at TEXT);');
  sqlite.exec(await readFile(new URL('drizzle/0001_swift_morph.sql',SITE),'utf8'));
  const objects = new Map(); let hook = null;
  const db = { prepare(sql) { let args = []; return {
    bind(...values) { args = values; return this; },
    execute() { return sqlite.prepare(sql).run(...args); },
    async first() { await hook?.(sql, args); return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { await hook?.(sql, args); return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { await hook?.(sql, args); return sqlite.prepare(sql).run(...args); },
  }; },async batch(statements){
    sqlite.exec('BEGIN');try{const results=statements.map(statement=>{statement.execute();return {success:true};});sqlite.exec('COMMIT');return results;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  } };
  const bucket = { async put(key, body) { objects.set(key, body); }, async get(key) {
    if (!objects.has(key)) return null; const body = objects.get(key);
    return { size:Buffer.byteLength(body),body:new Response(body).body,async text() { return body; }, async json() { return JSON.parse(body); } };
  } };
  // Synthetic credential never leaves this process and is not printed.
  const environment = { DB: db, BUCKET: bucket, REPLICA_INGEST_SECRET: '0'.repeat(64) };
  const code = ts.transpileModule(route.replace('import { env } from "cloudflare:workers";', 'const env = globalThis.__syntheticEnvironment;'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {}, Request, Response, URL, TextEncoder, crypto: webcrypto,
    __syntheticEnvironment: environment,
    require: specifier => /^@\/lib\/[a-z0-9-]+\.mjs$/.test(specifier)
      ? require(new URL(specifier.slice(2), SITE).pathname) : require(specifier) };
  vm.runInNewContext(code, context, { filename: 'synthetic-replica-route.cjs' });
  return { sqlite, objects, setHook(value) { hook = value; },
    async post(body) { return context.exports.POST(new Request('https://synthetic.invalid/api/replica', {
      method: 'POST', headers: { Authorization: `Bearer ${environment.REPLICA_INGEST_SECRET}` }, body: JSON.stringify(body) })); },
    async get(generation, part) { return context.exports.GET(new Request('https://synthetic.invalid/api/replica?' + new URLSearchParams({ generation, ...(part ? { part } : {}) }))); },
    async upload(publication, omitted = []) { for (let start = 0; start < publication.files.length; start += 35) {
      const files = publication.files.slice(start, start + 35).filter(f => !omitted.includes(f.path)); if (!files.length) continue;
      const response = await this.post({ action: 'upload', asOf: publication.manifest.asOf,
        files: files.map(f => ({ path: f.path, sha256: f.sha256, data: f.content })) });
      assert.equal(response.status, 200, `upload HTTP ${response.status}`);
    } }, async activate(publication) { return this.post({ action: 'activate', asOf: publication.manifest.asOf, manifest: publication.manifest }); },
    close() { sqlite.close(); } };
}

test('independent: deterministic shard derivation, legacy sealed bytes and exact nine-field projection', async () => {
  const source = sourceFixture(), saved = clone(source), publication = await preparePublicReplicaPublication(source);
  assert.deepEqual(source, saved); const index = JSON.parse(publication.files.find(f => f.path === 'summary.json').content);
  assert.equal(index.format, 'daily-shards-v1'); assert.equal(index.count, 2506); assert.equal(index.shards.length, 2);
  const items = [];
  for (const [i, descriptor] of index.shards.entries()) {
    assert.equal(descriptor.path, `summary/${String(i + 1).padStart(6, '0')}.json`);
    const file = publication.files.find(f => f.path === descriptor.path);
    assert.equal(file.kind, 'summaryShard'); assert.equal('targetId' in file, false);
    assert.ok(file.count <= 2000); assert.ok(file.content.length <= 1_000_000);
    assert.equal(file.bytes, descriptor.bytes); assert.equal(file.sha256, descriptor.sha256);
    for (const row of JSON.parse(file.content).items) { assert.deepEqual(Object.keys(row), PUBLIC_REPLICA_SUMMARY_FIELDS); items.push(row); }
  }
  assert.equal(items.length, source.manifest.counts.daily); assert.equal(items[0].followers, 0); assert.equal(items[0].posts, null);
  assert.deepEqual(await preparePublicReplicaPublication(publication), publication);
  const sealed = legacy(publication); assert.deepEqual(await preparePublicReplicaPublication(sealed), sealed);
});

test('independent: source rejects missing, extra, cross-generation, private, path and descriptor pollution before any fetch', async () => {
  const valid = await preparePublicReplicaPublication(sourceFixture());
  const attacks = [
    p => { p.files = p.files.filter(f => f.path !== 'summary/000002.json'); p.manifest.files = p.manifest.files.filter(f => f.path !== 'summary/000002.json'); },
    p => editPart(p, 'summary.json', b => { b.shards[0].sha256 = 'f'.repeat(64); }),
    p => editPart(p, 'summary.json', b => { b.shards[0].count--; }),
    p => editPart(p, 'summary.json', b => { b.shards[0].path = 'summary/../catalog.json'; }),
    p => editPart(p, 'summary.json', b => { b.shards.push(b.shards[0]); }),
    p => editPart(p, 'summary.json', b => { b.count--; }),
    p => editShard(p, 'summary/000001.json', b => { b.asOf = '2026-09-19T12:00:00.000Z'; }),
    p => editShard(p, 'summary/000001.json', b => { b.items[0].source_url = 'https://private.invalid/synthetic'; }),
    p => editShard(p, 'summary/000001.json', b => { b.items[0].followers = { secret: 'synthetic-only' }; }),
    p => editShard(p, 'summary/000001.json', b => { b.items[0].targetId = 99; }),
    p => { p.files.find(f => f.kind === 'summaryShard').targetId = 1; p.manifest.files.find(f => f.kind === 'summaryShard').targetId = 1; },
    p => editPart(p, 'summary.json', b => { b.shards = Array.from({ length: 4097 }, () => b.shards[0]); }),
  ];
  for (const attack of attacks) {
    const publication = clone(valid); attack(publication); let calls = 0;
    const sync = createPublicReplicaSync({ fetchImpl: async () => { calls++; throw Error('unexpected network'); }, getCredential: async () => '0'.repeat(64) });
    const result = await sync.sync(publication); assert.equal(result.status, 'failed'); assert.equal(calls, 0);
    assert.equal(JSON.stringify(result).includes('private.invalid'), false); assert.equal(JSON.stringify(result).includes('synthetic-only'), false);
  }
});

test('independent route: staged shards remain private and incomplete activation does not move published pointer', async () => {
  const h = await routeHarness(); try {
    const old = legacy(await preparePublicReplicaPublication(sourceFixture({ rows: 1 })));
    await h.upload(old); assert.equal((await h.activate(old)).status, 200);
    const p = await preparePublicReplicaPublication(sourceFixture());
    p.manifest.asOf = '2026-09-20T13:00:00.000Z';
    for (const f of [...p.files]) editPart(p, f.path, b => { b.asOf = p.manifest.asOf; });
    for (const descriptor of JSON.parse(p.files.find(f => f.path === 'summary.json').content).shards) {
      const f = p.files.find(f => f.path === descriptor.path);
      editPart(p, 'summary.json', b => Object.assign(b.shards.find(d => d.path === f.path), { bytes: f.bytes, sha256: f.sha256 }));
    }
    await h.upload(p, ['summary/000002.json']);
    assert.equal((await h.get(p.manifest.asOf, 'summary/000001.json')).status, 404);
    assert.equal((await h.activate(p)).status, 409);
    const latest = await (await h.get(AS_OF)).json(); assert.equal(latest.manifest.asOf, AS_OF);
  } finally { h.close(); }
});

test('independent route: declared complete shard version publishes, retries identically and cannot mutate sealed bytes', async () => {
  const h = await routeHarness(); try {
    const p = await preparePublicReplicaPublication(sourceFixture()); await h.upload(p);
    assert.equal((await h.activate(p)).status, 200); assert.equal((await h.activate(p)).status, 200);
    for (const f of p.files.filter(f => ['summary', 'summaryShard'].includes(f.kind))) {
      const r = await h.get(AS_OF, f.path); assert.equal(r.status, 200); assert.equal(await r.text(), f.content);
      assert.equal(r.headers.get('X-Data-Cutoff'), AS_OF); assert.equal(r.headers.get('X-Data-SHA256'), f.sha256);
    }
    const f = p.files.find(f => f.kind === 'summaryShard'), altered = f.content + ' ';
    assert.equal((await h.post({ action: 'upload', asOf: AS_OF, files: [{ path: f.path, data: altered, sha256: hash(altered) }] })).status, 409);
  } finally { h.close(); }
});

test('independent route: index-to-manifest count/hash mismatch and orphan shard cannot activate', async () => {
  const valid = await preparePublicReplicaPublication(sourceFixture());
  for (const attack of [
    p => editPart(p, 'summary.json', b => { b.shards[0].sha256 = 'f'.repeat(64); }),
    p => editPart(p, 'summary.json', b => { b.shards[0].bytes++; }),
    p => editPart(p, 'summary.json', b => { b.shards[0].count--; }),
    p => editPart(p, 'summary.json', b => { b.shards.pop(); }),
    p => { p.manifest.counts.daily--; },
    p => { p.manifest.files.find(f => f.kind === 'summaryShard').kind = 'daily'; },
    p => { p.manifest.files.find(f => f.kind === 'summaryShard').targetId = 1; },
    p => { p.manifest.files.find(f => f.kind === 'summary').count--; },
    p => { p.manifest.files.find(f => f.kind === 'summary').kind = 'daily'; },
  ]) {
    const h = await routeHarness(); try {
      const p = clone(valid); attack(p); await h.upload(p);
      assert.notEqual((await h.activate(p)).status, 200); assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM replica_generations').get().n, 0);
    } finally { h.close(); }
  }
});

test('independent route: conflicting concurrent activation reports only one accepted manifest', async () => {
  const h = await routeHarness(); try {
    const p = await preparePublicReplicaPublication(sourceFixture()); await h.upload(p);
    const other = clone(p); other.manifest.policy.note = 'synthetic conflicting manifest';
    let arrivals = 0, release; const gate = new Promise(resolve => { release = resolve; });
    h.setHook(async sql => { if (sql === 'SELECT manifest FROM replica_generations WHERE generation=?' && arrivals < 2) {
      arrivals++; if (arrivals === 2) release(); await gate;
    } });
    const results = await Promise.all([h.activate(p), h.activate(other)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM replica_generations').get().n, 1);
  } finally { h.close(); }
});

test('independent route: shard bodies cannot contain private extra fields, wrong row counts or exceed 1M chars', async () => {
  const valid = await preparePublicReplicaPublication(sourceFixture());
  for (const attack of [
    p => editShard(p, 'summary/000001.json', b => { b.items[0].source_url = 'https://private.invalid/synthetic'; }),
    p => editShard(p, 'summary/000001.json', b => { b.items.pop(); }),
    p => editShard(p, 'summary/000001.json', b => { b.items[0].date = 'x'.repeat(1_000_001); }),
    p => editShard(p, 'summary/000001.json', b => { b.timeZone = 'UTC'; }),
  ]) {
    const h = await routeHarness(); try {
      const p = clone(valid); attack(p);
      let rejected = false;
      for (const f of p.files) {
        const r = await h.post({ action: 'upload', asOf: AS_OF, files: [{ path: f.path, data: f.content, sha256: f.sha256 }] });
        if (r.status !== 200) { rejected = true; break; }
      }
      if (!rejected) rejected = (await h.activate(p)).status !== 200;
      assert.equal(rejected, true, 'invalid shard body reached published manifest');
      assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM replica_generations').get().n, 0);
    } finally { h.close(); }
  }
});

test('independent route: missing shard object with surviving metadata cannot activate', async () => {
  const h = await routeHarness(); try {
    const p = await preparePublicReplicaPublication(sourceFixture()); await h.upload(p);
    const shard = p.files.find(f => f.path === 'summary/000002.json');
    h.objects.delete(`${AS_OF}/${shard.sha256}`);
    assert.notEqual((await h.activate(p)).status, 200);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM replica_generations').get().n, 0);
  } finally { h.close(); }
});

test('independent loader: legacy/new consistency, bounded workers, ordered assembly and fail-before-apply', async () => {
  const p = await preparePublicReplicaPublication(sourceFixture({ accounts: 5, rows: 2001 }));
  const parts = new Map(p.files.map(f => [f.path, JSON.parse(f.content)]));
  let inFlight = 0, maximum = 0;
  const points = await loadSummary(p.manifest, async path => {
    inFlight++; maximum = Math.max(maximum, inFlight);
    await new Promise(resolve => setTimeout(resolve, path === 'summary/000001.json' ? 8 : 1));
    inFlight--; return clone(parts.get(path));
  });
  assert.ok(maximum <= 4); assert.equal(points.length, 10005);
  assert.deepEqual(points, p.files.filter(f => f.kind === 'daily').flatMap(f =>
    JSON.parse(f.content).items.map(row => Object.fromEntries(PUBLIC_REPLICA_SUMMARY_FIELDS.map(k => [k, row[k] ?? null])))));
  const old = legacy(p); assert.deepEqual(await loadSummary(old.manifest, async path => JSON.parse(old.files.find(f => f.path === path).content)), points);
  let current = { generation: 'old', points: ['old'] };
  await assert.rejects(async () => {
    const next = await loadSummary(p.manifest, async path => { if (path === 'summary/000004.json') throw Error('synthetic missing'); return clone(parts.get(path)); });
    current = { generation: AS_OF, points: next };
  });
  assert.deepEqual(current, { generation: 'old', points: ['old'] });
  let calls = 0;
  for (const tooLarge of [
    { ...p.manifest, counts: { ...p.manifest.counts, daily: 200001 } },
    { ...p.manifest, files: p.manifest.files.map(f => f.kind === 'summary' ? { ...f, bytes: 64_000_001 } : f) },
  ]) await assert.rejects(() => loadSummary(tooLarge, async () => { calls++; }));
  assert.equal(calls, 0);
});

test('independent loader: malformed descriptor or private/mixed-time shard body rejects the entire result', async () => {
  const valid = await preparePublicReplicaPublication(sourceFixture());
  for (const attack of [
    p => editPart(p, 'summary.json', b => { b.shards[0].path = 'summary/../../private.json'; }),
    p => editPart(p, 'summary.json', b => { b.shards[0].bytes++; }),
    p => editShard(p, 'summary/000001.json', b => { b.items[0].source_url = 'https://private.invalid/synthetic'; }),
    p => editShard(p, 'summary/000001.json', b => { b.items[0].followersAt = '2026-09-19T02:00:00.000Z'; }),
    p => editShard(p, 'summary/000001.json', b => { b.items[0].followers = -1; }),
    p => editShard(p, 'summary/000001.json', b => { b.asOf = '2026-09-19T12:00:00.000Z'; }),
    p => editShard(p, 'summary/000001.json', b => { b.items.pop(); }),
  ]) {
    const p = clone(valid); attack(p); let applied = false;
    await assert.rejects(async () => { await loadSummary(p.manifest,
      async path => JSON.parse(p.files.find(f => f.path === path).content)); applied = true; });
    assert.equal(applied, false);
  }
});

test('independent reader: actual body hash/bytes, response digest, cutoff and JSON generation bind', async () => {
  const page = await readFile(new URL('app/page.tsx', SITE), 'utf8');
  const require = createRequire(new URL('package.json', SITE)), ts = require('typescript');
  // Locate the declaration, not every JSX component placed before Home.
  const syntax = ts.createSourceFile('page.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'read');
  const functionSource = declaration?.getText(syntax);
  assert.ok(functionSource);
  let reply;
  const context = { exports: {}, URLSearchParams, TextEncoder, crypto: webcrypto,
    fetch: async () => reply,
    readReplicaPart: options => readReplicaPart({ ...options, fetcher: async () => reply }) };
  vm.runInNewContext(ts.transpileModule(functionSource + '\nexport { read };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const p = await preparePublicReplicaPublication(sourceFixture()), file = p.files.find(f => f.kind === 'summaryShard');
  const headers = { 'X-Data-SHA256': file.sha256, 'X-Data-Cutoff': AS_OF };
  reply = new Response(file.content, { headers }); assert.equal((await context.exports.read(AS_OF, file.path, file)).asOf, AS_OF);
  for (const [body, responseHeaders, meta] of [
    [file.content + ' ', headers, file],
    [file.content, { ...headers, 'X-Data-SHA256': 'f'.repeat(64) }, file],
    [file.content, { ...headers, 'X-Data-Cutoff': '2026-09-19T12:00:00.000Z' }, file],
    [file.content.replace(AS_OF, '2026-09-19T12:00:00.000Z'), headers, null],
  ]) { reply = new Response(body, { headers: responseHeaders }); await assert.rejects(() => context.exports.read(AS_OF, file.path, meta)); }
});

test('independent actual-route integration: >6M aggregate daily history, unknown activate result and immutable anonymous resume', async () => {
  const h = await routeHarness(); try {
    const source = sourceFixture({ accounts: 20, rows: 1500 });
    const publication = await preparePublicReplicaPublication(source);
    assert.ok(legacy(publication).files.find(f => f.kind === 'summary').content.length > 6_000_000);
    let checkpoint = null, posts = 0, lostReply = true;
    const sync = createPublicReplicaSync({ getCredential: async () => '0'.repeat(64),
      loadCheckpoint: async () => clone(checkpoint), saveCheckpoint: async value => { checkpoint = clone(value); },
      fetchImpl: async (url, init = {}) => {
        assert.equal(init.redirect, 'error'); const u = new URL(url);
        if (init.method === 'POST') {
          posts++; assert.equal(init.headers.Authorization, `Bearer ${'0'.repeat(64)}`);
          const body = JSON.parse(init.body), response = await h.post(body);
          if (body.action === 'activate' && response.ok && lostReply) { lostReply = false; throw Error('synthetic lost activation response'); }
          return response;
        }
        assert.equal(init.headers?.Authorization, undefined);
        return h.get(u.searchParams.get('generation'), u.searchParams.get('part'));
      } });
    const unknown = await sync.sync(source); assert.equal(unknown.status, 'failed'); assert.equal(unknown.activationState, 'unknown');
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM replica_generations').get().n, 1);
    const before = posts, recovered = await sync.sync(source);
    assert.equal(recovered.status, 'success'); assert.equal(recovered.alreadyPublished, true); assert.equal(posts, before);
    assert.equal(recovered.summaryShards, 15); assert.equal(recovered.sourceFilesValidated, 22);
    assert.deepEqual(recovered.readbackFiles.filter(p => p.startsWith('summary/')), ['summary/000001.json', 'summary/000015.json']);
    assert.equal(JSON.stringify(unknown).includes('synthetic lost'), false);
  } finally { h.close(); }
});

test('independent date route: opt-in source proof publishes and anonymous GET authenticates every date part', async () => {
  const source = sourceFixture({ rows: 1100 }), before = clone(source);
  const publication = await preparePublicReplicaPublication(source, { dateIndex: true });
  assert.deepEqual(source, before);
  const indexFile = publication.files.find(f => f.kind === 'summaryDateIndex');
  const index = JSON.parse(indexFile.content);
  assert.equal(index.format, 'date-shards-v1'); assert.equal(index.count, 2200);
  assert.equal(index.shards.length, 2);
  assert.deepEqual(await preparePublicReplicaPublication(publication), publication);
  const h = await routeHarness(); try {
    await h.upload(publication);
    assert.equal((await h.get(AS_OF, indexFile.path)).status, 404,
      'uploaded files are not a visible generation before activation');
    assert.equal((await h.activate(publication)).status, 200);
    for (const file of publication.files.filter(f => ['summaryDateIndex', 'summaryDateShard'].includes(f.kind))) {
      const response = await h.get(AS_OF, file.path);
      assert.equal(response.status, 200); assert.equal(await response.text(), file.content);
      assert.equal(response.headers.get('X-Data-SHA256'), file.sha256);
      assert.equal(response.headers.get('X-Data-Cutoff'), AS_OF);
    }
  } finally { h.close(); }
});

test('independent date route: missing date shard cannot activate or replace a sealed prior generation', async () => {
  const h = await routeHarness(); try {
    const old = await preparePublicReplicaPublication(sourceFixture({ rows: 1 }));
    await h.upload(old); assert.equal((await h.activate(old)).status, 200);
    const source = sourceFixture({ rows: 1100 }); source.manifest.asOf = '2026-09-20T13:00:00.000Z';
    for (const file of [...source.files]) editPart(source, file.path, body => { body.asOf = source.manifest.asOf; });
    const publication = await preparePublicReplicaPublication(source, { dateIndex: true });
    const omitted = publication.files.filter(f => f.kind === 'summaryDateShard').at(-1);
    await h.upload(publication, [omitted.path]);
    assert.equal((await h.get(publication.manifest.asOf, 'date-summary-index.json')).status, 404);
    assert.equal((await h.activate(publication)).status, 409);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM replica_generations').get().n, 1);
    assert.deepEqual((await (await h.get(AS_OF)).json()).manifest, old.manifest);
  } finally { h.close(); }
});

test('independent date route: re-signed date values and bounds fail server full-source proof', async () => {
  const valid = await preparePublicReplicaPublication(sourceFixture({ rows: 1100 }), { dateIndex: true });
  const shardPath = valid.files.find(f => f.kind === 'summaryDateShard').path;
  for (const attack of [
    p => editDateShard(p, shardPath, body => { body.items[0].followers += 1; }),
    p => editDateShard(p, shardPath, body => { body.items[0].date = '2026-09-20'; }),
    p => editPart(p, 'date-summary-index.json', body => {
      body.shards[0].firstDate = '2000-01-01'; body.firstDate = '2000-01-01';
    }),
  ]) {
    const h = await routeHarness(); try {
      const publication = clone(valid); attack(publication); let rejectedAtUpload = false;
      for (const file of publication.files) {
        const response = await h.post({ action: 'upload', asOf: AS_OF,
          files: [{ path: file.path, data: file.content, sha256: file.sha256 }] });
        if (response.status !== 200) { assert.equal(response.status, 400); rejectedAtUpload = true; break; }
      }
      if (!rejectedAtUpload) {
        const response = await h.activate(publication); assert.equal(response.status, 409);
        assert.match((await response.json()).error, /全量来源核对/);
      }
      assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM replica_generations').get().n, 0);
      assert.equal((await h.get(AS_OF, 'date-summary-index.json')).status, 404,
        'rejected generation must remain absent, never partially readable');
    } finally { h.close(); }
  }
});

test('independent date route: identical sealed replay is accepted but date bytes cannot be changed', async () => {
  const publication = await preparePublicReplicaPublication(sourceFixture({ rows: 1100 }), { dateIndex: true });
  const h = await routeHarness(); try {
    await h.upload(publication); assert.equal((await h.activate(publication)).status, 200);
    await h.upload(publication); assert.equal((await h.activate(publication)).status, 200);
    const original = publication.files.find(f => f.kind === 'summaryDateShard');
    const changed = clone(publication); editDateShard(changed, original.path, body => { body.items[0].likes += 1; });
    const file = changed.files.find(f => f.path === original.path);
    assert.equal((await h.post({ action: 'upload', asOf: AS_OF,
      files: [{ path: file.path, data: file.content, sha256: file.sha256 }] })).status, 409);
    assert.equal(await (await h.get(AS_OF, original.path)).text(), original.content);
    assert.deepEqual((await (await h.get(AS_OF)).json()).manifest, publication.manifest);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM replica_generations').get().n, 1);
  } finally { h.close(); }
});

test('independent date route: surviving metadata cannot conceal a missing date object at activation', async () => {
  const publication = await preparePublicReplicaPublication(sourceFixture({ rows: 1100 }), { dateIndex: true });
  const h = await routeHarness(); try {
    await h.upload(publication);
    const file = publication.files.filter(f => f.kind === 'summaryDateShard').at(-1);
    assert.equal(h.sqlite.prepare('SELECT checksum FROM replica_files WHERE generation=? AND path=?')
      .get(AS_OF, file.path).checksum, file.sha256);
    h.objects.delete(`${AS_OF}/${file.sha256}`);
    const response = await h.activate(publication); assert.equal(response.status, 409);
    assert.match((await response.json()).error, /存储分片缺失或损坏/);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM replica_generations').get().n, 0);
    // Activation failed, so this generation does not exist. A 404 is the
    // established missing-generation response, not a readable partial index.
    assert.equal((await h.get(AS_OF, 'date-summary-index.json')).status, 404);
  } finally { h.close(); }
});

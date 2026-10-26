// Executes the actual deployed-source route in memory. No cloud, CLI, network,
// browser, credential, database-file, or Site-write operation is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const site = new URL('../../mcn-public-site/', import.meta.url);
const requireSite = createRequire(new URL('package.json', site));
const ts = requireSite('typescript');
const source = await readFile(new URL('app/api/replica/route.ts', site), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const asOf = '2026-10-01T00:00:00.000Z';
const syntheticProducer = 'phase68-test-only-not-a-real-credential-'.repeat(2);

function routeHarness({latest = null} = {}) {
  const calls = {prepare: [], read: 0, write: 0, storage: 0, fetch: 0};
  const db = {prepare(sql) {
    calls.prepare.push(sql);
    return {
      async first() {calls.read++; return latest;},
      bind() {return this;},
      async all() {calls.read++; return {results: []};},
      async run() {calls.write++; throw Error('No writes are allowed in this peer fixture');},
    };
  }};
  const bucket = {
    async get() {calls.storage++; throw Error('No storage read expected');},
    async put() {calls.storage++; throw Error('No storage writes allowed');},
  };
  const env = {DB: db, BUCKET: bucket, REPLICA_INGEST_SECRET: syntheticProducer};
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, URL, Response, Date, TextEncoder, crypto: webcrypto,
    fetch() {calls.fetch++; throw Error('No external network allowed');},
    require(name) {
      if (name === 'cloudflare:workers') return {env};
      if (name.startsWith('@/lib/')) return requireSite(new URL(name.slice(2), site).pathname);
      throw Error('Unexpected route dependency: ' + name);
    },
  }, {filename: 'phase68-actual-replica-route.ts'});
  const post = (body, authorized = false) => exports.POST(new Request('https://phase68.invalid/api/replica', {
    method: 'POST',
    headers: authorized ? {Authorization: `Bearer ${syntheticProducer}`} : {},
    body: JSON.stringify(body),
  }));
  return {route: exports, calls, post};
}

test('phase68 a timer HTTP POST without producer authority is rejected before parsing or touching storage', async () => {
  const h = routeHarness();
  let bodyReads = 0;
  const result = await h.route.POST({headers: new Headers(), text() {bodyReads++; return '{}';}});
  assert.equal(result.status, 403);
  assert.deepEqual(await result.json(), {error: '只读访问'});
  assert.equal(bodyReads, 0);
  assert.deepEqual(h.calls, {prepare: [], read: 0, write: 0, storage: 0, fetch: 0});
});

test('phase68 forwarding an ordinary HTTP response is not an ingest or activation contract, even with synthetic producer authority', async () => {
  const h = routeHarness();
  const result = await h.post({asOf, body: {items: [{record_id: 'synthetic-record'}]}, status_code: 200}, true);
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), {error: '无效发布清单'});
  assert.deepEqual(h.calls, {prepare: [], read: 0, write: 0, storage: 0, fetch: 0});
});

test('phase68 action collect cannot turn the existing producer endpoint into an arbitrary scheduler executor', async () => {
  const h = routeHarness();
  const result = await h.post({asOf, action: 'collect', scheduleTime: asOf}, true);
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), {error: '无效发布清单'});
  assert.deepEqual(h.calls, {prepare: [], read: 0, write: 0, storage: 0, fetch: 0});
});

test('phase68 renaming a response as an upload does not bypass the checksum contract', async () => {
  const h = routeHarness();
  const data = JSON.stringify({asOf, accounts: []});
  const result = await h.post({asOf, action: 'upload', files: [{path: 'catalog.json', data, sha256: '0'.repeat(64)}]}, true);
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), {error: '分区审查或校验失败'});
  assert.equal(h.calls.read, 1, 'Only the sealed-generation lookup may occur before checksum rejection');
  assert.equal(h.calls.write, 0);
  assert.equal(h.calls.storage, 0);
  assert.equal(h.calls.fetch, 0);
});

test('phase68 a timer GET only retrieves an existing generation and truthfully leaves collection local', async () => {
  const manifest = {asOf, files: []};
  const h = routeHarness({latest: {generation: asOf, manifest: JSON.stringify(manifest), published_at: asOf}});
  const result = await h.route.GET(new Request('https://phase68.invalid/api/replica'));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {manifest, publishedAt: asOf, readOnly: true, collectionRequiresLocalComputer: true});
  assert.equal(h.calls.read, 1);
  assert.equal(h.calls.write, 0);
  assert.equal(h.calls.storage, 0);
  assert.equal(h.calls.fetch, 0);
});

// Phase81 independent portability probes. Run only the already-installed local
// workerd runtime, using the Site build's exact compatibility settings. No Site
// server, cloud control plane, source request, real credential, or database is
// opened. The probe Worker has no storage/browser bindings or outbound access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const site = new URL('../../mcn-public-site/', import.meta.url);
const requireSite = createRequire(new URL('package.json', site));
const { Miniflare, Log, LogLevel } = requireSite('miniflare');
const generated = JSON.parse(await readFile(new URL('dist/server/wrangler.json', site), 'utf8'));
const probe = `
  import { spawn, execFile } from 'node:child_process';
  import { DatabaseSync } from 'node:sqlite';
  import { stat } from 'node:fs/promises';
  export default {
    async fetch(request, env) {
      const operation = new URL(request.url).pathname.slice(1);
      try {
        if (operation === 'spawn') spawn('/phase81-nonexistent-browser', []);
        else if (operation === 'execFile') execFile('/phase81-nonexistent-lark-cli', []);
        else if (operation === 'sqlite') new DatabaseSync(':memory:');
        else if (operation === 'host-file') await stat('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
        else return Response.json({ bindings: Object.keys(env) });
        return Response.json({ operation, returned: true });
      } catch (error) {
        return Response.json({ operation, returned: false, name: error.name, code: error.code ?? null, message: error.message });
      }
    }
  };
`;

test('phase81 actual workerd portability contract for the existing Site compatibility date', async t => {
  let outbound = 0;
  const runtime = new Miniflare({
    name: 'phase81-isolated-portability-probe',
    modules: true,
    script: probe,
    compatibilityDate: generated.compatibility_date,
    compatibilityFlags: generated.compatibility_flags,
    cf: false,
    host: '127.0.0.1',
    port: 0,
    cachePersist: false,
    kvPersist: false,
    d1Persist: false,
    r2Persist: false,
    log: new Log(LogLevel.ERROR),
    outboundService() { outbound++; throw new Error('Phase81 forbids outbound requests'); },
  });
  const invoke = async operation => {
    const response = await runtime.dispatchFetch('https://phase81.invalid/' + operation);
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    await t.test('native spawn rejects process creation before resolving the fake executable', async () => {
      const result = await invoke('spawn');
      assert.equal(result.returned, false);
      assert.match(result.message, /not implemented|not supported|unavailable/i);
      assert.doesNotMatch(result.message, /ENOENT/);
      t.diagnostic(JSON.stringify(result));
    });
    await t.test('native execFile cannot turn a Worker into the existing Feishu CLI host', async () => {
      const result = await invoke('execFile');
      assert.equal(result.returned, false);
      assert.match(result.message, /not implemented|not supported|unavailable/i);
      assert.doesNotMatch(result.message, /ENOENT/);
      t.diagnostic(JSON.stringify(result));
    });
    await t.test('native DatabaseSync rejects even an in-memory database', async () => {
      const result = await invoke('sqlite');
      assert.equal(result.returned, false);
      // The installed native stub rejects construction, rather than using the
      // child_process module's ERR_METHOD_NOT_IMPLEMENTED wording.
      assert.equal(result.message, 'Illegal constructor');
      t.diagnostic(JSON.stringify(result));
    });
    await t.test('Worker filesystem cannot see the Mac Chrome executable', async () => {
      const result = await invoke('host-file');
      assert.equal(result.returned, false);
      assert.equal(result.code, 'ENOENT');
      t.diagnostic(JSON.stringify(result));
    });
    await t.test('probe has no inherited source, browser, storage, or publisher capability', async () => {
      assert.deepEqual(await invoke('bindings'), { bindings: [] });
      assert.equal(outbound, 0);
    });
  } finally {
    await runtime.dispose();
  }
  assert.equal(outbound, 0);
  t.diagnostic('temporaryRuntimeDisposed=true; outboundRequests=0; inheritedBindings=0');
});

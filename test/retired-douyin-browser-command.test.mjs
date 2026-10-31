import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBrowserWorks } from '../scripts/douyin_browser_collector.mjs';
import { resolveTopics } from '../scripts/douyin_topic_browser_resolver.mjs';
import { collectAuthorisedDetail } from '../lib/douyin-authorised-detail.mjs';
import { createOwnedCollectorExecutor } from '../lib/collector-ownership.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const commands = [
  'douyin_browser_resolver.mjs', 'douyin_browser_collector.mjs',
  'douyin_topic_browser_resolver.mjs', 'douyin_authorised_detail.mjs',
  'douyin_public_id_search.mjs', 'douyin_work_author_candidate.mjs',
  'connect-douyin-topics.mjs',
];

test('real library fallbacks reject before stored session access', async () => {
  let stateReads = 0;
  const readState = async () => { stateReads++; throw Error('session must not be read'); };
  await assert.rejects(collectBrowserWorks({}, { runtime: { readState } }), { code: 'DOUYIN_BROWSER_RETIRED' });
  await assert.rejects(resolveTopics(['offline']), { code: 'DOUYIN_BROWSER_RETIRED' });
  await assert.rejects(collectAuthorisedDetail({ items: [{ key: 'offline', videoId: '7300000000000000000', submittedId: 'offline' }] }, {
    enabled: true,
    runtime: { readState, ownership: { send: async () => {}, remainingExecutionMs: () => 45000 } },
  }), { code: 'DOUYIN_BROWSER_RETIRED' });
  assert.equal(stateReads, 0);
});

test('retired commands release an existing parent lane without claiming a browser release', async t => {
  for (const command of commands) await t.test(command, async () => {
    const executor = createOwnedCollectorExecutor();
    const output = await new Promise(resolve => {
      executor.exec(process.execPath, [join(root, 'scripts', command)], {
        timeout: 5000, maxBuffer: 16384,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    assert.equal(output.error?.code, 'BROWSER_COLLECTOR_EXIT');
    // The ownership supervisor deliberately discards output on nonzero exit.
    // Exact public rejection JSON is verified by the standalone tests below.
    assert.equal(output.stdout, '');
    assert.equal(output.stderr, '');
    assert.deepEqual(executor.state(), { busy: false, locked: false, reason: null });
    assert.equal(executor.diagnostics().lastLock, null);
  });
});

test('retired commands reject before stdin, browser launch or legacy opt-ins', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mcn-retired-browser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = join(directory, 'unexpected-browser-launch');
  // Even the RED run cannot open a real browser. Intercept the dependency in
  // child processes; production code does not know or rely on this test hook.
  const hook = join(directory, 'deny-browser.mjs');
  await writeFile(hook, `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(specifier==='playwright-core')return {url:'data:text/javascript,'+encodeURIComponent(
  ${JSON.stringify(`import {writeFileSync} from 'node:fs';
const deny=()=>{writeFileSync(${JSON.stringify(sentinel)},'forbidden');throw Error('TEST_BROWSER_FORBIDDEN');};
export const chromium={launch:deny,launchServer:deny,connect:deny};`)}),shortCircuit:true};
 return next(specifier,context);
}});`);
  for (const command of commands) await t.test(command, async () => {
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', hook, join(root, 'scripts', command)], {
        cwd: directory,
        env: { ...process.env, DATA_DIR: directory, DOUYIN_CHROME_PATH: process.execPath,
          DOUYIN_BROWSER_DISABLED: '0', DOUYIN_ACCOUNT_BROWSER_FALLBACK: '1',
          DOUYIN_AUTHOR_RESOLVER_MODE: 'browser-first', DOUYIN_TOPIC_RESOLVER_MODE: 'browser',
          DOUYIN_AUTHORISED_DETAIL_ENABLED: '1', DOUYIN_PUBLIC_ID_SEARCH_ENABLED: '1',
          DOUYIN_WORK_AUTHOR_CANDIDATE_ENABLED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', timedOut = false;
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 2500);
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
      // Deliberately leave stdin open. A retired entry must reject before
      // reading an untrusted/uploaded payload or waiting for user input.
    });
    assert.equal(outcome.timedOut, false, 'command waited for stdin');
    assert.equal(outcome.code, 1);
    assert.equal(outcome.stderr, '');
    assert.deepEqual(JSON.parse(outcome.stdout), {
      ok: false, errorCode: 'DOUYIN_BROWSER_RETIRED',
      message: '本产品已停用本机抖音浏览器采集；请使用 HTTP 或已授权的数据来源。',
      runtimeAI: false,
    });
    await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
  });
});

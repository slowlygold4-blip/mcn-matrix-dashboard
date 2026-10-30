// Test-only observability for the real CLI + disposable Worker architecture.
// No production hooks, transport changes or IPC forwarding added to the app.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
export const publisherProbePreload = `
import {appendFileSync as probeAppend,existsSync as probeExists} from 'node:fs';
import {gunzipSync as probeGunzip} from 'node:zlib';
import {isMainThread as probeMain,parentPort as probePort} from 'node:worker_threads';
globalThis.publisherTestNotify=message=>probeAppend(process.env.MCN_TEST_EVENTS,JSON.stringify(message)+'\\n');
if(!probeMain&&probePort){const original=probePort.postMessage.bind(probePort);probePort.postMessage=(message,...args)=>{if(message==='publisher-cycle-complete')publisherTestNotify({kind:'cycle-completed'});return original(message,...args);};}
globalThis.publisherTestReleased=()=>probeExists(process.env.MCN_TEST_RELEASE);
globalThis.publisherTestBody=init=>{
 const compressed=new Headers(init.headers).get('content-encoding')==='gzip';
 const bytes=Buffer.from(init.body);
 const value=JSON.parse((compressed?probeGunzip(bytes):bytes).toString('utf8'));
 publisherTestNotify({kind:'request-body',gzip:compressed});
 return value;
};
`;
export function createPublisherProcessProbe(directory) {
  const stem = join(directory, '.publisher-test-' + randomUUID());
  const events = stem + '.jsonl', release = stem + '.release';
  const watchers = new Set();
  return {
    env: { MCN_TEST_EVENTS: events, MCN_TEST_RELEASE: release },
    release() { writeFileSync(release, 'released'); },
    watch(receive) {
      let consumed = 0;
      const poll = () => {
        let text; try { text = readFileSync(events, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
        // Only consume complete newline-terminated records, including when a
        // Worker appends as the test process reads. Preserve ordering/duplicates.
        const complete = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
        for (; consumed < complete.length; consumed++) receive(JSON.parse(complete[consumed]));
      };
      const timer = setInterval(poll, 10); timer.unref();
      const stop = () => { clearInterval(timer); poll(); watchers.delete(stop); };
      watchers.add(stop); return stop;
    },
    close() { for (const stop of [...watchers]) stop(); rmSync(events, { force: true }); rmSync(release, { force: true }); },
  };
}

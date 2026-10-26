#!/usr/bin/env node
import { collectPublicIdSearch } from '../lib/douyin-public-id-search.mjs';
import { collectorOwnershipClient } from '../lib/collector-ownership.mjs';

// A standalone call cannot bypass the shared parent's ownership lane. Enable
// only in the parent-owned child environment, never from uploaded payload data.
let ownership, launchRequested = false, registered = false, released = false, completeRequested = false;
async function completeIfReleased() {
  if (!ownership || completeRequested || (launchRequested && !released)) return;
  completeRequested = true;
  await ownership.send('complete');
}
try {
  if (process.env.DOUYIN_PUBLIC_ID_SEARCH_ENABLED !== '1') throw Object.assign(new Error(), { code: 'disabled' });
  ownership = collectorOwnershipClient();
  if (!ownership) throw Object.assign(new Error(), { code: 'ownership_required' });
  await ownership.send('hello');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  let input = '', bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16_384) throw Object.assign(new Error(), { code: 'invalid_input' });
    input += chunk;
  }
  let payload;
  try { payload = JSON.parse(input); } catch { throw Object.assign(new Error(), { code: 'invalid_input' }); }
  const trackedOwnership = { remainingExecutionMs: () => ownership.remainingExecutionMs(), send: async (kind, pid) => {
    if (kind === 'launch') launchRequested = true;
    await ownership.send(kind, pid);
    if (kind === 'register') registered = true;
    if (kind === 'released') released = true;
  } };
  const data = await collectPublicIdSearch(payload, { enabled: true, runtime: { ownership: trackedOwnership }, signal: controller.signal });
  await completeIfReleased();
  process.off('SIGTERM', stop);
  process.stdout.write(JSON.stringify({ ok: true, data }));
  if (!registered || !released || data.errorCode === 'cleanup_uncertain') process.exitCode = 1;
} catch (error) {
  try { await completeIfReleased(); } catch { /* Parent retains the lane's uncertainty; never send duplicate completion. */ }
  const errorCode = ['disabled', 'ownership_required', 'invalid_input'].includes(error?.code) ? error.code : 'collector_error';
  process.stdout.write(JSON.stringify({ ok: false, errorCode }));
  process.exitCode = 1;
} finally { if (process.connected) process.disconnect(); }

#!/usr/bin/env node
import { collectDouyinWorkAuthorCandidate } from '../lib/douyin-work-author-candidate.mjs';
import { collectorOwnershipClient } from '../lib/collector-ownership.mjs';

// A private parent-owned lane is mandatory. Uploaded input cannot enable this
// command, supply a browser connection, or assert a submitted account identity.
let ownership, launchRequested = false, registered = false, released = false, completeRequested = false;
const controller = new AbortController();
const stop = () => controller.abort();
async function completeIfReleased() {
  if (!ownership || completeRequested || (launchRequested && !released)) return;
  completeRequested = true;
  await ownership.send('complete');
}
try {
  if (process.env.DOUYIN_WORK_AUTHOR_CANDIDATE_ENABLED !== '1') throw Object.assign(new Error(), { code: 'disabled' });
  ownership = collectorOwnershipClient();
  if (!ownership) throw Object.assign(new Error(), { code: 'ownership_required' });
  await ownership.send('hello');
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
  const data = await collectDouyinWorkAuthorCandidate(payload, { enabled: true, timeoutMs: 45_000,
    runtime: { ownership: trackedOwnership }, signal: controller.signal });
  await completeIfReleased();
  process.stdout.write(JSON.stringify({ ok: true, data }));
  // The shared supervisor's success protocol requires a registered, released
  // browser. Prelaunch unavailable results must exit nonzero, not pretend a
  // release occurred or turn a harmless session failure into a locked lane.
  if (!registered || !released || data.errorCode === 'cleanup_uncertain') process.exitCode = 1;
} catch (error) {
  try { await completeIfReleased(); } catch { /* Parent retains uncertainty; never claim duplicate completion. */ }
  const errorCode = ['disabled', 'ownership_required', 'invalid_input'].includes(error?.code) ? error.code : 'collector_error';
  process.stdout.write(JSON.stringify({ ok: false, errorCode }));
  process.exitCode = 1;
} finally {
  process.off('SIGTERM', stop);
  if (process.connected) process.disconnect();
}

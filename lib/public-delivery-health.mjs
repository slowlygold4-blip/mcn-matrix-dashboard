// Visitor-oriented readback, independent of successful upload/activation.
// One configured runtime network is evidence, never a worldwide guarantee.
import { createHash } from 'node:crypto';
import { PUBLIC_REPLICA_ORIGIN } from './public-replica-sync.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const SHA = /^[a-f0-9]{64}$/;
const title = /<title[^>]*>\s*MCN\s+矩阵数据台\s*<\/title>/i;
const failure = code => Object.assign(new Error(code), { code });
async function boundedText(response, limit) {
  if (!response.body?.getReader) throw failure('invalid-response');
  const reader = response.body.getReader(), parts = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw failure('response-too-large');
      parts.push(next.value);
    }
    return Buffer.concat(parts).toString('utf8');
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
}
export async function inspectPublicDelivery({ asOf, manifestSha256 } = {}, {
  fetchImpl = globalThis.fetch, signal, clock = () => new Date().toISOString(),
} = {}) {
  let checkedAt; try { checkedAt = clock(); } catch { checkedAt = null; }
  const result = { version: 1, asOf: iso(asOf) ? asOf : null, checkedAt: iso(checkedAt) ? checkedAt : null,
    scope: 'single-configured-runtime-network', requestMode: 'anonymous',
    guaranteesAllNetworks: false, browserVerified: false, dataPartitionsVerified: false, networkRequests: 0, checks: [] };
  const done = (status, code) => ({ ...result, status, code });
  if (!iso(asOf) || typeof manifestSha256 !== 'string' || !SHA.test(manifestSha256) || !iso(checkedAt)) return done('unavailable', 'invalid-input');
  const deadline = AbortSignal.timeout(20_000);
  const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (const route of ['homepage', 'current-manifest']) {
    if (operationSignal.aborted) return done('unavailable', signal?.aborted ? 'aborted' : 'timeout');
    const check = { route, httpStatus: null }; result.checks.push(check);
    try {
      const url = new URL(route === 'homepage' ? '/' : '/api/replica', PUBLIC_REPLICA_ORIGIN);
      result.networkRequests++;
      // Never obtain or pass an upload credential, Cookie or browser identity.
      const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', cache: 'no-store', credentials: 'omit',
        signal: AbortSignal.any([operationSignal, AbortSignal.timeout(10_000)]) });
      check.httpStatus = response.status;
      if (response.status !== 200) {
        const ray = response.headers.get('cf-ray');
        if (/^[a-f0-9]{16,32}-[A-Z]{3}$/i.test(ray ?? '')) check.cloudflareRayId = ray;
        if (response.status === 403) {
          // Extract only known numeric diagnostics. Never persist raw block
          // pages, arbitrary error text, IPs, URLs or headers.
          try { const text = await boundedText(response, 16 * 1024);
            if (/error\s*code\s*:\s*1010\b/i.test(text)) check.edgeErrorCode = 1010;
            else if (/error\s*code\s*:\s*1020\b/i.test(text)) check.edgeErrorCode = 1020;
          } catch { /* HTTP status remains authoritative if body is too large. */ }
        } else await response.body?.cancel().catch(() => {});
        return done([401, 403].includes(response.status) ? 'blocked' : 'unavailable',
          [401, 403].includes(response.status) ? 'anonymous-access-denied'
            : response.status === 429 ? 'rate-limited' : response.status >= 300 && response.status < 400 ? 'redirected' : 'http-error');
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (route === 'homepage') {
        if (type !== 'text/html') { await response.body?.cancel().catch(() => {}); return done('mismatch', 'homepage-not-html'); }
        const body = await boundedText(response, 256 * 1024);
        if (!/<html\b/i.test(body) || !title.test(body)) return done('mismatch', 'homepage-fingerprint-mismatch');
        check.applicationTitleVerified = true;
      } else {
        if (type !== 'application/json') { await response.body?.cancel().catch(() => {}); return done('mismatch', 'manifest-not-json'); }
        let body; try { body = JSON.parse(await boundedText(response, 8_000_000)); }
        catch (e) { if (e.code === 'response-too-large') throw e; throw failure('invalid-manifest'); }
        if (!body || body.readOnly !== true || body.collectionRequiresLocalComputer !== true || !iso(body.publishedAt)
          || body.manifest?.asOf !== asOf || digest(JSON.stringify(body.manifest)) !== manifestSha256) return done('mismatch', 'current-generation-mismatch');
        check.currentGenerationVerified = true;
      }
    } catch (e) {
      const code = signal?.aborted ? 'aborted' : operationSignal.aborted || e.name === 'TimeoutError' ? 'timeout'
        : ['response-too-large', 'invalid-manifest', 'invalid-response'].includes(e.code) ? e.code : 'network-failed';
      return done('unavailable', code);
    }
  }
  return done('verified', null);
}

// An anonymous generation GET already refused by the server is itself evidence.
// Do not issue another probe or classify a credential-bearing POST as public
// visitor failure, nor treat pre-activation draft discovery as a visitor read.
// The immutable generation remains owned by the sync layer.
export function publicDeliveryFromSyncFailure(sync, checkedAt) {
  const failure = sync?.transportFailure, status = failure?.httpStatus;
  if (sync?.status !== 'failed' || !iso(sync.asOf) || !iso(checkedAt) || failure?.kind !== 'http'
    || failure.method !== 'GET' || failure.phase !== 'readback' || sync.activated !== true || !Number.isInteger(status) || status < 400 || status > 599) return null;
  return { version: 1, asOf: sync.asOf, checkedAt, scope: 'single-configured-runtime-network',
    requestMode: 'anonymous', guaranteesAllNetworks: false, browserVerified: false, dataPartitionsVerified: false,
    status: [401,403].includes(status) ? 'blocked' : 'unavailable',
    code: [401,403].includes(status) ? 'anonymous-access-denied' : status === 429 ? 'rate-limited' : 'http-error',
    evidence: 'existing-anonymous-generation-readback', networkRequests: 0,
    checks: [{ route: 'generation-manifest-or-part', httpStatus: status }] };
}

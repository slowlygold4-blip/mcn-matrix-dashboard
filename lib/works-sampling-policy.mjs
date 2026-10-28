// Pure selection policy. Candidates come from the immutable ledger verifier;
// no timestamp, cursor or caller-supplied mode creates source authority here.
export const WORKS_HEAD_INTERVAL_MS = 8 * 60 * 60_000;

export function selectWorksSampling(rows, identity, asOf, resume) {
  const accepted = rows.filter(row => row.status === 'accepted'
    && row.raw.identity.secUid === identity.secUid && row.raw.identity.uid === identity.uid);
  const head = accepted.find(row => !row.raw.continuation
    && row.raw.pagination?.pages?.[0]?.requestCursor === 0);
  const headFresh = Boolean(head && Date.parse(asOf) - Date.parse(head.request_finished_at) < WORKS_HEAD_INTERVAL_MS);
  // An independently verified new head must not erase a still-resumable older
  // historical chain. A terminal head needs no additional historical request.
  const terminalHead = head?.raw.pagination?.stopReason === 'end-of-list';
  const previousBackfill = accepted.find(row => row.raw.continuation);
  const continuation = terminalHead ? null : resume(previousBackfill) ?? resume(accepted[0]);
  return { headFresh, lastHeadAt: head?.request_finished_at ?? null, continuation,
    samplingMode: headFresh ? continuation ? 'backfill' : null : 'head' };
}

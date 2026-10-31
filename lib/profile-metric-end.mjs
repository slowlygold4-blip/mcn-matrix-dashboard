// One independently observed profile counter at a day end. No storage writes.
// Callers validate identity/provenance and convert the timestamp to an instant.
export function selectProfileMetricEnd(previous, {stamp, value, sourceChecksum = null}) {
  if (!Number.isSafeInteger(stamp) || Math.abs(stamp) > 8_640_000_000_000_000
    || !Number.isSafeInteger(value) || value < 0) return previous ?? null;
  if (!previous || stamp > previous.stamp) return {stamp, value, sourceChecksum, conflict: false};
  if (stamp < previous.stamp) return previous;
  if (previous.conflict || previous.value !== value) return {...previous, value: null, sourceChecksum: null, conflict: true};
  // Same value/time can have multiple genuine source receipts. Keep the last
  // receipt supplied by the caller's stable order, without changing the value.
  return {...previous, sourceChecksum: sourceChecksum ?? previous.sourceChecksum};
}

// Keep contradictory instants as explicit barriers. Filtering their null
// value later would silently fall back to an older observation or baseline.
export function profileMetricPoints(samples, field) {
  const points = new Map();
  for (const sample of samples) {
    if (sample.quality_status === 'rejected') continue;
    const stamp = Date.parse(sample.captured_at), previous = points.get(stamp);
    const end = selectProfileMetricEnd(previous?.end, {stamp, value: sample[field], sourceChecksum: sample.source_checksum});
    if (!end || end === previous?.end) continue;
    points.set(stamp, {end, sample});
  }
  return [...points.values()].sort((a, b) => a.end.stamp - b.end.stamp).map(({end, sample}) => ({
    ...sample, captured_at: new Date(end.stamp).toISOString(), [field]: end.value,
    source_checksum: end.sourceChecksum, metricConflict: end.conflict,
  }));
}

// Read accepted, audit-bound profile observations. No collection or model calls.
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const fields = ['followers', 'total_likes'];
export function dailyProfileCoverage(db, enabled, now) {
  const end = Date.parse(now);
  if (!Number.isFinite(end)) throw Error('invalid telemetry clock');
  const required = {
    snapshots: ['target_id','captured_at','followers','total_likes','quality_status','account_status','source_checksum'],
    audits: ['run_id','target_id','source_checksum','status','created_at'],
    runs: ['id','started_at','finished_at'],
  };
  for (const [table, names] of Object.entries(required)) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (names.some(name => !columns.has(name))) return null;
  }
  const date = new Date(end + 8 * 3600000).toISOString().slice(0,10);
  const since = new Date(Date.parse(date + 'T00:00:00.000Z') - 8 * 3600000).toISOString();
  const previousSince = new Date(Date.parse(since) - 86400000).toISOString();
  const previousDate = new Date(Date.parse(date + 'T00:00:00.000Z') - 86400000).toISOString().slice(0,10);
  const targets = new Map(enabled.filter(row => row.type === 'account').map(row => [row.id,row.platform]));
  const empty = () => ({observed:0,comparable:0,missingBaseline:0,conflicting:0});
  const platforms = new Map();
  for (const platform of targets.values()) {
    const row = platforms.get(platform) ?? {platform,accounts:0,followers:empty(),totalLikes:empty()};
    row.accounts++; platforms.set(platform,row);
  }
  // A valid follower observation does not require a valid total-like/post count.
  // Actual instants, not string order, determine days and ties across offsets.
  // Filter unsafe SQLite integers before Node converts them; one corrupt metric
  // must not break telemetry or discard the other independent valid counter.
  const safeColumn = field => `CASE WHEN typeof(s.${field}) IN('integer','real')
    AND s.${field} BETWEEN 0 AND 9007199254740991 AND CAST(s.${field} AS INTEGER)=s.${field}
    THEN CAST(s.${field} AS INTEGER) END ${field}`;
  const accepted = db.prepare(`SELECT s.target_id targetId,strftime('%Y-%m-%dT%H:%M:%fZ',s.captured_at) capturedAt,${fields.map(safeColumn).join(',')}
    FROM snapshots s WHERE s.target_id IN(SELECT value FROM json_each(?))
    AND julianday(s.captured_at)>=julianday(?) AND julianday(s.captured_at)<=julianday(?)
    AND s.quality_status IN('validated','warning') AND s.account_status IN('available','partial')
    AND s.source_checksum IS NOT NULL AND s.source_checksum<>''
    AND EXISTS(SELECT 1 FROM audits a JOIN runs r ON r.id=a.run_id
      WHERE a.target_id=s.target_id AND a.source_checksum=s.source_checksum
      AND a.status IN('validated','warning') AND julianday(r.started_at)<=julianday(s.captured_at)
      AND julianday(s.captured_at)<=julianday(a.created_at)
      AND julianday(a.created_at)<=julianday(COALESCE(r.finished_at,?))
      AND julianday(COALESCE(r.finished_at,?))<=julianday(?))`)
    .iterate(JSON.stringify([...targets.keys()]),previousSince,now,now,now,now);
  const last = new Map();
  for (const row of accepted) {
    const stamp = Date.parse(row.capturedAt);
    if (!Number.isFinite(stamp)) continue;
    const day = stamp >= Date.parse(since) ? 'today' : 'previous';
    for (const field of fields) {
      if (!validCount(row[field])) continue;
      const key = `${row.targetId}:${field}:${day}`, old = last.get(key);
      if (!old || stamp > old.stamp) last.set(key,{stamp,value:row[field],conflict:false});
      else if (stamp === old.stamp && row[field] !== old.value) old.conflict = true;
    }
  }
  for (const [id,platform] of targets) for (const field of fields) {
    const metric = platforms.get(platform)[field === 'followers' ? field : 'totalLikes'];
    const today = last.get(`${id}:${field}:today`), previous = last.get(`${id}:${field}:previous`);
    if (today?.conflict) metric.conflicting++;
    else if (today) {
      metric.observed++;
      if (previous && !previous.conflict) metric.comparable++;
      else metric.missingBaseline++;
    }
  }
  return {version:1,basis:'accepted-profile-day-ends',date,since,previousDate,asOf:now,platforms:[...platforms.values()]};
}

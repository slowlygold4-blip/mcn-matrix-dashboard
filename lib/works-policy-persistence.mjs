/** Read-only restoration input for endpoint waits. Read clocks before payloads:
 * sorting full snapshot JSON would reparse historical work bodies per target.
 * This iterator owns only a short read transaction unless its caller has one.
 */
export function* readPersistedWorksRequestPolicies(db, reference) {
  if(typeof reference!=='string'||!Number.isFinite(Date.parse(reference)))throw Error('invalid-policy-reference');
  const own=!db.isTransaction;
  if(own)db.exec('BEGIN');
  try{
    const candidates=db.prepare(`SELECT id FROM snapshots WHERE target_id=?
      AND julianday(captured_at)<=julianday(?)
      ORDER BY julianday(captured_at) DESC,id DESC`);
    const expression=`CASE WHEN json_valid(raw_json) THEN
      CASE WHEN json_extract(raw_json,'$.worksRequestPolicy.version')=1
        AND json_extract(raw_json,'$.worksRequestPolicy.endpoint')='douyin.author_posts'
        AND json_extract(raw_json,'$.worksRequestPolicy.scope')='endpoint-transport'
      THEN json_extract(raw_json,'$.worksRequestPolicy') END END`;
    const profilePolicy=db.prepare(`SELECT ${expression} policy FROM snapshots WHERE id=?`);
    const latest=db.prepare(`SELECT t.id target_id,s.id snapshot_id,${expression} policy
      FROM targets t LEFT JOIN snapshots s ON s.id=(SELECT id FROM snapshots
        WHERE target_id=t.id AND julianday(captured_at)<=julianday(?)
        ORDER BY julianday(captured_at) DESC,id DESC LIMIT 1)
      WHERE t.type='account' AND t.provider='public-web'`);
    for(const target of latest.iterate(reference)){
      if(target.policy!=null){yield target.policy;continue;}
      if(target.snapshot_id==null)continue;
      // The common latest-policy path is one streaming query; only legacy
      // compatibility snapshots without a policy need historical payloads.
      for(const row of candidates.iterate(target.target_id,reference)){
        if(row.id===target.snapshot_id)continue;
        const found=profilePolicy.get(row.id);
        if(found?.policy!=null){yield found.policy;break;}
      }
    }
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='works_observations'").get()){
      const ledger=db.prepare(`SELECT id FROM works_observations WHERE
          julianday(observed_at)<=julianday(?) AND julianday(created_at)<=julianday(?)
          AND julianday(observed_at)<=julianday(created_at)
        ORDER BY julianday(observed_at) DESC,id DESC`);
      const read=db.prepare(`SELECT json_valid(raw_json) valid,
        CASE WHEN json_valid(raw_json) THEN json_extract(raw_json,'$.worksRequestPolicy') END policy
        FROM works_observations WHERE id=?`);
      let accepted=0;
      for(const item of ledger.iterate(reference,reference)){
        const row=read.get(item.id);if(!row?.valid)continue;
        yield row.policy;if(++accepted===1000)break;
      }
    }
    const runs=db.prepare(`SELECT id FROM runs WHERE trigger_type='works-only'
        AND julianday(started_at)<=julianday(?)
        AND (finished_at IS NULL OR (julianday(finished_at)>=julianday(started_at)
          AND julianday(finished_at)<=julianday(?)))
      ORDER BY julianday(started_at) DESC,id DESC`);
    const readRun=db.prepare(`SELECT json_valid(details_json) valid,
      CASE WHEN json_valid(details_json) THEN json_extract(details_json,'$[0].requestPolicy') END policy
      FROM runs WHERE id=?`);
    let accepted=0;
    for(const item of runs.iterate(reference,reference)){
      const row=readRun.get(item.id);if(!row?.valid)continue;
      yield row.policy;if(++accepted===1000)break;
    }
  }finally{if(own)db.exec('ROLLBACK');}
}

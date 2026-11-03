// A bounded list of this account's already-stored public works. This is not
// an inventory or a claim about new publications. The HTTP reply must still
// independently bind both the requested BV and the expected author UID.
import {canonicalAccountLocator} from './author-spreadsheet.mjs';
export const BILIBILI_KNOWN_WORK_LIMIT=6;
export function readKnownBilibiliWorks(database,target,mid){
 const db=database?.db??database;
 if(!db?.prepare||!Number.isSafeInteger(target?.id)||!/^\d{2,20}$/.test(mid??'')
  ||canonicalAccountLocator(target.locator,'bilibili')!==`bilibili:${mid}`)return [];
 const rows=db.prepare(`WITH attempts AS (
  SELECT j.value external_id,MAX(julianday(s.captured_at)) attempted_at
  FROM snapshots s,json_each(CASE WHEN json_valid(s.raw_json) THEN s.raw_json ELSE '{}' END,'$.knownWorksEvidence.attemptedIds') j
  WHERE s.target_id=? AND s.quality_status IN('validated','warning') AND j.type='text'
   AND julianday(s.captured_at)<=julianday(?)
   AND json_extract(s.raw_json,'$.knownWorksEvidence.version')=1
   AND json_extract(s.raw_json,'$.knownWorksEvidence.source')='stored-account-work-ids'
  GROUP BY j.value)
 SELECT p.external_id,MAX(COALESCE(MAX(julianday(m.captured_at)),0),COALESCE(a.attempted_at,0)) last_checked
  FROM posts p JOIN targets t ON t.id=p.target_id
  LEFT JOIN post_metrics m ON m.post_id=p.id AND m.likes IS NOT NULL
  LEFT JOIN attempts a ON a.external_id=p.external_id
  WHERE p.target_id=? AND p.author_id=? AND t.enabled=1 AND t.type='account'
   AND t.provider='public-web' AND json_extract(t.metadata_json,'$.platform')='bilibili'
   AND length(p.external_id)=12 AND p.external_id GLOB 'BV*'
  GROUP BY p.id ORDER BY last_checked,p.id LIMIT ?`)
  .all(target.id,new Date().toISOString(),target.id,mid,BILIBILI_KNOWN_WORK_LIMIT);
 return rows.map(r=>r.external_id).filter(id=>/^BV[0-9A-Za-z]{10}$/.test(id));
}

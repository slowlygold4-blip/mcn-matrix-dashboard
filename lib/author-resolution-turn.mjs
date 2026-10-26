/** Share the existing two-item turn between full-roster onboarding and the
 * general retry queue. The database still enforces per-identity cooldowns,
 * leases and fairness; no timestamps or old attempts are rewritten. */
export function claimAuthorResolutionTurn(database,options) {
 const source=database.claimDueAuthorResolutions(1,{...options,fileName:'一条小团团切片作品登记表-来源数据集'});
 try {
  const rest=database.claimDueAuthorResolutions(2-source.length,{...options,excludeIds:source.map(row=>row.id)});
  return [...source,...rest];
 } catch(error) {
  for(const row of source) database.db.prepare('UPDATE author_resolution_queue SET lease_owner=NULL,lease_until=NULL WHERE id=? AND evidence_version=? AND lease_owner=?').run(row.id,row.evidence_version,options.owner);
  throw error;
 }
}

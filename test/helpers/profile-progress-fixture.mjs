// Counter evidence for telemetry tests; batch flags alone are not observations.
export function saveProfileProgressFixture(db,targetId,runId,at){
 db.exec(`CREATE TABLE IF NOT EXISTS audits(run_id INTEGER,target_id INTEGER,source_checksum TEXT,status TEXT,created_at TEXT);
 CREATE TABLE IF NOT EXISTS snapshots(target_id INTEGER,source_checksum TEXT,quality_status TEXT,captured_at TEXT,account_status TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER);`);
 const proof=`fixture-${runId}-${targetId}`;
 db.prepare("INSERT INTO snapshots(target_id,source_checksum,quality_status,captured_at,account_status,followers,total_likes,total_posts) VALUES(?,?,'validated',?,'available',0,0,0)").run(targetId,proof,at);
 db.prepare("INSERT INTO audits(run_id,target_id,source_checksum,status,created_at) VALUES(?,?,?,'validated',?)").run(runId,targetId,proof,at);
}

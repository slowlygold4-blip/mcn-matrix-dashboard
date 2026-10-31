/** Read-only, deterministic product audit. No browser, upstream requests or model calls. */
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {collectionProgress} from '../lib/collection-progress.mjs';
import {inspectSourcePollManifest} from '../lib/source-poller-status.mjs';

async function readJson(path) {
 try{return JSON.parse(await readFile(path,'utf8'));}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
}
const statusCounts=rows=>rows.reduce((counts,row)=>{const status=row?.lastStatus??'unknown';counts[status]=(counts[status]??0)+1;return counts;},{});
const count=(db,query)=>Number(db.prepare(query).get().n);

export async function auditProductState({dataDirectory,now=new Date().toISOString()}) {
 const db=new DatabaseSync(join(dataDirectory,'douyin-monitor.sqlite'),{readOnly:true});
 let report;
 try{
  db.exec('PRAGMA query_only=ON; BEGIN');
  report={version:1,checkedAt:now,readOnly:true,runtimeAI:false,
   collection:collectionProgress(db,{now}),
   invariants:{
    duplicateEnabledAccountLocators:count(db,"SELECT COUNT(*) n FROM (SELECT provider,locator FROM targets WHERE type='account' AND enabled=1 GROUP BY provider,locator HAVING COUNT(*)>1)"),
    duplicateWorksWithinAccount:count(db,"SELECT COUNT(*) n FROM (SELECT target_id,external_id FROM posts GROUP BY target_id,external_id HAVING COUNT(*)>1)"),
    sameWorkMultipleEnabledAccounts:count(db,"SELECT COUNT(*) n FROM (SELECT p.external_id FROM posts p JOIN targets t ON t.id=p.target_id WHERE t.type='account' AND t.enabled=1 AND p.external_id<>'' GROUP BY p.external_id HAVING COUNT(DISTINCT p.target_id)>1)"),
    negativeAccountCounters:count(db,'SELECT COUNT(*) n FROM snapshots WHERE followers<0 OR total_likes<0 OR total_posts<0'),
    futureSnapshots:Number(db.prepare('SELECT COUNT(*) n FROM snapshots WHERE julianday(captured_at)>julianday(?)').get(now).n),
   },
   dailyStoredRecords:db.prepare(`SELECT date(captured_at,'+8 hours') date,
    COUNT(*) records,COUNT(DISTINCT CASE WHEN followers IS NOT NULL THEN target_id END) followerAccounts,
    COUNT(DISTINCT CASE WHEN total_likes IS NOT NULL THEN target_id END) likeAccounts,
    COUNT(DISTINCT CASE WHEN total_posts IS NOT NULL THEN target_id END) workCountAccounts
    FROM snapshots WHERE quality_status IN ('validated','warning')
    AND julianday(captured_at)>=julianday(?) AND julianday(captured_at)<=julianday(?) GROUP BY 1 ORDER BY 1`)
    .all(new Date(Date.parse(now)-7*86400000).toISOString(),now),
   recordCounts:Object.fromEntries(['targets','posts','post_metrics','snapshots','creator_source_rows'].map(table=>[table,count(db,`SELECT COUNT(*) n FROM ${table}`)])),
   limits:['Daily stored-record counts are not proof of raw-source identity or complete works coverage.','Topic and account observations have separate denominators.'],
  };
 }finally{try{db.exec('ROLLBACK');}finally{db.close();}}
 const sources=await readJson(join(dataDirectory,'source-poll/manifest.json'));
 const inventory=inspectSourcePollManifest(join(dataDirectory,'source-poll/manifest.json'),{
  now:new Date(now),registryPath:join(dataDirectory,'source-poll/registry.json')});
 report.sources={lastFinishedAt:sources?.lastFinishedAt??null,
  registered:inventory.error?null:inventory.registrySourceCount,
  manifestEntries:Object.keys(sources?.sources??{}).length,
  inventoryCount:inventory.sourceCount,manifestOnlyCount:inventory.manifestOnlyCount??null,
  inventoryStatus:inventory.status,...(inventory.error?{error:inventory.error}:{}),
  statuses:statusCounts(inventory.sources),inventoryDefinition:inventory.inventoryDefinition??null};
 const sync=await readJson(join(dataDirectory,'creator-source-sync/status.json'));
 report.sourceDataset={checkedAt:sync?.checkedAt??null,status:sync?.status??'unknown',revision:sync?.revision??null};
 const publisher=await readJson(join(dataDirectory,'public-replica-publisher/state.json'));
 const checkpoint=await readJson(join(dataDirectory,'public-replica-publisher/checkpoint.json'));
 report.publication={lastResult:publisher?.status??'unknown',lastErrorCode:publisher?.code??null,publishedAsOf:publisher?.publishedAsOf??null,stagedAsOf:publisher?.active?.asOf??null,
  checkpointAsOf:checkpoint?.asOf??null,uploadedBatches:checkpoint?.completedBatches?.length??0,totalBatches:checkpoint?.batchSha256?.length??0,activated:checkpoint?.activated??false};
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const dataDirectory=resolve(process.env.DATA_DIR||new URL('../data/',import.meta.url).pathname);
 const result=await auditProductState({dataDirectory});
 const flag=process.argv.indexOf('--out');
 if(flag>=0){const out=resolve(process.argv[flag+1]);await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(result,null,2)+'\n');}
 console.log(JSON.stringify({checkedAt:result.checkedAt,readOnly:result.readOnly,runtimeAI:result.runtimeAI,
  collection:result.collection.rolling,dailyProfiles:result.collection.dailyProfiles,dailyWorkLikes:result.collection.dailyWorkLikes,
  invariants:result.invariants,sources:result.sources,publication:result.publication,
  exitCodeBasis:'structural-invariants-only-not-daily-monitoring-completion'}));
 process.exitCode=Object.values(result.invariants).some(value=>value>0)?1:0;
}

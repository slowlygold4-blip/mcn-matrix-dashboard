import {DatabaseSync} from 'node:sqlite';
import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {readWorksOnlyAnchor} from '../lib/works-only-observation.mjs';
import {normalizeRemoteWorkPage,recordRemoteWorkPage} from '../lib/remote-work-observation.mjs';

// Operator-owned captured receipt only. This command makes no network/model
// calls and cannot start a collector or silently enable a remote service.
const args=process.argv.slice(2);
const extra=args.slice(4);
const commit=extra.at(-1)==='--commit';
const sourceArgs=commit?extra.slice(0,-1):extra;
const options=sourceArgs.length===2&&sourceArgs[0]==='--source-origin'?{sourceOrigin:sourceArgs[1]}:{};
if(args.length<4||args[0]!=='--receipt'||args[2]!=='--database'
 ||!(sourceArgs.length===0||(sourceArgs.length===2&&sourceArgs[0]==='--source-origin'))){
 console.error('Usage: node scripts/admit-remote-work-page.mjs --receipt PATH --database PATH [--source-origin HTTPS_ORIGIN] [--commit]');
 process.exitCode=2;
}else{
 let db;
 try{
  const receiptPath=resolve(args[1]),databasePath=resolve(args[3]);
  if(!statSync(receiptPath).isFile()||statSync(receiptPath).size>1024*1024||!statSync(databasePath).isFile())throw new Error('invalid files');
  const input=JSON.parse(readFileSync(receiptPath,'utf8'));
  db=new DatabaseSync(databasePath,{readOnly:!commit});
  if(commit)db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=3000');
  const result=commit?recordRemoteWorkPage(db,input,options):{
   dryRun:true,postCount:normalizeRemoteWorkPage(input.receipt,readWorksOnlyAnchor(db,input.targetId),options).posts.length,
   coverage:'limited',databaseWrites:0};
  console.log(JSON.stringify({...result,runtimeAI:false,automaticCollectionEnabled:false}));
 }catch(error){
  console.error(JSON.stringify({status:'not-admitted',code:['REMOTE_WORK_OBSERVATION_INVALID','WORKS_OBSERVATION_INVALID',
   'COLLECTION_HISTORY_AUTHOR_CONFLICT','COLLECTION_HISTORY_METRIC_CONFLICT'].includes(error.code)?error.code:'RECEIPT_ADMISSION_FAILED'}));
  process.exitCode=1;
 }finally{db?.close();}
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';

test('real CLI keeps custom-source preview read-only, requires separate approval, and commits exactly once',t=>{
 const dir=mkdtempSync(join(tmpdir(),'mcn-admission-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const databasePath=join(dir,'monitor.sqlite'),receiptPath=join(dir,'receipt.json');
 const database=new MonitorDatabase(databasePath);
 const sec='MS4wLjABAAAAApprovedCliFixture12345',uid='123456789';
 const target=database.createTarget({type:'account',provider:'public-web',label:'fixture',locator:sec});
 const now=Date.now(),at=new Date(now-10_000).toISOString();
 const raw={capturedAt:at,accountStatus:'validated',accountError:null,
  profile:{user:{sec_uid:sec,uid,follower_count:12,total_favorited:33,aweme_count:3}},
  worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},
  provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',
   profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
 database.saveCollection(target,null,normalizeCollection(target,raw,{capturedAt:at}));database.close();
 const origin='https://reviewed-service.example';
 writeFileSync(receiptPath,JSON.stringify({targetId:target.id,sourceOrigin:origin,receipt:{source:origin,httpStatus:200,
  requestStartedAt:new Date(now-2_000).toISOString(),requestFinishedAt:new Date(now-1_000).toISOString(),
  meta:{endpoint:'douyin.author_posts',cached:false,request_id:'cli-fixture',guest_fallback:true},data:{has_more:true,cursor:'opaque-next',items:[{
   platform:'douyin',content_id:'7300000000000000001',created_at:null,fetched_at:new Date(now-1_500).toISOString(),
   author:{sec_uid:sec,uid:sec},is_deleted:false,is_private:false,stats:{digg_count:0}}]}}}));
 const script=fileURLToPath(new URL('../scripts/admit-remote-work-page.mjs',import.meta.url));
 const run=(...extra)=>spawnSync(process.execPath,[script,'--receipt',receiptPath,'--database',databasePath,...extra],{encoding:'utf8',timeout:10_000});
 const stored=()=>{const db=new DatabaseSync(databasePath,{readOnly:true});try{return {
  metrics:db.prepare('SELECT likes,plays FROM post_metrics').all().map(r=>({...r})),
  events:db.prepare("SELECT COUNT(*) n FROM account_events WHERE event_type='remote-work-observation'").get().n,
  profiles:db.prepare('SELECT COUNT(*) n FROM snapshots').get().n};}finally{db.close();}};
 assert.equal(run().status,1,'receipt sourceOrigin is not operator approval');
 const preview=run('--source-origin',origin);assert.equal(preview.status,0,preview.stderr);
 assert.deepEqual(JSON.parse(preview.stdout),{dryRun:true,postCount:1,listEvidence:{version:1,guestFallback:true,cursorPresent:true,cursor:'opaque-next'},coverage:'limited',databaseWrites:0,runtimeAI:false,automaticCollectionEnabled:false});
 assert.deepEqual(stored(),{metrics:[],events:0,profiles:1});
 const commit=run('--source-origin',origin,'--commit');assert.equal(commit.status,0,commit.stderr);
 assert.equal(JSON.parse(commit.stdout).duplicate,false);
 const replay=run('--source-origin',origin,'--commit');assert.equal(replay.status,0,replay.stderr);
 assert.equal(JSON.parse(replay.stdout).duplicate,true);
 assert.deepEqual(stored(),{metrics:[{likes:0,plays:null}],events:1,profiles:1});
 const credentials=run('--source-origin','https://user:SECRET@reviewed-service.example','--commit');
 assert.equal(credentials.status,1);assert.equal(credentials.stderr.includes('SECRET'),false);
 assert.equal(run('--source-origin',origin,'--commit','--commit').status,2);
 assert.equal(run('--commit','--source-origin',origin).status,2);
 assert.deepEqual(stored(),{metrics:[{likes:0,plays:null}],events:1,profiles:1});
});

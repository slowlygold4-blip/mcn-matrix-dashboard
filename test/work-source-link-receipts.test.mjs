import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {shortWorkLink,resolveWorkSourceLink,commitWorkLinkReceipt,readWorkLinkReceipts,bindWorkFactsToRedirects} from '../lib/work-source-link-receipts.mjs';
import {mergeWorkSourceFacts,workSourceFingerprint} from '../lib/work-source-overlay.mjs';
import {readPublicSourceMarker} from '../lib/public-source-marker.mjs';
import {pendingWorkSourceLinks,waitForWorkSourceBackup} from '../scripts/resolve-work-source-links.mjs';
import * as XLSX from '@e965/xlsx';
import {commitWorkSourceEdition} from '../lib/work-source-store.mjs';
const id='7684947825248082873',other='7692714095128218918',url='https://v.douyin.com/fixture/';
const hash=s=>createHash('sha256').update(s).digest('hex');
const now=()=>Date.parse('2026-10-30T23:00:00.000Z');
const base={sheet:'登记',row:2,contentId:null,url,evidenceUrls:[url],likes:0,plays:7,metricDate:null,publishedOn:null,representation:{likes:'integer',plays:'integer'},metricIssues:[],identityIssues:[]};
function database(){
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE work_source_fact_blobs(sha256 TEXT PRIMARY KEY,fact_json TEXT,content_id TEXT);
 CREATE TABLE work_source_versions(id INTEGER PRIMARY KEY,committed_at TEXT);
 CREATE TABLE work_source_version_facts(version_id INTEGER,fact_sha256 TEXT,ordinal INTEGER);
 INSERT INTO work_source_versions VALUES(5,'2026-10-30T22:00:00.000Z');`);
 const json=JSON.stringify(base),sha=hash(json);db.prepare('INSERT INTO work_source_fact_blobs VALUES(?,?,NULL)').run(sha,json);
 db.prepare('INSERT INTO work_source_version_facts VALUES(5,?,0)').run(sha);
 return {db,sha};
}
const response=(status=302,location=`https://www.iesdouyin.com/share/video/${id}/?share_sign=never-retain`)=>new Response(null,{status,headers:location?{location}:{}});
async function receipt(sha,options={}){
 return resolveWorkSourceLink({url,sourceVersionId:5,sourceFactSha256:sha,now,fetchImpl:async()=>response(),...options});
}

test('only exact official short URLs are requested, with no cookies, auto redirects or body read',async()=>{
 for(const bad of ['http://v.douyin.com/abc/','https://v.douyin.com.evil.test/abc/','https://u:p@v.douyin.com/abc/',url+'?x=1',url+'#x','https://127.0.0.1/abc/','https://v.douyin.com:444/abc/'])assert.equal(shortWorkLink(bad),null);
 let calls=0,cancelled=0;const r=await receipt('a'.repeat(64),{fetchImpl:async(input,options)=>{
   calls++;assert.equal(input,url);assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');
   assert.equal(Object.keys(options.headers).some(k=>/cookie|authorization/i.test(k)),false);
   return {status:302,headers:new Headers({location:`https://www.iesdouyin.com/share/video/${id}/?share_sign=secret`}),body:{cancel:async()=>{cancelled++;}}};
 }});
 assert.equal(calls,1);assert.equal(cancelled,1);assert.equal(r.status,'resolved');assert.equal(r.contentId,id);
 assert.equal(r.redirectUrl,`https://www.iesdouyin.com/share/video/${id}/`);assert.ok(!JSON.stringify(r).includes('secret'));
 assert.equal(r.bodyRead,false);assert.equal(r.modelCalls,0);
});

test('denials, untrusted or conflicting redirects, HTML and transport failures never supply an ID',async()=>{
 for(const [status,location,expected] of [[403,null,'http_403'],[429,null,'http_429'],[401,null,'http_401'],[200,null,'no_redirect'],
  [302,'https://evil.test/video/'+id,'invalid_redirect'],[302,`https://www.douyin.com/video/${id}?modal_id=${other}`,'invalid_redirect'],
  [302,'http://www.douyin.com/video/'+id,'invalid_redirect'],[302,`https://www.douyin.com@evil.test/video/${id}`,'invalid_redirect'],[302,'http://[','invalid_redirect']]){
   let calls=0;const r=await receipt('a'.repeat(64),{fetchImpl:async()=>{calls++;return response(status,location);}});
   assert.equal(calls,1);assert.equal(r.status,expected);assert.equal(r.contentId,null);assert.equal(r.redirectUrl,null);
 }
 assert.equal((await receipt('a'.repeat(64),{fetchImpl:async()=>{throw Error('private-cookie-error');}})).status,'network_error');
 const c=new AbortController();c.abort();await assert.rejects(receipt('a'.repeat(64),{signal:c.signal}),/cancelled/);
});

test('backup and exact source membership are mandatory; receipts append idempotently without rewriting facts',async()=>{
 const {db,sha}=database();try{
  const r=await receipt(sha);await assert.rejects(async()=>commitWorkLinkReceipt(db,r,{now}),/backup/);
  assert.throws(()=>commitWorkLinkReceipt(db,{...r,sourceFactSha256:'f'.repeat(64)},{now,backupValidated:true}),/source-proof/);
  assert.throws(()=>commitWorkLinkReceipt(db,{...r,requestedUrl:'https://v.douyin.com/other/'},{now,backupValidated:true}),/source-url/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_source_link_receipts'").get(),undefined);
  commitWorkLinkReceipt(db,r,{now,backupValidated:true});commitWorkLinkReceipt(db,r,{now,backupValidated:true});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM work_source_link_receipts').get().n,1);
  assert.equal(db.prepare('SELECT fact_json FROM work_source_fact_blobs').get().fact_json,JSON.stringify(base));
  assert.equal(readWorkLinkReceipts(db,{asOf:'2026-10-30T22:59:59Z'}).length,0);
  const rows=readWorkLinkReceipts(db,{asOf:'2026-10-30T23:00:00Z'});assert.equal(rows.length,1);
  assert.equal(rows[0].contentId,id);assert.equal(pendingWorkSourceLinks(db,{versionId:5,now}).length,0);
  db.prepare('UPDATE work_source_link_receipts SET content_id=?').run(other);
  assert.throws(()=>readWorkLinkReceipts(db,{asOf:'2026-10-30T23:00:00Z'}),/index-corrupt/);
 }finally{db.close();}
});

test('failed attempts have a 24 hour cooldown and are not successful bindings',async()=>{
 const {db,sha}=database();try{
  const r=await receipt(sha,{fetchImpl:async()=>response(403,null)});commitWorkLinkReceipt(db,r,{now,backupValidated:true});
  assert.equal(pendingWorkSourceLinks(db,{versionId:5,now}).length,0);
  assert.equal(pendingWorkSourceLinks(db,{versionId:5,now:()=>now()+24*3600000}).length,1);
  assert.equal(bindWorkFactsToRedirects([base],readWorkLinkReceipts(db,{asOf:'2026-10-30T23:00:00Z'})).facts[0].contentId,null);
 }finally{db.close();}
});

test('binding never invents authors, metric dates, publication dates or adds duplicate cumulative values',async()=>{
 const r={...await receipt('a'.repeat(64)),sha256:'b'.repeat(64)};
 const binding=bindWorkFactsToRedirects([base,base],[r]);assert.equal(binding.summary.boundWorkReferences,2);
 assert.ok(binding.facts.every(f=>f.contentId===id&&f.metricDate===null&&f.publishedOn===null&&f.authorIdentityVerified===false));
 const source={versions:[{sourceUrl:'source',report:{source:{title:'未知'}}}],facts:[{...base,sourceUrl:'source'},{...base,sourceUrl:'source'}],fingerprint:'fixture'};
 const merged=mergeWorkSourceFacts([],[],source,{linkReceipts:[r],baseModifiedAt:'2026-10-22T00:00:00.000Z'});
 assert.equal(merged.works.length,1);assert.equal(merged.works[0].cumulativeLikes,0);assert.equal(merged.works[0].cumulativePlays,7);
 assert.equal(merged.works[0].publishedOn,'');assert.equal(merged.works[0].authorKey,null);
 assert.equal(merged.works[0].sourceEditionEvidence[0].contentIdEvidence.receiptSha256,r.sha256);
 const conflict={...r,contentId:other,redirectUrl:`https://www.iesdouyin.com/share/video/${other}/`};
 assert.equal(bindWorkFactsToRedirects([base],[r,conflict]).summary.conflicts,1);
 assert.equal(bindWorkFactsToRedirects([{...base,contentId:other}],[r]).summary.conflicts,1);
});

test('only admitted successful receipts refresh source cache/public marker, respecting historical cutoffs',async()=>{
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 try{
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['发布链接','点赞'],[url,0]]),'登记');
  const meta={url:'https://fixture.feishu.cn/sheets/FixtureWorkbook123456',revision:1,modifiedAt:'2026-10-30T22:00:00.000Z',title:'登记',sheets:[{id:'sheet1',name:'登记',region:'A1:B2'}]};
  commitWorkSourceEdition(db,{buffer:XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),before:meta,after:meta,readAt:'2026-10-30T22:01:00.000Z'},
    {now:()=>Date.parse('2026-10-30T22:02:00.000Z')});
  const fact=db.prepare('SELECT sha256 FROM work_source_fact_blobs').get();
  const cutoff='2026-10-30T23:00:00.000Z';const fp=workSourceFingerprint(db,cutoff),marker=readPublicSourceMarker(db,cutoff);
  const denied=await receipt(fact.sha256,{sourceVersionId:1,fetchImpl:async()=>response(403,null)});
  commitWorkLinkReceipt(db,denied,{now,backupValidated:true});
  assert.equal(workSourceFingerprint(db,cutoff),fp);assert.equal(readPublicSourceMarker(db,cutoff),marker);
  const good=await receipt(fact.sha256,{sourceVersionId:1});
  commitWorkLinkReceipt(db,good,{now:()=>now()+60000,backupValidated:true});
  assert.equal(workSourceFingerprint(db,cutoff),fp);assert.equal(readPublicSourceMarker(db,cutoff),marker);
  assert.notEqual(workSourceFingerprint(db,'2026-10-30T23:01:00.000Z'),fp);
  assert.notEqual(readPublicSourceMarker(db,'2026-10-30T23:01:00.000Z'),marker);
 }finally{db.close();}
});

test('ordinary source writes yield to a live backup without deleting locks or retrying platform requests',async()=>{
 let reads=0,waits=0,notified=0;
 await waitForWorkSourceBackup({readOwner:async()=>++reads<3?{pid:42}:null,isAlive:()=>true,
  pause:async()=>{waits++;},onWaiting:async()=>{notified++;}});
 assert.equal(waits,2);assert.equal(notified,1);
 await waitForWorkSourceBackup({readOwner:async()=>({pid:42}),isAlive:()=>false,pause:async()=>{throw Error('should not wait');}});
 await assert.rejects(waitForWorkSourceBackup({readOwner:async()=>({pid:'42'})}),/lock-invalid/);
 let tick=0;
 await assert.rejects(waitForWorkSourceBackup({readOwner:async()=>({pid:42}),isAlive:()=>true,
  now:()=>tick,pause:async()=>{tick+=1000;},maxWaitMs:1000}),/backup-busy/);
 const c=new AbortController();c.abort();await assert.rejects(waitForWorkSourceBackup({signal:c.signal}),/cancelled/);
});

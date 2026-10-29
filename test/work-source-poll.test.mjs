import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkSourcePollReader } from '../lib/work-source-poll.mjs';

const source={sourceType:'lark-work-source',sourceUrl:'https://fixture.feishu.cn/sheets/FixtureWorkbook123456',
  readPolicy:'authorized-work-facts',kind:'work-statistics',title:'作品原表'};
const receipt={status:'imported',contentImported:true,versionId:1,sourceRevision:4,factCount:3,
  sourceSha256:'a'.repeat(64),sourceReadAt:'2026-10-29T02:00:00.000Z'};

test('work poll reader validates a backup once per changed batch, not once per source',async()=>{
  let verified=0;const seen=[];
  const read=createWorkSourcePollReader({dataDirectory:'/fixture',verifyBackup:async()=>{verified++;return {validated:true};},
    sync:async options=>{seen.push(options);await options.beforeCommit();return receipt;}});
  await read(source);await read({...source,sourceUrl:source.sourceUrl+'2'});
  assert.equal(verified,1);assert.equal(seen[0].mode,'commit');
  assert.equal(seen[0].databasePath,'/fixture/douyin-monitor.sqlite');
});

test('unchanged source does not perform a backup, author submission, or fresh observation',async()=>{
  const read=createWorkSourcePollReader({dataDirectory:'/fixture',verifyBackup:async()=>{throw Error('unexpected backup');},
    sync:async()=>({...receipt,status:'unchanged'})});
  assert.equal((await read(source)).sourceReadAt,receipt.sourceReadAt);
  await assert.rejects(read({...source,monitorOnly:true}),/policy-invalid/);
});

test('failed backup and incomplete source receipts remain failures',async()=>{
  let calls=0;
  const read=createWorkSourcePollReader({dataDirectory:'/fixture',verifyBackup:async()=>{calls++;throw Error('private-error');},
    sync:async options=>{await options.beforeCommit();return receipt;}});
  await assert.rejects(read(source),/backup-validation-failed/);
  await assert.rejects(read(source),/backup-validation-failed/);assert.equal(calls,1);
  const incomplete=createWorkSourcePollReader({dataDirectory:'/fixture',sync:async()=>({...receipt,contentImported:false})});
  await assert.rejects(incomplete(source),/receipt-invalid/);
});

test('existing poller persists whole-workbook editions without calling author-import HTTP',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'work-source-poller-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  process.env.DATA_DIR=directory;
  mkdirSync(join(directory,'source-poll'));
  writeFileSync(join(directory,'source-poll','registry.json'),JSON.stringify({sources:[source]}));
  const {pollOnce}=await import(`../scripts/source-poller.mjs?work-poll=${Date.now()}`);
  const session={headers:{},bootstrap:{authorSources:[]}};
  const first=await pollOnce({session,now:new Date('2026-10-29T02:00:00.000Z'),workSourceReader:async()=>receipt});
  assert.equal(first.changed,1);assert.equal(first.sources[0].contentImported,true);
  assert.equal(first.sources[0].sourceVersionId,1);assert.equal(first.sources[0].workFactCount,3);
  assert.equal(first.sources[0].readMode,'whole-workbook-facts');
  assert.equal(first.sources[0].lastJobId,undefined,'work facts never create an author job');
  const second=await pollOnce({session,now:new Date('2026-10-29T03:00:00.000Z'),workSourceReader:async()=>({...receipt,status:'unchanged'})});
  assert.equal(second.changed,0);assert.equal(second.sources[0].sourceReadAt,receipt.sourceReadAt);
  const saved=JSON.parse(readFileSync(join(directory,'source-poll','manifest.json'),'utf8'));
  const [row]=Object.values(saved.sources);assert.equal(row.lastStatus,'unchanged');
  assert.equal(row.lastCheckedAt,'2026-10-29T03:00:00.000Z');
  const failure=await pollOnce({session,now:new Date('2026-10-29T04:00:00.000Z'),workSourceReader:async()=>{throw Error('source-clock-order-invalid');}});
  assert.equal(failure.sources[0].lastStatus,'failed');assert.equal(failure.sources[0].sourceVersionId,1);
  assert.equal(failure.sources[0].sourceReadAt,receipt.sourceReadAt);
});

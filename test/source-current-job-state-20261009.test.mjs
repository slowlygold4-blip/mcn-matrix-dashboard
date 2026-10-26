import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectSourcePollManifest, completedSourceJobSummary } from '../lib/source-poller-status.mjs';
import { createSourceJobStateReader, MAX_SOURCE_STATE_JOB_READS, MAX_SOURCE_STATE_REQUEST_BYTES, MAX_SOURCE_STATE_TOTAL_BYTES } from '../lib/source-job-state-read.mjs';

const NOW=new Date('2026-10-09T11:00:00.000Z');
const binding={sourceUrl:'https://fixture.feishu.cn/sheets/SOURCE?b=2&a=1',sourceSheetId:'sheet-a',sheetName:'Sheet A',defaultBoard:'团团'};
function job(id,status='completed',changes={}){
  return {id,status,createdAt:'2026-10-09T09:00:00.000Z',updatedAt:'2026-10-09T10:00:00.000Z',
    startedAt:status==='queued'?null:'2026-10-09T09:01:00.000Z',finishedAt:['completed','failed'].includes(status)?'2026-10-09T10:00:00.000Z':null,
    request:{...binding},...changes};
}
function fixture(t,sources=[{lastJobId:'job-1'}]){
  const dir=mkdtempSync(join(tmpdir(),'source-current-state-')),path=join(dir,'manifest.json');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(path,JSON.stringify({sources:Object.fromEntries(sources.map((source,i)=>[String(i),{key:String(i),...binding,lastStatus:'unchanged',lastCheckedAt:'2026-10-09T10:30:00.000Z',...source}]))}));
  return {path,before:readFileSync(path,'utf8'),read:options=>inspectSourcePollManifest(path,{now:NOW,...options})};
}
function jobsDb(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,status TEXT,created_at TEXT,updated_at TEXT,started_at TEXT,finished_at TEXT,request_json TEXT,result_json TEXT)');
  const insert=(value,padding=0)=>db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?,?,?,?)').run(value.id,value.status,value.createdAt,value.updatedAt,value.startedAt,value.finishedAt,
    JSON.stringify({...value.request,...(padding?{padding:'x'.repeat(padding)}:{})}),JSON.stringify({PRIVATE:'SECRET',rows:'x'.repeat(5000)}));
  return {db,insert};
}

test('historical pending business receipts no longer make current completed source checks unhealthy',t=>{
  const historical=completedSourceJobSummary({...job('job-1'),result:{createdCount:0,reusedExistingCount:20,reviewRequiredCount:468,queuedEvidenceRequestCount:466}},'job-1','2026-10-09T10:05:00.000Z');
  const f=fixture(t,[{lastJobId:'job-1',sourceJobSummary:historical}]),result=f.read({lookupJobState:()=>job('job-1')});
  assert.equal(result.status,'ok');assert.equal(result.activeJobCount,0);assert.equal(result.activeJobUnknownCount,0);
  assert.equal(result.businessPendingCount,1);assert.equal(result.historicalReviewSourceCount,1);
  assert.match(result.historicalReviewSourceCountUnit,/sources.*not-authors/);assert.match(result.activeJobCountUnit,/jobs-not-authors/);
  assert.match(result.currentJobScope,/not-author-identity-queue/);assert.equal(result.sources[0].currentJobState,'completed');
  assert.deepEqual(result.sources[0].sourceJobSummary,historical);assert.equal(readFileSync(f.path,'utf8'),f.before);
});

test('only registered latest IDs are counted, deduplicated, and still matched against every source binding',t=>{
  const f=fixture(t,[{lastJobId:'q'},{lastJobId:'q'},{lastJobId:'r'},{lastJobId:'done'},{}]);const calls=[];
  const result=f.read({lookupJobState:id=>{calls.push(id);return job(id,{q:'queued',r:'running',done:'completed'}[id]);}});
  assert.equal(result.activeJobCount,2);assert.equal(result.activeJobUnknownCount,0);assert.equal(result.currentFailedJobCount,0);
  assert.deepEqual(calls,['q','r','done']);assert.equal(result.sources.at(-1).currentJobState,'none');assert.equal(result.status,'warning');
});

for(const [name,options]of[
  ['missing callback',{}],['missing job',{lookupJobState:()=>null}],['read failure',{lookupJobState:()=>{throw Error('SECRET');}}],
  ['async callback',{lookupJobState:()=>Promise.resolve(job('job-1'))}],['unknown status',{lookupJobState:()=>job('job-1','waiting')}],
  ['wrong id',{lookupJobState:()=>job('other')}],['future updated',{lookupJobState:()=>job('job-1','completed',{updatedAt:'2026-10-09T11:00:00.001Z'})}],
  ['future creation',{lookupJobState:()=>job('job-1','queued',{createdAt:'2026-10-10T00:00:00.000Z'})}],
  ['rolled calendar',{lookupJobState:()=>job('job-1','queued',{createdAt:'2026-02-30T00:00:00.000Z'})}],
  ['running without start',{lookupJobState:()=>job('job-1','running',{startedAt:null})}],
  ['queued with finish',{lookupJobState:()=>job('job-1','queued',{finishedAt:'2026-10-09T09:05:00.000Z'})}],
  ['finished before start',{lookupJobState:()=>job('job-1','completed',{finishedAt:'2026-10-09T09:00:00.000Z'})}],
])test(`${name} is unverified rather than zero active jobs`,t=>{
  const result=fixture(t).read(options);assert.equal(result.activeJobCount,null);assert.equal(result.activeJobUnknownCount,1);
  assert.equal(result.sources[0].currentJobState,'unknown');assert.equal(result.status,'warning');assert.doesNotMatch(JSON.stringify(result),/SECRET/);
});

for(const [field,value]of[['sourceUrl','https://wrong.feishu.cn/sheets/OTHER'],['sourceSheetId','wrong'],['sheetName','wrong'],['defaultBoard','other']])test(`current job cannot lend a mismatched ${field} its state`,t=>{
  const f=fixture(t,[{lastJobId:'job-1'},{lastJobId:'job-1',[field]:value}]);let calls=0;
  const result=f.read({lookupJobState:()=>{calls++;return job('job-1','running');}});
  assert.equal(calls,1);assert.equal(result.activeJobCount,null);assert.equal(result.activeJobUnknownCount,1);
  assert.deepEqual(result.sources.map(source=>source.currentJobState),['running','unknown']);
});

test('unknown duplicate IDs deduplicate but pending without safe IDs remains unverified per source',t=>{
  const f=fixture(t,[{lastJobId:'missing'},{lastJobId:'missing'},{lastJobId:'token=SECRET',lastStatus:'pending'},{lastStatus:'pending'},{}]);
  let calls=0;const result=f.read({lookupJobState:()=>{calls++;return null;}});
  assert.equal(calls,1);assert.equal(result.activeJobUnknownCount,3);assert.equal(result.activeJobCount,null);
  assert.doesNotMatch(JSON.stringify(result),/SECRET/);
});

test('durable failed latest jobs warn without being counted as active or added to source failures',t=>{
  const result=fixture(t,[{lastJobId:'f'},{lastJobId:'f'}]).read({lookupJobState:()=>job('f','failed')});
  assert.equal(result.status,'warning');assert.equal(result.currentFailedJobCount,1);assert.equal(result.activeJobCount,0);assert.equal(result.failedCount,0);
});

test('current callback reads are bounded to 50 IDs and unfinished references remain unknown',t=>{
  let calls=0;const result=fixture(t,Array.from({length:55},(_,i)=>({lastJobId:`job-${i}`}))).read({lookupJobState:id=>{calls++;return job(id);}});
  assert.equal(calls,50);assert.equal(result.activeJobCount,null);assert.equal(result.activeJobUnknownCount,5);
});

test('small durable projection does not transfer full request/result or change SQLite',t=>{
  const {db,insert}=jobsDb(t);insert(job('job-1','running'),2*1024*1024);
  const sqls=[],wrapped=new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{sqls.push(sql);return target.prepare(sql);};return typeof target[key]==='function'?target[key].bind(target):target[key];}});
  const before=db.prepare('SELECT total_changes() n').get().n;db.exec('PRAGMA query_only=ON');
  const lookup=createSourceJobStateReader(wrapped),result=lookup('job-1');assert.equal(result.status,'running');assert.deepEqual(result.request,binding);
  assert.equal(lookup('job-1'),result);assert.ok(JSON.stringify(result).length<1000);assert.doesNotMatch(JSON.stringify(result),/padding|PRIVATE|SECRET/);
  assert.ok(sqls.every(sql=>!/SELECT\s+\*|result_json/i.test(sql)));assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(fixture(t).read({lookupJobState:lookup}).activeJobCount,1);
});

test('missing table, malformed and oversized request documents stay unknown',t=>{
  const absent=new DatabaseSync(':memory:');t.after(()=>absent.close());assert.equal(createSourceJobStateReader(absent)('job-1'),null);
  const {db,insert}=jobsDb(t);insert(job('job-1'),MAX_SOURCE_STATE_REQUEST_BYTES+1);insert(job('bad'));
  db.prepare("UPDATE author_resolution_jobs SET request_json='{invalid' WHERE id='bad'").run();
  const lookup=createSourceJobStateReader(db);assert.equal(lookup('job-1'),null);assert.equal(lookup('bad'),null);
  assert.equal(fixture(t).read({lookupJobState:lookup}).activeJobCount,null);
});

test('binding projection never converts invalid optional field types or overlength strings into empty bindings',t=>{
  const {db,insert}=jobsDb(t);
  for(const [i,value]of[3,{},[],true,'x'.repeat(121)].entries())insert(job(`bad-${i}`,'running',{request:{...binding,defaultBoard:value}}));
  const lookup=createSourceJobStateReader(db);for(let i=0;i<5;i++)assert.equal(lookup(`bad-${i}`),null);
});

test('projection budgets are per inspection, cached by ID, and capped before parsing the next large request',t=>{
  const {db,insert}=jobsDb(t);
  for(let i=0;i<6;i++)insert(job(`big-${i}`),3*1024*1024);
  const lookup=createSourceJobStateReader(db);for(let i=0;i<5;i++){const row=lookup(`big-${i}`);assert.ok(row);assert.equal(lookup(`big-${i}`),row);}
  assert.equal(lookup('big-5'),null);assert.equal(MAX_SOURCE_STATE_TOTAL_BYTES,16*1024*1024);
  assert.ok(createSourceJobStateReader(db)('big-5'),'fresh independent inspection has its own bounded budget');
});

test('projection job-ID budget also counts misses and never reads unsafe IDs',t=>{
  const {db,insert}=jobsDb(t);insert(job('last'));const lookup=createSourceJobStateReader(db);
  for(let i=0;i<MAX_SOURCE_STATE_JOB_READS;i++)assert.equal(lookup(`missing-${i}`),null);
  assert.equal(lookup('last'),null);assert.equal(lookup('token=SECRET'),null);
});

test('job metadata and source binding use one short read snapshot despite another WAL connection updating the row',t=>{
  const directory=mkdtempSync(join(tmpdir(),'source-state-wal-')),path=join(directory,'jobs.sqlite');
  const writer=new DatabaseSync(path);writer.exec('PRAGMA journal_mode=WAL');
  writer.exec('CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,status TEXT,created_at TEXT,updated_at TEXT,started_at TEXT,finished_at TEXT,request_json TEXT)');
  const original=job('job-1','running');writer.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?,?,?)').run(original.id,original.status,original.createdAt,original.updatedAt,original.startedAt,original.finishedAt,JSON.stringify(original.request));
  const reader=new DatabaseSync(path,{readOnly:true});t.after(()=>{reader.close();writer.close();rmSync(directory,{recursive:true,force:true});});
  let changed=false;
  const wrapped=new Proxy(reader,{get(db,key){if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];return sql=>{
    const stmt=db.prepare(sql);if(!sql.includes('AS requestBytes'))return stmt;
    return {get(id){const result=stmt.get(id);if(!changed){changed=true;writer.prepare("UPDATE author_resolution_jobs SET status='completed',finished_at=?,request_json=? WHERE id=?")
      .run(original.updatedAt,JSON.stringify({...binding,defaultBoard:'另外的板块'}),id);}return result;}};
  };}});
  const lookup=createSourceJobStateReader(wrapped),result=lookup('job-1');
  assert.equal(result.status,'running');assert.equal(result.request.defaultBoard,binding.defaultBoard);
  assert.equal(reader.prepare("SELECT status FROM author_resolution_jobs WHERE id='job-1'").get().status,'completed','short snapshot is released immediately');
  const next=createSourceJobStateReader(reader)('job-1');assert.equal(next.status,'completed');assert.equal(next.request.defaultBoard,'另外的板块');
});

test('server wires small state lookups independently of completed summaries with one inspection timestamp',()=>{
  const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  assert.equal((server.match(/lookupJobState: createSourceJobStateReader\(database\.db\)/g)||[]).length,2);
  assert.equal((server.match(/manifest\.json"\), \{ now: checkedAt,/g)||[]).length,2);
});

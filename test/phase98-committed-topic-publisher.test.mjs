import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createPublisherProcessProbe, publisherProbePreload } from './helpers/publisher-process-probe.mjs';

const main = fileURLToPath(new URL('../', import.meta.url));
const root = pathToFileURL(realpathSync(resolve(process.env.PHASE98_CANDIDATE || main)) + sep);
const { MonitorDatabase } = await import(new URL('lib/database.mjs', root));
const {canPreparePublicReplica}=await import(new URL('scripts/public-replica-publisher.mjs',root));
const {readPublicSourceMarker}=await import(new URL('lib/public-source-marker.mjs',root));
const { normalizeCollection } = await import(new URL('lib/providers/normalize.mjs', root));
const { PUBLIC_REPLICA_EXPORT_REVISION, exportPublicReplica, writePublicReplica, serializePublicReplica } = await import(new URL('lib/public-replica-export.mjs', root));
const { preparePublicReplicaPublication } = await import(new URL('lib/public-replica-sync.mjs', root));
const { readCommittedTargetPublication, releaseCommittedTargetPublication } = await import(new URL('lib/committed-target-publication.mjs', root));
const hash = value => createHash('sha256').update(value).digest('hex');
const marker = hash(JSON.stringify({ events: [], source: null }));
const preload = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const originalOpen=fs.promises.open;fs.promises.open=async(path,...args)=>{if(String(path).endsWith('/credential')){publisherTestNotify({kind:'credential-read'});throw Error('FORBIDDEN_CREDENTIAL');}return originalOpen(path,...args);};syncBuiltinESMExports();

globalThis.fetch=async()=>{publisherTestNotify({kind:'network-call'});throw Error('FORBIDDEN_NETWORK');};process.channel?.unref();`;

function setup(t, variant) {
  const directory = mkdtempSync(join(tmpdir(), 'phase98-cloud-lifecycle-'));
  const home = join(directory, 'public-replica-publisher'); mkdirSync(home, { mode: 0o700 });
  const database = new MonitorDatabase(join(directory, 'douyin-monitor.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: 'hashtag', provider: 'public-web', label: '#一条小团团OvO', locator: '一条小团团OvO' });
  const runId = database.beginRun('scheduled', null, 705);
  const capturedAt = new Date().toISOString();
  const raw = { capturedAt, participants: 12, participant_count: 12, views: 34, view_count: 34,
    hashtag: target.locator, officialName: target.locator, challengeId: '123456789012345',
    scope: 'douyin-official-challenge-detail', provenance: { mode: 'douyin-official-anonymous-challenge-detail', runtimeAI: false, paidAPI: false } };
  if (variant === 'no-parent') {
    delete raw.hashtag; delete raw.participant_count; delete raw.view_count;
    raw.label=target.locator; raw.businessStatusCode=0;
    raw.provenance.endpoint='https://www.douyin.com/aweme/v1/web/challenge/detail/'; raw.provenance.authenticated=false;
  }
  if (variant === 'wrong-identity') raw.officialName = 'different-topic';
  if (variant === 'no-source-audit') {
    database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,hashtag_participants,hashtag_views,quality_status,account_status,works_coverage,warnings_json,source_checksum,raw_json)
      VALUES(?,?,?,?,?,'unknown','not-applicable','[]',?,?)`).run(target.id,capturedAt,12,34,'validated',hash(JSON.stringify(raw)),JSON.stringify(raw));
  } else database.saveCollection(target, runId, normalizeCollection(target, raw, { capturedAt }));
  const state = { version: 1, active: null, coveredMarker: hash(JSON.stringify({events:[],source:null,dataMarker:readPublicSourceMarker(database.db,capturedAt)})), coveredSource: null,
    exportRevision: PUBLIC_REPLICA_EXPORT_REVISION, status: 'success',
    publishedAsOf: '2026-09-25T01:00:00.000Z', lastConfirmedPublishedAt: '2026-09-25T01:01:00.000Z', sync: { status: 'success' } };
  const checkpoint = { version: 1, asOf: state.publishedAsOf, activated: true, completedBatches: [0], readbackFiles: ['catalog.json'] };
  writeFileSync(join(home, 'state.json'), JSON.stringify(state), { mode: 0o600 });
  writeFileSync(join(home, 'checkpoint.json'), JSON.stringify(checkpoint), { mode: 0o600 });
  return { directory, home, database, runId };
}

for (const variant of ['wrong-identity', 'no-source-audit', 'no-parent']) {
  test(`actual CLI invalid topic ${variant}: zero proof/events/source is token-free idle with unchanged state`, { timeout: 7000 }, async t => {
    const f = setup(t, variant), asOf = new Date().toISOString(), db = f.database.db;
    db.exec('BEGIN');
    try {
      const proof = readCommittedTargetPublication(db, { asOf });
      assert.equal(proof.runningSnapshotCount, 0);
      const output = exportPublicReplica(db, { asOf, committedPublication: proof });
      assert.ok(output.topics.items.every(row => row.participants === null && row.views === null));
      assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId).status, 'running');
      releaseCommittedTargetPublication(proof);
    } finally { db.exec('ROLLBACK'); }
    const before = Object.fromEntries(['state.json','checkpoint.json'].map(name => [name,hash(readFileSync(join(f.home,name)))]));
    const probe=createPublisherProcessProbe(f.directory);
    const child = spawn(process.execPath, ['--import','data:text/javascript,'+encodeURIComponent(publisherProbePreload+preload),fileURLToPath(new URL('scripts/public-replica-publisher.mjs',root))],
      { env: { ...process.env, ...probe.env, DATA_DIR: f.directory }, stdio: ['ignore','pipe','pipe','ipc'] });
    let output = ''; const messages = []; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    const closed = new Promise(resolve => child.once('close', (code,signal) => resolve({code,signal})));
    let timeout,stopProbe;
    try {
      await new Promise((resolve,reject) => {
        timeout=setTimeout(()=>reject(Error('CLI read did not finish: '+output)),4000);
        stopProbe=probe.watch(message=>{messages.push(message);if(message.kind==='cycle-completed')resolve();});
        child.once('error',reject); child.once('exit',code=>reject(Error('CLI exited early '+code+': '+output)));
      });
      child.kill('SIGTERM'); assert.deepEqual(await closed,{code:0,signal:null});
      assert.equal(messages.some(message=>message.kind==='credential-read'),false);
      assert.equal(messages.some(message=>message.kind==='network-call'),false);
      assert.equal(existsSync(join(f.home,'credential')),false);
      for(const [name,digest] of Object.entries(before)) assert.equal(hash(readFileSync(join(f.home,name))),digest,name+' preserved');
      assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId).status,'running');
      assert.equal(existsSync(join(f.directory,'public-replica-staging')),false);
    } finally {
      clearTimeout(timeout);
      if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}
      stopProbe?.();probe.close();
    }
  });
}

for(const publicHomepageStatus of [200,403]) test(`actual topic-only CLI publishes via explicit proof; visitor homepage ${publicHomepageStatus}; cadence, generation and profile counts remain strict`, {timeout:7000}, async t => {
  const realNow=Date.now(), base=realNow-3600_000;
  t.mock.timers.enable({apis:['Date'],now:base});
  const directory=mkdtempSync(join(tmpdir(),'phase98-cloud-topic-only-')),home=join(directory,'public-replica-publisher');mkdirSync(home,{mode:0o700});
  const database=new MonitorDatabase(join(directory,'douyin-monitor.sqlite')),db=database.db;
  t.after(()=>{database.close();rmSync(directory,{recursive:true,force:true});});
  const target=database.createTarget({type:'hashtag',provider:'public-web',label:'#一条小团团OvO',locator:'一条小团团OvO'});
  const parentRun=database.beginRun('scheduled',null,1);t.mock.timers.setTime(base+1000);
  const parentRaw={capturedAt:new Date().toISOString(),participants:5,views:50,hashtag:target.locator,officialName:target.locator,
    challengeId:'123456789012345',scope:'douyin-official-challenge-detail',provenance:{mode:'douyin-official-anonymous-challenge-detail',runtimeAI:false,paidAPI:false}};
  database.saveCollection(target,parentRun,normalizeCollection(target,parentRaw,{capturedAt:parentRaw.capturedAt}));
  t.mock.timers.setTime(base+2000);database.finishRun(parentRun,{status:'success',successCount:1,processedCount:1});
  const source=db.prepare('SELECT s.id,s.source_checksum,a.id auditId,a.run_id FROM snapshots s JOIN audits a ON a.source_checksum=s.source_checksum WHERE s.target_id=?').get(target.id);
  t.mock.timers.setTime(base+3000);const baselineAsOf=new Date().toISOString();
  const baseline=exportPublicReplica(db,{asOf:baselineAsOf});
  const previousDirectory=join(directory,'public-replica-staging','publisher-'+baselineAsOf.replace(/[:.]/g,'-'));
  await writePublicReplica(previousDirectory,baseline);
  const previousAccepted=await preparePublicReplicaPublication(serializePublicReplica(baseline),{dateIndex:true});
  t.mock.timers.setTime(realNow-5000);const runId=database.beginRun('scheduled',null,705);
  t.mock.timers.setTime(realNow-4000);const capturedAt=new Date().toISOString();
  const raw={scope:'douyin-official-challenge-detail',businessStatusCode:0,challengeId:parentRaw.challengeId,label:target.locator,
    officialName:target.locator,participants:12,views:34,provenance:{mode:'douyin-official-anonymous-challenge-detail',endpoint:'https://www.douyin.com/aweme/v1/web/challenge/detail/',authenticated:false,runtimeAI:false,paidAPI:false},
    identityReuse:{scope:'historical-identity-only',snapshotId:source.id,auditId:source.auditId,runId:parentRun,capturedAt:parentRaw.capturedAt,sourceChecksum:source.source_checksum}};
  database.saveCollection(target,runId,normalizeCollection(target,raw,{capturedAt}));
  t.mock.timers.setTime(realNow-3000);const asOf=new Date().toISOString();
  db.exec('BEGIN');let proofMarker;
  try {
    if(process.env.PHASE98_BASELINE){
      const prior=pathToFileURL(realpathSync(resolve(process.env.PHASE98_BASELINE))+sep);
      const oldProofModule=await import(new URL('lib/committed-target-publication.mjs',prior));
      const oldExport=await import(new URL('lib/public-replica-export.mjs',prior));
      const oldProof=oldProofModule.readCommittedTargetPublication(db,{asOf});
      try {
        assert.equal(oldProof.runningSnapshotCount,0,'Phase97 baseline has no topic publication proof');
        assert.ok(oldExport.exportPublicReplica(db,{asOf,committedPublication:oldProof}).topics.items.filter(row=>row.capturedAt===capturedAt).every(row=>row.participants===null&&row.views===null),'same saved current topic is unavailable in Phase97 baseline');
      } finally {oldProofModule.releaseCommittedTargetPublication(oldProof);}
    }
    const proof=readCommittedTargetPublication(db,{asOf});
    assert.equal(proof.runningProfileCount,0);assert.equal(proof.runningTopicCount,1);assert.equal(proof.runningSnapshotCount,1);
    const defaults=exportPublicReplica(db,{asOf});const currentDefault=defaults.topics.items.find(row=>row.capturedAt===capturedAt);assert.ok(currentDefault);assert.equal(currentDefault.participants,null);assert.equal(currentDefault.views,null);
    const explicit=exportPublicReplica(db,{asOf,committedPublication:proof});assert.deepEqual(explicit.topics.items.filter(row=>row.capturedAt===capturedAt).map(row=>[row.participants,row.views]),[[12,34]]);
    // A prior Beijing calendar day's qualified observation must survive.
    const currentDay=new Date(Date.parse(capturedAt)+8*3600_000).toISOString().slice(0,10);
    assert.deepEqual(explicit.topics.items.filter(row=>row.date!==currentDay),baseline.topics.items.filter(row=>row.date!==currentDay));
    const {shouldStagePublicReplica}=await import(new URL('scripts/public-replica-publisher.mjs',root));
    const observed={running:true,marker:'topic-only',committedPublication:proof};
    assert.equal(shouldStagePublicReplica({active:null,coveredMarker:marker,exportRevision:PUBLIC_REPLICA_EXPORT_REVISION,publishedAsOf:asOf,lastConfirmedPublishedAt:asOf},observed,Date.parse(asOf)),false,'30 minute cadence not shortened');
    assert.equal(shouldStagePublicReplica({active:{asOf:baselineAsOf}},observed,Date.parse(asOf)),false,'active generation never displaced');
    assert.equal(shouldStagePublicReplica({active:null,coveredMarker:marker}, {...observed,committedPublication:{...proof}},Date.parse(asOf)),false,'serialized forged proof rejected');
    proofMarker=proof.marker;releaseCommittedTargetPublication(proof);
  } finally {db.exec('ROLLBACK');}
  const state={version:1,active:null,coveredMarker:marker,coveredSource:null,exportRevision:PUBLIC_REPLICA_EXPORT_REVISION,status:'success',publishedAsOf:baselineAsOf,lastConfirmedPublishedAt:baselineAsOf,
    sync:{status:'success',asOf:baselineAsOf,manifestSha256:hash(JSON.stringify(previousAccepted.manifest))}};
  writeFileSync(join(home,'state.json'),JSON.stringify(state),{mode:0o600});writeFileSync(join(home,'credential'),'e'.repeat(64),{mode:0o600});
  const transport=`const files=new Map();let manifest=null;globalThis.fetch=async(url,init={})=>{const u=new URL(url);if(u.origin!=='https://mcn-matrix-observatory.slowlygold4.chatgpt.site'){publisherTestNotify({kind:'forbidden-origin'});throw Error('FORBIDDEN_ORIGIN');}if(u.pathname==='/'){if(new Headers(init.headers).has('authorization')||new Headers(init.headers).has('cookie')){publisherTestNotify({kind:'unexpected-visitor-credential'});throw Error('NO_VISITOR_CREDENTIAL');}publisherTestNotify({kind:'homepage-check'});return new Response(${publicHomepageStatus}===200?'<html><title>MCN 矩阵数据台</title></html>':'error code: 1010',{status:${publicHomepageStatus},headers:{'content-type':${publicHomepageStatus}===200?'text/html':'text/plain'}});}if(u.pathname!=='/api/replica'){publisherTestNotify({kind:'forbidden-origin'});throw Error('FORBIDDEN_ORIGIN');}if(init.method==='POST'){const b=publisherTestBody(init);if(b.action==='upload'){for(const f of b.files)files.set(f.path,f);return Response.json({accepted:b.files.length,asOf:b.asOf});}manifest=b.manifest;publisherTestNotify({kind:'activated',topics:JSON.parse(files.get('topics.json').data)});return Response.json({published:true,asOf:b.asOf,parts:files.size});}if(!manifest)return Response.json({}, {status:404});const part=u.searchParams.get('part');return part?new Response(files.get(part).data):Response.json({manifest,publishedAt:new Date().toISOString(),readOnly:true,collectionRequiresLocalComputer:true});};const log=console.log;console.log=(line)=>{log(line);try{if(JSON.parse(line).status==='success')publisherTestNotify({kind:'success'});}catch{}};process.channel?.unref();`;
  const probe=createPublisherProcessProbe(directory);
  const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(publisherProbePreload+transport),fileURLToPath(new URL('scripts/public-replica-publisher.mjs',root))],{env:{...process.env,...probe.env,DATA_DIR:directory},stdio:['ignore','pipe','pipe','ipc']});
  const messages=[];let output='',timeout,stopProbe;child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try {
    await new Promise((resolve,reject)=>{timeout=setTimeout(()=>reject(Error('topic CLI did not publish: '+output)),4500);stopProbe=probe.watch(message=>{messages.push(message);if(message.kind==='success')resolve();});child.once('error',reject);child.once('exit',code=>reject(Error('topic CLI exited '+code+': '+output)));});
    child.kill('SIGTERM');assert.deepEqual(await closed,{code:0,signal:null});
    assert.equal(messages.some(m=>m.kind==='forbidden-origin'),false);
    const bodies=messages.filter(m=>m.kind==='request-body');
    assert.ok(bodies.length>=2,'real CLI uploaded and activated a generation');
    assert.ok(bodies.every(m=>m.gzip===true),'gzip was decoded in the synthetic server rather than disabled in production');
    assert.deepEqual(messages.find(m=>m.kind==='activated').topics.items.filter(row=>row.capturedAt===capturedAt).map(row=>[row.participants,row.views]),[[12,34]]);
    const saved=JSON.parse(readFileSync(join(home,'state.json'),'utf8'));
    assert.equal(saved.active,null);assert.equal(saved.status,'success');assert.notEqual(saved.coveredMarker,marker);
    assert.equal(saved.sync.status,'success');
    assert.equal(saved.publicAccess.status,publicHomepageStatus===200?'verified':'blocked');
    assert.equal(saved.publicAccess.requestMode,'anonymous');
    assert.equal(saved.publicAccess.guaranteesAllNetworks,false);
    assert.equal(saved.publicAccess.networkRequests,publicHomepageStatus===200?2:1);
    assert.equal(messages.filter(m=>m.kind==='homepage-check').length,1);
    assert.equal(messages.some(m=>m.kind==='unexpected-visitor-credential'),false);
    assert.equal(canPreparePublicReplica(saved,Date.parse(saved.lastConfirmedPublishedAt)+1000),false,'visitor access failure must not force duplicate uploads or shorten cadence');
    assert.equal(saved.coveredMarker,hash(JSON.stringify({events:[],source:null,dataMarker:readPublicSourceMarker(db,asOf),contract:'committed-target-atomic-audit-v1',committedTargets:proofMarker})));
    assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(runId).status,'running');
    assert.equal(output.includes('e'.repeat(64)),false);
  } finally {clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}stopProbe?.();probe.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { ConsoleReader } from '../lib/console-reader.mjs';
import { SystemAuditReader } from '../lib/system-audit-reader.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('phase102 actual HTTP: route signals, same-key subscriber isolation, bootstrap pre-audit disconnect, cleanup',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'phase102-http-'));process.env.DATA_DIR=dir;
  const database=new MonitorDatabase(join(dir,'douyin-monitor.sqlite'));
  const target=database.createTarget({type:'account',provider:'manual',enabled:false,label:'HTTP离线取消',locator:'phase102-http'});
  const original=Object.fromEntries(['overview','account','history','bootstrapOverview'].map(key=>[key,ConsoleReader.prototype[key]]));
  const auditOriginal=SystemAuditReader.prototype.read, statusOriginal=MonitorScheduler.prototype.getStatusAsync;
  const calls=[];let barrier=null, auditBarrier=null, auditEntered=null, auditReads=0, statusEntered=null;
  for(const kind of Object.keys(original))ConsoleReader.prototype[kind]=async function(...args){
    const signal=(kind==='account'||kind==='history'?args[2]:args[1])?.signal;
    const record={kind,signal,reader:this};calls.push(record);
    if(barrier)await barrier.promise;
    return original[kind].apply(this,args);
  };
  SystemAuditReader.prototype.read=async function(...args){auditReads++;auditEntered?.resolve();if(auditBarrier)await auditBarrier.promise;return auditOriginal.apply(this,args);};
  MonitorScheduler.prototype.getStatusAsync=async function(...args){statusEntered?.resolve();return statusOriginal.apply(this,args);};
  const {server}=await import('../server.mjs');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{barrier?.resolve();auditBarrier?.resolve();await new Promise(resolve=>server.close(resolve));for(const[k,v]of Object.entries(original))ConsoleReader.prototype[k]=v;SystemAuditReader.prototype.read=auditOriginal;MonitorScheduler.prototype.getStatusAsync=statusOriginal;database.close();rmSync(dir,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const auth=await fetch(origin+'/api/auth/session');await auth.json();const cookie=auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const start=path=>{let request;const result=new Promise((resolve,reject)=>{request=httpRequest(origin+path,{headers:{Cookie:cookie}},response=>{let body='';response.on('data',chunk=>{body+=chunk;});response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(body)}));});request.on('error',reject);request.end();});return{request,result};};
  const waitCalls=async count=>{for(let i=0;i<300&&calls.length<count;i++)await new Promise(r=>setTimeout(r,2));assert.equal(calls.length,count);};
  const routes=['/api/rebuild/insights?period=day',`/api/rebuild/accounts/${target.id}/insights?period=day`,`/api/rebuild/accounts/${target.id}/history?kind=daily`,'/api/insights?period=day',`/api/accounts/${target.id}/insights?period=day`];
  for(const route of routes){barrier=deferred();const offset=calls.length;
    const first=start(route);const firstRejected=first.result.catch(error=>error);await waitCalls(offset+1);
    const second=start(route);await waitCalls(offset+2);
    assert.ok(calls[offset].signal instanceof AbortSignal,route);
    first.request.destroy();await firstRejected;await new Promise(r=>setTimeout(r,10));
    assert.equal(calls[offset].signal.aborted,true,route);assert.equal(calls[offset+1].signal.aborted,false);
    barrier.resolve();barrier=null;const result=await second.result;assert.equal(result.status,200,route);
    await tick();assert.equal(calls[offset+1].reader.jobs.size,0);
  }
  const auditReadsBefore=auditReads;
  barrier=deferred();statusEntered=deferred();
  const opening=start('/api/bootstrap');
  let statusTimer;
  try{await Promise.race([statusEntered.promise,new Promise((_,reject)=>{statusTimer=setTimeout(()=>reject(Error('scheduler status was blocked behind the overview read')),1000);})]);}
  finally{clearTimeout(statusTimer);}
  barrier.resolve();barrier=null;
  const ordinaryBootstrap=await opening.result;
  assert.equal(ordinaryBootstrap.status,200);
  assert.equal(ordinaryBootstrap.body.runtimeAudit,null,'unperformed integrity scan cannot be represented as a passed scan');
  assert.equal(ordinaryBootstrap.body.runtimeAuditStatus,'not-requested');
  assert.equal(auditReads,auditReadsBefore,'opening the app must not enqueue a heavy integrity scan');
  assert.ok(Array.isArray(ordinaryBootstrap.body.targets));
  auditBarrier=deferred();auditEntered=deferred();const before=calls.filter(c=>c.kind==='bootstrapOverview').length;
  const bootstrap=start('/api/bootstrap?audit=1');const caught=bootstrap.result.catch(error=>error);await auditEntered.promise;
  bootstrap.request.destroy();await caught;await new Promise(r=>setTimeout(r,10));
  auditBarrier.resolve();auditBarrier=null;await new Promise(r=>setTimeout(r,250));
  assert.equal(calls.filter(c=>c.kind==='bootstrapOverview').length,before,'disconnect before audit completes must not enqueue bootstrap overview');
  const anon=await fetch(origin+'/api/rebuild/insights',{headers:{'X-Forwarded-For':'198.51.100.2'}});assert.equal(anon.status,401);
  assert.equal((await fetch(origin+'/healthz')).status,200);
});

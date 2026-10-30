import {projectCollectionPlatforms} from './collection-platform-view.mjs';
const COOKIE='__Host-mcn-collection';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const reply=(body,status=200,headers={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const digest=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const token=()=>crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
export function safeProgress(x){
 const n=v=>Number.isSafeInteger(v)&&v>=0?v:0;
 const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:null;
 const text=v=>typeof v==='string'?v.slice(0,120):null;
 if(!x||x.runtimeAI!==false||!time(x.observedAt))throw Error('invalid telemetry');
 const platforms=projectCollectionPlatforms(x);
 return {version:1,observedAt:x.observedAt,runtimeAI:false,scope:'all',accounts:n(x.accounts),topics:n(x.topics),
 rolling:x.rolling?{since:time(x.rolling.since),total:n(x.rolling.total),attempted:n(x.rolling.attempted),profileTotal:n(x.rolling.profileTotal),profiles:n(x.rolling.profiles),topics:n(x.rolling.topics),updated:n(x.rolling.updated),notUpdated:n(x.rolling.notUpdated),worksComplete:n(x.rolling.worksComplete),worksLimited:n(x.rolling.worksLimited),workIssues:n(x.rolling.workIssues),reasons:Array.isArray(x.rolling.reasons)?x.rolling.reasons.slice(0,5).map(r=>({code:text(r.code),count:n(r.count)})):[],platforms:platforms.rolling}:null,
 dailyWorkLikes:platforms.daily,
 dailyProfiles:platforms.dailyProfiles,
 queue:{pending:n(x.queue?.pending),resolved:n(x.queue?.resolved),rejected:n(x.queue?.rejected)},
 run:x.run?{id:n(x.run.id),status:['running','success','partial','failed','interrupted'].includes(x.run.status)?x.run.status:'unknown',
 kind:text(x.run.kind),startedAt:time(x.run.startedAt),finishedAt:time(x.run.finishedAt),heartbeatAt:time(x.run.heartbeatAt),
 total:n(x.run.total),processed:n(x.run.processed),success:n(x.run.success),failed:n(x.run.failed),warnings:n(x.run.warnings),skipped:n(x.run.skipped),current:text(x.run.current)}:null,
 coverage:x.coverage?{runId:n(x.coverage.runId),finishedAt:time(x.coverage.finishedAt),total:n(x.coverage.total),profiles:n(x.coverage.profiles),worksComplete:n(x.coverage.worksComplete),worksLimited:n(x.coverage.worksLimited),topics:n(x.coverage.topics)}:null};
}
export async function initializeControl(db){
 await db.batch([
 db.prepare('CREATE TABLE IF NOT EXISTS collection_status (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, received_at INTEGER NOT NULL)'),
 db.prepare('CREATE TABLE IF NOT EXISTS collection_sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)'),
 db.prepare('CREATE TABLE IF NOT EXISTS collection_grants (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0)'),
 db.prepare('CREATE TABLE IF NOT EXISTS collection_commands (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, receipt TEXT)'),
 db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS collection_one_active ON collection_commands(active) WHERE active=1')]);
}
async function readInput(request){
 const reader=request.body?.getReader();if(!reader)return {};
 let size=0,parts=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16000)throw Error('large');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
export async function handleCollection(request,{db,secret,now=Date.now()}){
 if(!db)return reply({error:'采集控制存储暂不可用'},503);
 const producer=typeof secret==='string'&&secret.length>=48&&request.headers.get('Authorization')===`Bearer ${secret}`;
 // No public write may initialize storage or consume a token without same-origin intent.
 if(request.method==='POST'&&!producer&&request.headers.get('Origin')!==new URL(request.url).origin)return reply({error:'请求来源不匹配'},403);
 await initializeControl(db);
 const rawCookie=request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
 const session=rawCookie&&HASH.test(rawCookie)?await db.prepare('SELECT hash FROM collection_sessions WHERE hash=? AND expires_at>?').bind(await digest(rawCookie),now).first():null;
 if(request.method==='GET'){
  const row=await db.prepare('SELECT payload,received_at FROM collection_status WHERE id=1').first();
  const command=await db.prepare('SELECT id,created_at,expires_at,status,receipt FROM collection_commands ORDER BY created_at DESC LIMIT 1').first();
  const status=row?JSON.parse(row.payload):null;
  const fresh=!!row&&now-row.received_at<90000&&now-Date.parse(status.observedAt)<90000;
  return reply({status,receivedAt:row?new Date(row.received_at).toISOString():null,online:fresh,canControl:!!session,runtimeAI:false,
   command:command?{id:command.id,createdAt:new Date(command.created_at).toISOString(),status:command.status==='queued'&&command.expires_at<now?'expired':command.status,receipt:command.receipt?JSON.parse(command.receipt):null}:null});
 }
 if(request.method!=='POST')return reply({error:'不支持的方法'},405);
 let input;try{input=await readInput(request);}catch{return reply({error:'请求格式无效'},400);}
 if(!input||typeof input!=='object')return reply({error:'请求格式无效'},400);
 if(producer){
  if(input.action==='grant'){
   if(!HASH.test(input.hash??''))return reply({error:'无效管理授权'},400);
   await db.batch([db.prepare('DELETE FROM collection_grants WHERE expires_at<?').bind(now),db.prepare('DELETE FROM collection_sessions WHERE expires_at<?').bind(now),
    db.prepare('INSERT INTO collection_grants(hash,expires_at) VALUES(?,?)').bind(input.hash,now+300000)]);
   return reply({ok:true,expiresAt:new Date(now+300000).toISOString()});
  }
  if(input.action==='heartbeat'){
   let status;try{status=safeProgress(input.status);}catch{return reply({error:'状态格式无效'},400);}
   if(Math.abs(now-Date.parse(status.observedAt))>90000)return reply({error:'状态已过期'},400);
   await db.prepare('INSERT INTO collection_status(id,payload,received_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,received_at=excluded.received_at WHERE received_at<=excluded.received_at').bind(JSON.stringify(status),now).run();
   if(input.ack){
    const a=input.ack;if(!UUID.test(a.id??'')||!['queued','running','completed','failed','interrupted'].includes(a.status)||!UUID.test(a.jobId??''))return reply({error:'回执无效'},400);
    const receipt={jobId:a.jobId,runId:Number.isSafeInteger(a.runId)?a.runId:null,updatedAt:new Date(now).toISOString()};
    const active=['queued','running'].includes(a.status)?1:0;
    await db.prepare("UPDATE collection_commands SET status=?,active=?,receipt=? WHERE id=? AND active=1").bind(a.status,active,JSON.stringify(receipt),a.id).run();
   }
   await db.prepare("UPDATE collection_commands SET status='expired',active=0 WHERE status='queued' AND receipt IS NULL AND expires_at<?").bind(now).run();
   const command=await db.prepare('SELECT id,status,receipt FROM collection_commands WHERE active=1').first();
   return reply({ok:true,command:command?{id:command.id,status:command.status,receipt:command.receipt?JSON.parse(command.receipt):null}:null});
  }
  return reply({error:'未知生产者操作'},400);
 }
 if(input.action==='pair'){
  if(!HASH.test(input.code??''))return reply({error:'管理连接无效或已过期'},403);
  const grant=await db.prepare('UPDATE collection_grants SET consumed=1 WHERE hash=? AND consumed=0 AND expires_at>? RETURNING hash').bind(await digest(input.code),now).first();
  if(!grant)return reply({error:'管理连接已使用或过期，请在本机重新开启'},403);
  const value=token();await db.prepare('INSERT INTO collection_sessions(hash,expires_at) VALUES(?,?)').bind(await digest(value),now+30*86400000).run();
  return reply({ok:true},200,{'Set-Cookie':`${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`});
 }
 if(!session)return reply({error:'请在采集电脑上开启管理连接后再下达指令'},401);
 if(input.action==='logout'){
  await db.prepare('DELETE FROM collection_sessions WHERE hash=?').bind(await digest(rawCookie)).run();
  return reply({ok:true},200,{'Set-Cookie':`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`});
 }
 if(input.action!=='trigger'||!UUID.test(input.id??''))return reply({error:'无效全量采集指令'},400);
 const heartbeat=await db.prepare('SELECT received_at,payload FROM collection_status WHERE id=1').first();
 if(!heartbeat||now-heartbeat.received_at>=90000||now-Date.parse(JSON.parse(heartbeat.payload).observedAt)>=90000)return reply({error:'采集电脑未连接。恢复在线后再下达指令；不会后台重放过期指令。'},409);
 await db.prepare("UPDATE collection_commands SET status='expired',active=0 WHERE status='queued' AND receipt IS NULL AND expires_at<?").bind(now).run();
 const prior=await db.prepare('SELECT id,status FROM collection_commands WHERE id=?').bind(input.id).first();
 if(prior)return reply({command:prior,reused:true},202);
 await db.prepare("INSERT OR IGNORE INTO collection_commands(id,created_at,expires_at,status) VALUES(?,?,?,'queued')").bind(input.id,now,now+600000).run();
 const command=await db.prepare('SELECT id,status FROM collection_commands WHERE active=1').first();
 return reply({command,reused:command?.id!==input.id},202);
}

// Bounded, loopback-only browser acceptance fixture. Never opens production DB.
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights, getAccountInsight } from '../lib/product-insights.mjs';
import { businessDateKey } from '../lib/utils.mjs';

const directory = await mkdtemp(join(tmpdir(), 'mcn-live-sync-browser-'));
const database = new MonitorDatabase(join(directory, 'fixture.sqlite'));
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const port = Number(process.env.LIVE_SYNC_FIXTURE_PORT || 4199);
let revision = 0, failure = '', reads = { status: 0, overview: 0, detail: 0 };
const targets = [];
const today = businessDateKey(new Date());
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const insert = database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
  quality_status,account_status,works_coverage,source_checksum)
  VALUES(?,?,?,?,?,'validated','available','complete',?)`);
for (let i = 1; i <= 26; i++) {
  const target = database.createTarget({ type: 'account', provider: 'manual', label: `隔离测试作者${String(i).padStart(2,'0')}`,
    locator: `test-only-live-sync-${i}`, metadata: { platform: 'douyin' } });
  targets.push(target);
  database.assignTargetsToBoard([target.id], '隔离测试矩阵');
  insert.run(target.id, new Date(`${yesterday}T12:00:00+08:00`).toISOString(), 1000 + i, 10000 + i, 10, `fixture-base-${i}`);
}
function advance() {
  revision++;
  for (let i=0; i<targets.length; i++) insert.run(targets[i].id, new Date().toISOString(),
    1000 + i + 1 + revision * 10, 10000 + i + 1 + revision * 100, 10 + revision, `fixture-${revision}-${i}`);
  return { revision };
}
advance();
const json = (response, status, body) => { response.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'}); response.end(JSON.stringify(body)); };
const assets = new Map([['/', 'rebuild.html'], ['/rebuild.html','rebuild.html'], ['/rebuild.js','rebuild.js'],
  ['/rebuild.css','rebuild.css'], ['/console-model.js','console-model.js'], ['/live-sync.js','live-sync.js'], ['/favicon.svg','favicon.svg']]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`), path = url.pathname;
    if (path === '/__fixture/advance' && request.method === 'POST') return json(response,200,advance());
    if (path === '/__fixture/failure' && request.method === 'POST') {
      failure = ['status','overview'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : '';
      return json(response,200,{failure});
    }
    if (path === '/__fixture/state') return json(response,200,{revision,failure,reads,directory,testOnly:true});
    if (request.method !== 'GET') return json(response,405,{error:'隔离测试不允许业务写入'});
    if (path === '/api/auth/session') return json(response,200,{authenticated:true,user:{id:1,role:'admin',displayName:'隔离测试'},csrfToken:'fixture-only'});
    if (path === '/api/monitoring-status') {
      reads.status++;
      if (failure === 'status') return json(response,503,{error:'隔离测试状态网络失败'});
      return json(response,200,{checkedAt:new Date().toISOString(),scheduler:{running:true,scheduleIntervalHours:8,
        slotTimes:['02:00','10:00','18:00'],currentSlotKey:`${today}T02:00+08:00`,nextRunAt:new Date(Date.now()+3600000).toISOString(),
        scheduledAccountTargetCount:26,scheduledProfileCompletedTargetCount:26,scheduledWorksCompleteTargetCount:26,
        currentRun:{runId:1,completedCount:revision,heartbeatAt:`fixture-${revision}`}},
        sourcePoller:{updatedAt:'fixture-stable',sourceCount:1,checkedTodayCount:1,uncheckedCount:0,failedCount:0,blockedCount:0,staleCount:0}});
    }
    const options = Object.fromEntries(url.searchParams); options.timeZone='Asia/Shanghai';
    if (path === '/api/rebuild/insights') {
      reads.overview++;
      if (failure === 'overview') return json(response,503,{error:'隔离测试快照网络失败'});
      return json(response,200,getProductInsights(database,options));
    }
    const match = /^\/api\/rebuild\/accounts\/(\d+)\/insights$/.exec(path);
    if (match) { reads.detail++; return json(response,200,getAccountInsight(database,Number(match[1]),options)); }
    if (path === '/api/topics/history') return json(response,200,{topics:[],testOnly:true});
    const asset = assets.get(path);
    if (!asset) return json(response,404,{error:'fixture route not found'});
    let body = await readFile(join(publicDir,asset));
    if (asset.endsWith('.html')) body = Buffer.from(body.toString().replace('<body>','<body><div style="padding:8px;background:#ffe8a3;color:#231b05;font-weight:700">隔离测试环境 · 虚构账号，请勿用于业务</div>'));
    response.writeHead(200,{'Content-Type':asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':asset.endsWith('.svg')?'image/svg+xml':'text/html','Cache-Control':'no-store'});
    response.end(body);
  } catch(error) { json(response,500,{error:String(error.message)}); }
});
let stopping=false;
function stop() { if(stopping)return; stopping=true; server.closeAllConnections(); server.close(()=>{database.close();process.exit(0);}); }
process.once('SIGTERM',stop); process.once('SIGINT',stop);
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({fixture:true,url:`http://127.0.0.1:${port}`,directory,expiresInMinutes:20})));
setTimeout(stop,20*60_000).unref();

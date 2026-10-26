import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {clean,contentId,digest,identity,latestSources,pendingSourceAuthors,tableFoundation} from '../lib/table-foundation.mjs';
import {canonicalSourceAuthors} from '../lib/creator-intelligence.mjs';
import {readValidatedCurrentSourceLinks} from '../lib/current-source-link-bridge.mjs';

const [monitorPath,creatorPath,outputPath]=process.argv.slice(2);
if(![monitorPath,creatorPath,outputPath].every(value=>value?.startsWith('/')))throw Error('需要主库、作者总表库与公开目录的绝对路径');
const monitor=new DatabaseSync(resolve(monitorPath),{readOnly:true}),creator=new DatabaseSync(resolve(creatorPath),{readOnly:true});
try{
 monitor.exec('PRAGMA query_only=ON; BEGIN');creator.exec('PRAGMA query_only=ON; BEGIN');
 const sourceRows=creator.prepare('SELECT sheet_id,row_number,values_json FROM source_rows WHERE sheet_id IN (?,?) ORDER BY sheet_id,row_number').all('08','09');
 const rawBaseAuthors=[],baseWorks=[];
 for(const item of sourceRows){const row=JSON.parse(item.values_json);if(item.sheet_id==='08')rawBaseAuthors.push({row:item.row_number,name:row[0],douyinId:row[1],posts:Number(row[6]??0),plays:Number(row[11]??0),likes:Number(row[12]??0),targetIds:[]});else baseWorks.push({contentId:row[0]});}
 const {authors:baseAuthors,collapsed}=canonicalSourceAuthors(rawBaseAuthors);
 const targetIds=new Map();
 for(const target of monitor.prepare("SELECT id,metadata_json FROM targets WHERE type='account'").all()){
  let meta;try{meta=JSON.parse(target.metadata_json||'{}');}catch{continue;}
  const key=identity(meta.douyinId);if(!key)continue;
  const ids=targetIds.get(key)||[];ids.push(target.id);targetIds.set(key,ids);
 }
 const currentLinks=await readValidatedCurrentSourceLinks(creator,monitor,monitorPath,{allowAbsent:true});
 for(const link of currentLinks.accountLinks){
  const key=identity(link.matched_id);if(!key)continue;
  const ids=targetIds.get(key)||[];
  if(!ids.includes(link.target_id))ids.push(link.target_id);
  targetIds.set(key,ids);
 }
 const jobs=monitor.prepare("SELECT id,created_at,finished_at,request_json FROM author_resolution_jobs WHERE status='completed'").all();
 const sources=latestSources(jobs);
 const foundation=tableFoundation({sources,baseAuthors,baseWorks,targetIds});
 let pendingAuthors=[];
 if(monitor.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='master_roster_imports'").get()){
  // The exporter reads the same canonical union as the local dashboard, but
  // only serializes the old source-only rows missing from existing partitions.
  // The temporary test DB has no master roster and deliberately skips this.
  const workbenchRoot=dirname(dirname(resolve(monitorPath)));
  const [{MonitorDatabase,normalizeBoardKey},{getProductInsights}]=await Promise.all([
   import(pathToFileURL(join(workbenchRoot,'lib/database.mjs')).href),
   import(pathToFileURL(join(workbenchRoot,'lib/product-insights.mjs')).href),
  ]);
  monitor.function('normalize_board_key',{deterministic:true},normalizeBoardKey);
  const adapter=Object.assign(Object.create(MonitorDatabase.prototype),{db:monitor,filePath:resolve(monitorPath)});
  const endDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const roster=getProductInsights(adapter,{period:'custom',startDate:'2026-09-12',endDate,
   reference:new Date().toISOString(),timeZone:'Asia/Shanghai',theme:'tuantuan',includeRecordedWindow:false});
  pendingAuthors=pendingSourceAuthors({rosterAccounts:roster.accounts,baseAuthors,supplementAuthors:foundation.authors});
 }
 const observations=[];const observedWorkIds=new Set(),baseWorkIds=new Set(baseWorks.map(row=>contentId(row.contentId)).filter(Boolean));
 const extraWorkIds=new Set(foundation.works.map(row=>row.contentId));
 for(const entry of creator.prepare("SELECT row_number,values_json FROM source_rows WHERE sheet_id='10' ORDER BY row_number").all()){
  const row=JSON.parse(entry.values_json),id=contentId(row[5]);if(!id)continue;
  const number=value=>{
   if(value==null||typeof value==='boolean'||typeof value==='object'||typeof value==='string'&&!value.trim())return null;
   const parsed=Number(value);
   return Number.isSafeInteger(parsed)&&parsed>=0?parsed:null;
  };
  const timestamp=Date.parse(row[13]);
  observations.push({contentId:id,author:clean(row[2],160),douyinId:clean(row[3],120),likes:number(row[8]),plays:number(row[9]),observedAt:Number.isFinite(timestamp)?new Date(timestamp).toISOString():null,sourceRow:entry.row_number});
  observedWorkIds.add(id);
  if(!baseWorkIds.has(id)&&!extraWorkIds.has(id)){
   foundation.works.push({contentId:id,author:clean(row[2],160),douyinId:clean(row[3],120),publishDate:null,type:null,track:null,tracks:null,plays:null,likes:null,title:null,url:null,evidenceRows:1,sourceTitles:['10_切片激励来源观测']});
   extraWorkIds.add(id);
  }
 }
 foundation.works.sort((a,b)=>a.contentId.localeCompare(b.contentId));foundation.stats.additionalWorks=foundation.works.length;
 foundation.stats.sourceMetricObservations=observations.length;foundation.stats.sourceMetricWorkIds=observedWorkIds.size;
 const sheetStats=creator.prepare('SELECT sheet_id,sheet_name,row_count AS rows,restricted FROM source_sheets ORDER BY sheet_id').all()
  .map(sheet=>({id:sheet.sheet_id,name:sheet.restricted?'受限原始表':clean(sheet.sheet_name,100),rows:sheet.rows,restricted:!!sheet.restricted}));
 const revision=digest(JSON.stringify(sources.map(source=>[source.key,source.job.id,source.revision]))
  +JSON.stringify(sheetStats)+digest(JSON.stringify(pendingAuthors))+currentLinks.fingerprint);
 await mkdir(resolve(outputPath),{recursive:true});
 const files=[];
 for(const [name,items] of [['authors.json',foundation.authors],['works.json',foundation.works],['sources.json',foundation.sources],['observations.json',observations],['other-authors.json',foundation.otherAuthors],['other-works.json',foundation.otherWorks],['pending-authors.json',pendingAuthors]]){
  const body=JSON.stringify({revision,items})+'\n';await writeFile(join(resolve(outputPath),name),body);
  files.push({path:name,count:items.length,bytes:Buffer.byteLength(body),sha256:digest(body)});
 }
 const index={version:1,revision,generatedAt:new Date().toISOString(),linkMode:currentLinks.mode,linkFingerprint:currentLinks.fingerprint,stats:{...foundation.stats,baseAuthorRows:rawBaseAuthors.length,reciprocalDuplicates:collapsed.length,baseAuthors:baseAuthors.length,baseWorks:baseWorks.length,sheets:sheetStats.length,pendingAuthors:pendingAuthors.length},sheetCoverage:sheetStats,files,
  semantics:{authors:'补充表格只按明确抖音号并入团团；昵称不用于身份合并；其他板块保持原表板块或未分板块',pendingAuthors:'旧总表和实时来源中尚未监控且未被作者分区覆盖的团团作者；按稳定行键保留来源，全部指标缺测，不因昵称推断身份',works:'仅用16-22位抖音作品ID补充去重作品；无作品ID的链接记录仍留在本机原始来源',metrics:'10号工作表的指标按原始来源行及观测时间单独展示，不覆盖09号去重作品累计值，不推算每日增长；缺失显示横线',privacy:'仅发布必要作者/作品身份与来源标题；原始行、授权、奖金及登录态不公开'}};
 await writeFile(join(resolve(outputPath),'index.json'),JSON.stringify(index)+'\n');
 console.log(JSON.stringify({revision,stats:index.stats,files:files.length}));
}finally{try{monitor.exec('ROLLBACK');}catch{}try{creator.exec('ROLLBACK');}catch{}monitor.close();creator.close();}

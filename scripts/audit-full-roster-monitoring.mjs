import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {buildTuantuanRoster} from '../../mcn-public-site/lib/tuantuan-roster.mjs';
import {validateSubmittedAccountId} from '../lib/author-spreadsheet.mjs';
import {MonitorDatabase,normalizeBoardKey} from '../lib/database.mjs';
import {getProductInsights} from '../lib/product-insights.mjs';
import {readCurrentCreatorSourceLinks} from '../lib/creator-source-current-links.mjs';
const root=resolve(import.meta.dirname,'..');
const normal=v=>validateSubmittedAccountId(v,'douyin').value.toLowerCase();
const file=p=>JSON.parse(readFileSync(p,'utf8'));
const db=new DatabaseSync(`${root}/data/douyin-monitor.sqlite`,{readOnly:true});
db.function('normalize_board_key',{deterministic:true},normalizeBoardKey);
db.exec('PRAGMA query_only=ON;BEGIN');
const adapter=Object.create(MonitorDatabase.prototype);adapter.db=db;
const accounts=getProductInsights(adapter,{theme:'tuantuan',period:'day',includeRecordedWindow:false}).accounts;
const published=resolve(root,'../mcn-public-site/public');
const links=readCurrentCreatorSourceLinks(db).accountLinks;
const byRow=new Map();for(const x of links){const list=byRow.get(x.author_row)??[];list.push(x.target_id);byRow.set(x.author_row,list);}
const base=file(`${published}/creator-source/authors.json`).items.map(x=>({...x,targetIds:byRow.get(x.row)??[]}));
const roster=buildTuantuanRoster(base,accounts,
 file(`${published}/table-foundation/authors.json`).items,file(`${published}/table-foundation/pending-authors.json`).items);
const queues=db.prepare('SELECT id,douyin_id,status,attempts,last_error,resolved_target_id,lease_owner,updated_at,video_ids_json,share_urls_json FROM author_resolution_queue').all();
const byHandle=new Map();for(const q of queues){const key=normal(q.douyin_id);if(!key)continue;const a=byHandle.get(key)??[];a.push(q);byHandle.set(key,a);}
const targets=new Map(db.prepare('SELECT id,enabled,last_checked_at FROM targets').all().map(t=>[t.id,t]));
const counts={},items=roster.rows.map(row=>{
 const source=row.source;const handles=[...new Set([source?.douyinId,source?.submittedAccountId,...(source?.douyinIds??[])].map(normal).filter(Boolean))];
 const found=[...new Map(handles.flatMap(h=>byHandle.get(h)??[]).map(q=>[q.id,q])).values()];
 const linked=[...new Set(row.accounts.map(a=>a.id))];
 const active=linked.some(id=>targets.get(id)?.enabled===1);
 const pending=found.filter(q=>['pending','retry'].includes(q.status));
 const state=active?'monitoring':linked.length?'identity_conflict_paused':pending.length?'resolving':found.some(q=>q.status==='resolved')?'source_binding_needed':found.length?'previous_resolution_failed':handles.length?'identity_search_needed':'identifier_repair_needed';
 counts[state]=(counts[state]??0)+1;
 return {key:row.key,name:source?.name??row.accounts[0]?.label,handles,state,targetIds:linked,queueIds:found.map(q=>q.id),
  lastErrors:[...new Set(found.map(q=>q.last_error).filter(Boolean))].slice(0,3),
  sourceRow:source?.row??null,sourceRows:source?.sourceRows??null,sourceTitles:source?.sourceTitles??null};
});
const report={generatedAt:new Date().toISOString(),scope:'tuantuan',authorCount:items.length,counts,
 semantics:'关联排队不等于采集成功；缺定位信息与失败作者仍保留在全量审查范围。',items};
const out=process.argv[2]??`${root}/data/maintenance-journal/2026-10-26-full-roster-monitoring.json`;mkdirSync(resolve(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2));
console.log(JSON.stringify({path:out,authorCount:report.authorCount,counts}));db.exec('ROLLBACK');db.close();

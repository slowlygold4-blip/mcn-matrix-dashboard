import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../reports/2026-10-05/',import.meta.url);
const read=k=>JSON.parse(readFileSync(new URL(`evidence/${k}.json`,root)));
const datasets=Object.fromEntries(['accumulated','week','priorWeek','month','today'].map(k=>[k,read(k)]));
const keys=['followers','likes','posts'];
function stats(rows){
  const a=rows.filter(x=>x.enabled);
  return {count:a.length, ...Object.fromEntries(keys.map(k=>{const ok=a.filter(x=>x.metrics[k].comparable&&Number.isFinite(x.metrics[k].delta));
    return [k,{n:ok.length,delta:ok.length?ok.reduce((s,x)=>s+x.metrics[k].delta,0):null,gain:ok.filter(x=>x.metrics[k].delta>0).length,loss:ok.filter(x=>x.metrics[k].delta<0).length,flat:ok.filter(x=>x.metrics[k].delta===0).length}]}))};
}
function info(a){return {id:a.id,name:a.label,theme:a.classification?.theme?.label,labels:a.classification?.labels?.map(x=>x.label),platform:a.platform,...Object.fromEntries(keys.map(k=>[k,a.metrics[k].comparable?a.metrics[k].delta:null]))};}
function rankings(d,k,n=8){const rows=d.accounts.filter(a=>a.enabled&&a.metrics[k].comparable);
  return {up:[...rows].filter(a=>a.metrics[k].delta>0).sort((a,b)=>b.metrics[k].delta-a.metrics[k].delta).slice(0,n).map(info),down:[...rows].filter(a=>a.metrics[k].delta<0).sort((a,b)=>a.metrics[k].delta-b.metrics[k].delta).slice(0,n).map(info)};}
const w=datasets.week;
const themes=[...new Set(w.accounts.filter(a=>a.enabled).map(a=>a.classification?.theme?.key||'unassigned'))].map(key=>{
  const rows=w.accounts.filter(a=>(a.classification?.theme?.key||'unassigned')===key);
  return {key,label:rows[0]?.classification?.theme?.label||'待归属',...stats(rows)};
}).sort((a,b)=>b.count-a.count);
const main={manifest:read('manifest'),periods:Object.fromEntries(Object.entries(datasets).map(([k,d])=>[k,{range:d.range,counts:stats(d.accounts),metrics:d.summary.metrics,coverage:d.summary.collectionCoverage,works:d.summary.worksObservation,trend:d.summary.trend}])),themes,
  commonWindow:datasets.accumulated.recordedWindow,
  rankings:{followers:rankings(w,'followers'),likes:rankings(w,'likes'),posts:rankings(w,'posts')},
  tuantuan:{week:stats(w.accounts.filter(a=>a.classification?.theme?.key==='tuantuan')),month:stats(datasets.month.accounts.filter(a=>a.classification?.theme?.key==='tuantuan')),
    ranking:rankings({...w,accounts:w.accounts.filter(a=>a.classification?.theme?.key==='tuantuan')},'likes'),
    labels:[...new Set(w.accounts.filter(a=>a.enabled&&a.classification?.theme?.key==='tuantuan').flatMap(a=>a.classification?.labels?.map(x=>x.key)||[]))].map(key=>{const rows=w.accounts.filter(a=>a.classification?.theme?.key==='tuantuan'&&a.classification?.labels?.some(x=>x.key===key));return {key,label:rows[0].classification.labels.find(x=>x.key===key).label,...stats(rows)}})},
  pairedWeek:Object.fromEntries(keys.map(k=>{const p=new Map(datasets.priorWeek.accounts.filter(a=>a.enabled&&a.metrics[k].comparable).map(a=>[a.id,a]));const a=w.accounts.filter(a=>a.enabled&&a.metrics[k].comparable&&p.has(a.id));const prior=a.reduce((s,x)=>s+p.get(x.id).metrics[k].delta,0);const current=a.reduce((s,x)=>s+x.metrics[k].delta,0);return [k,{n:a.length,prior,current,difference:current-prior,percent:prior>0?(current/prior-1)*100:null}]})),
  topics:read('topics')};
main.tuantuan.pairedWeek=Object.fromEntries(keys.map(k=>{const p=new Map(datasets.priorWeek.accounts.filter(a=>a.enabled&&a.classification?.theme?.key==='tuantuan'&&a.metrics[k].comparable).map(a=>[a.id,a]));const a=w.accounts.filter(a=>a.enabled&&a.classification?.theme?.key==='tuantuan'&&a.metrics[k].comparable&&p.has(a.id));const prior=a.reduce((s,x)=>s+p.get(x.id).metrics[k].delta,0);const current=a.reduce((s,x)=>s+x.metrics[k].delta,0);return [k,{n:a.length,prior,current,percent:prior>0?(current/prior-1)*100:null}]}));
for(const [period,d] of Object.entries(datasets)) for(const k of keys){const got=stats(d.accounts)[k];if(got.delta!==d.summary.metrics[k].delta||got.n!==d.summary.metrics[k].comparableCount)throw new Error(`Mismatch ${period} ${k}`)}
writeFileSync(new URL('evidence/analysis.json',root),JSON.stringify(main,null,2));
// Preserve numeric negatives; imported names remain text in spreadsheet apps.
const csv=v=>'"'+((typeof v==='string' && /^[=+@\-]/.test(v))?"'"+v:String(v??'')).replaceAll('"','""')+'"';
const headers=['账号ID','账号名称','平台','大主题','内容标签','期间','开始日期','结束日期','启用','粉丝净变化','获赞净变化','作品存量净变化','估算播放变化 获赞净变化x100','粉丝期末已知值','获赞期末已知值','作品期末已知值','粉丝基准采样时间UTC','粉丝末次采样时间UTC','获赞基准采样时间UTC','获赞末次采样时间UTC','作品基准采样时间UTC','作品末次采样时间UTC'];
const lines=[headers];
for(const [period,d] of Object.entries(datasets))for(const a of d.accounts)lines.push([a.id,a.label,a.platform,a.classification?.theme?.label,a.classification?.labels?.map(x=>x.label).join('/'),period,d.range.startDate,d.range.endDate,a.enabled,...keys.map(k=>a.metrics[k].comparable?a.metrics[k].delta:null),a.metrics.likes.comparable?a.metrics.likes.delta*100:null,...keys.map(k=>a.metrics[k].value),...keys.flatMap(k=>[a.metrics[k].baselineAt,a.metrics[k].currentAt])]);
writeFileSync(new URL('账号变化明细.csv',root),'\uFEFF'+lines.map(r=>r.map(csv).join(',')).join('\r\n'));
console.log(JSON.stringify({...main,manifest:main.manifest,periods:Object.fromEntries(Object.entries(main.periods).map(([k,d])=>[k,{range:d.range,counts:d.counts,coverage:d.coverage,works:d.works}])),commonWindow:{baselineDate:main.commonWindow?.baselineDate,endDate:main.commonWindow?.endDate,n:main.commonWindow?.comparableCount,metrics:Object.fromEntries(keys.map(k=>[k,main.commonWindow?.metrics[k].delta]))},topics:main.topics.topics.map(t=>({name:t.label,last:t.points?.at(-1),keys:Object.keys(t)}))},null,2));

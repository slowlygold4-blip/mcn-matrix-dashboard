import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

// Actual local components and React SSR; no network, browser, database or Site writes.
const site=fileURLToPath(new URL('../../mcn-public-site/',import.meta.url));
const root=fileURLToPath(new URL('../',import.meta.url));
const requireSite=createRequire(join(site,'package.json')),ts=requireSite('typescript');
const React=requireSite('react'),{renderToStaticMarkup}=requireSite('react-dom/server');
const cache=new Map(),hash=b=>createHash('sha256').update(b).digest('hex');
function load(name){
 const base=join(site,name);const path=[base,base+'.tsx',base+'.ts'].find(p=>existsSync(p));assert.ok(path,name);
 if(cache.has(path))return cache.get(path);
 const result={};cache.set(path,result);
 const compiled=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(compiled,{exports:result,require(spec){return spec.startsWith('@/')?load(spec.slice(2)):requireSite(spec);},console,Date});
 return result;
}
const {TopicHistory}=load('components/topic-history.tsx'),{ScrollableTable}=load('components/scrollable-table.tsx');
const dataPath=join(root,'data/public-replica-staging/publisher-2026-10-02T00-15-01-829Z/topics.json');
const bytes=readFileSync(dataPath),data=JSON.parse(bytes),before=JSON.stringify(data);
const sourceHash='ce79400a3e13e2b09a21919502cce6ea01966517e7f0f261adbbd47be5ce76d2';
assert.equal(hash(bytes),sourceHash);
const render=(topic,items)=>renderToStaticMarkup(React.createElement(TopicHistory,{topic,items}));
const bj=s=>new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const plain=s=>s.replace(/<[^>]+>/g,'');
const metric=v=>v==null?'—':v.toLocaleString('zh-CN');
const codes=s=>[...s.matchAll(/<code>(.*?)<\/code>/g)].map(x=>x[1]);

test('actual published 68 days /136 metric cells /30 nulls are preserved with source-bound times and baselines',()=>{
 let days=0,cells=0,nulls=0,baselineCount=0;
 for(const topic of data.topics){
  const html=render(topic,data.items),expected=data.items.filter(x=>x.targetId===topic.id).sort((a,b)=>b.date.localeCompare(a.date));
  const body=html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)[1],rows=[...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(x=>x[1]);
  assert.equal(rows.length,expected.length);
  rows.forEach((row,i)=>{const x=expected[i],td=[...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x=>x[1]);
   assert.equal(td.length,3);assert.ok(td[0].includes(x.date));assert.ok(td[0].includes(bj(x.capturedAt)));assert.ok(codes(td[0]).includes(x.sourceChecksum));
   for(const [col,key] of [[1,'participants'],[2,'views']]){assert.equal(plain(td[col]),metric(x[key]));cells++;if(x[key]===null)nulls++;}
   for(const key of ['participants','views'])if(x[key+'Delta']!==null){assert.ok(td[0].includes(bj(x[key+'BaselineAt'])));assert.ok(codes(td[0]).includes(x[key+'BaselineChecksum']));baselineCount++;}
   days++;
  });
  const latest=expected[0];assert.ok(html.includes('最近采样记录 '+bj(latest.capturedAt)));
  for(const key of ['participants','views']){
   const observed=expected.find(point=>point[key]!==null);
   if(observed){assert.ok(html.includes(`最近有效采样 ${bj(observed.capturedAt)}`));assert.ok(html.includes(`<strong>${metric(observed[key])}</strong>`));}
   else assert.ok(html.includes('尚无有效采样'));
  }
 }
 assert.equal(days,68);assert.equal(cells,136);assert.equal(nulls,30);assert.ok(baselineCount>0);assert.equal(JSON.stringify(data),before);
 console.info('SOURCE_REVIEW_REAL '+JSON.stringify({days,cells,nulls,baselineCount,sourceHash}));
});

test('null is not zero; negative/positive deltas use saved values and distinct saved baseline fingerprints',()=>{
 const x={...data.items[0],participants:null,views:0,participantsDelta:-7,viewsDelta:9,participantsBaselineAt:'2026-09-13T11:12:13Z',viewsBaselineAt:'2026-09-13T12:13:14Z',participantsBaselineChecksum:'a'.repeat(64),viewsBaselineChecksum:'b'.repeat(64)};
 const html=render(data.topics[0],[x]);assert.ok(html.includes('<strong>—</strong>'));assert.ok(html.includes('<strong>0</strong>'));assert.doesNotMatch(plain(html),/相邻日变化\s*-7(?:人|次)/,'a missing metric cannot surface a contradictory delta');assert.match(plain(html),/相邻日变化\s*\+9(?:人|次)/);assert.ok(codes(html).includes('a'.repeat(64)));assert.ok(codes(html).includes('b'.repeat(64)));
});

test('untrusted fingerprint/status/time cannot become link, HTML or credential disclosure',()=>{
 const marker='Bearer PRIVATE_TEST_SENTINEL';const x={...data.items[0],capturedAt:'not-a-date',sourceChecksum:marker,qualityStatus:marker,metricsEvidence:marker,participantsDelta:null,viewsDelta:null};
 const html=render({...data.topics[0],label:'<script>alert(1)</script>'},[x]);
 assert.doesNotMatch(html,/PRIVATE_TEST_SENTINEL|<script>|href=|https?:\/\//);assert.ok(html.includes('未保存有效指纹'));assert.ok(html.includes('未识别状态'));assert.ok(html.includes('未通过当前来源校验'));assert.ok(html.includes('真实采样时间（北京时间）：未保存'));
});

test('strict topic scope and empty/null baseline cases do not invent history or mutate incoming rows',()=>{
 const x={...data.items[0],participantsDelta:null,viewsDelta:null,participantsBaselineChecksum:'c'.repeat(64),viewsBaselineChecksum:'d'.repeat(64)};
 const html=render(data.topics[0],[x,...data.items.filter(x=>x.targetId!==data.topics[0].id)]);
 assert.ok(html.includes('全部 1 个已保存采样日'));assert.ok(!codes(html).includes('c'.repeat(64)));assert.ok(!codes(html).includes('d'.repeat(64)));
 const empty=render(data.topics[0],[]);assert.ok(empty.includes('全部 0 个'));assert.ok(empty.includes('暂无已保存的采样日'));assert.ok(empty.includes('<strong>—</strong>'));
});

test('native disclosures retain accessible names/focus CSS; actual scroll keyboard handler excludes descendant summaries',()=>{
 const html=render(data.topics[0],data.items);assert.ok(html.includes('<summary aria-label="查看 '));assert.ok(html.includes('tabindex="0"'));assert.ok(html.includes('role="region"'));
 const css=readFileSync(join(site,'app/replica.css'),'utf8');assert.match(css,/\.topic-days summary:focus-visible\s*\{outline:2px/);assert.match(css,/\.topic-source code\s*\{[^}]*overflow-wrap:anywhere/);
 const keyboardExports={};
 const keyboardSource=ts.transpileModule(readFileSync(join(site,'components/scrollable-table.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(keyboardSource,{exports:keyboardExports,require(spec){if(spec==='react')return {useRef:value=>({current:value}),useEffect:fn=>fn()};if(spec==='@/components/ui/table')return {Table:'BaseTable'};return requireSite(spec);}});
 const tree=keyboardExports.ScrollableTable({children:[]}),region=tree.props.children[1];let moves=0,prevented=0;
 const owner={querySelector:()=>({scrollWidth:1000,clientWidth:100,scrollBy:()=>moves++,scrollTo:()=>moves++})};
 region.props.onKeyDown({target:{},currentTarget:owner,key:'ArrowRight',preventDefault:()=>prevented++});assert.equal(moves,0);
 region.props.onKeyDown({target:owner,currentTarget:owner,key:'ArrowRight',preventDefault:()=>prevented++});assert.equal(moves,1);assert.equal(prevented,1);
});

test('owner integration only replaces the old topic renderer; math and data transport outside that renderer are byte-identical',()=>{
 let currentSource=readFileSync(join(site,'app/page.tsx'),'utf8');const old=readFileSync(join(root,'data/backups/phase90-code-20261002/page.tsx'),'utf8');
 const pagerFocus=JSON.parse(readFileSync(join(root,'test/fixtures/phase120-approved-pager-focus.json'),'utf8'));
 assert.equal(hash(currentSource),pagerFocus.sourceAfterSha256);
 assert.equal(currentSource.split(pagerFocus.after).length,2);
 currentSource=currentSource.replace(pagerFocus.after,pagerFocus.before);
 assert.equal(hash(currentSource),pagerFocus.sourceBeforeSha256);
 const pagerApproved=JSON.parse(readFileSync(join(root,'test/fixtures/phase119-approved-pager-ui.json'),'utf8'));
 assert.equal(hash(currentSource),pagerApproved.pageAfterSha);
 for(const delta of [...pagerApproved.pageDeltas].reverse()){assert.equal(currentSource.split(delta.after).length,2);currentSource=currentSource.replace(delta.after,delta.before);}
 assert.equal(hash(currentSource),pagerApproved.pageBeforeSha);
 const trendApproved=JSON.parse(readFileSync(join(root,'test/fixtures/phase114-approved-trend-ui.json'),'utf8'));
 assert.equal(hash(currentSource),trendApproved.sources['app/page.tsx'].after);
 for(const delta of trendApproved.pageDeltas){assert.equal(currentSource.split(delta.after).length,2);currentSource=currentSource.replace(delta.after,delta.before);}
 assert.equal(hash(currentSource),trendApproved.sources['app/page.tsx'].before);
 // Six exact reviewed history UI deltas reverse to the prior sealed Home.
 // This preserves the original full-byte math/transport lock below.
 const historyApproved=JSON.parse(readFileSync(join(root,'test/fixtures/phase96-approved-history-ui.json'),'utf8'));
 const ledgerApproved=JSON.parse(readFileSync(join(root,'test/fixtures/phase108-approved-ledger-ui.json'),'utf8'));
 assert.equal(hash(currentSource),ledgerApproved.sources['app/page.tsx'].after);
 assert.equal(hash(readFileSync(join(site,'components/scrollable-table.tsx'))),ledgerApproved.sources['components/scrollable-table.tsx'].after);
 assert.equal(currentSource.split(ledgerApproved.pageProps).length,2);
 let current=currentSource.replace(ledgerApproved.pageProps,'');
 assert.equal(hash(current),ledgerApproved.sources['app/page.tsx'].before);
 assert.equal(hash(current),historyApproved.reviewedSourceSha256);
 for(const delta of historyApproved.deltas){const needle=delta.before?delta.after:delta.previousAnchor+delta.after;assert.equal(current.split(needle).length,2);current=current.replace(needle,delta.before||delta.previousAnchor);}
 assert.equal(hash(current),historyApproved.previousSourceSha256);
 // Phase93's independently reviewed shortcuts are an exact reversible UI delta,
 // not a blanket exclusion of the account renderer or transport from this lock.
 const approved=JSON.parse(readFileSync(join(root,'test/fixtures/phase93-approved-workspace-ui.json'),'utf8'));
 assert.equal(hash(current),approved.reviewedSourceSha256);
 assert.equal(current.split(approved.afterAccountLine).length,2);
 assert.equal(current.includes(approved.beforeAccountLine),false);
 const withoutApprovedUi=current.replace(approved.afterAccountLine,approved.beforeAccountLine);
 const strip=s=>s.replace("import {TopicHistory} from '@/components/topic-history';\n",'').split('\n').filter(line=>!line.includes("{globalTab==='topics'&&")).join('\n');
 assert.equal(strip(withoutApprovedUi),strip(old));assert.ok(current.includes('items={data.topics.items}'));
 let css=readFileSync(join(site,'app/replica.css'),'utf8');
 assert.equal(hash(css),trendApproved.sources['app/replica.css'].after);
 assert.equal(css.split(trendApproved.addedCss).length,2);css=css.replace(trendApproved.addedCss,'');
 assert.equal(hash(css),trendApproved.sources['app/replica.css'].before);
 assert.equal(hash(css),ledgerApproved.sources['app/replica.css'].after);
 assert.equal(css.split(ledgerApproved.addedCss).length,2);
 css=css.replace(ledgerApproved.addedCss,'');
 assert.equal(hash(css),ledgerApproved.sources['app/replica.css'].before);
 const numberApproved=JSON.parse(readFileSync(join(root,'test/fixtures/phase99-approved-topic-numbers.json'),'utf8'));
 assert.equal(hash(css),numberApproved.reviewedCssSha256);
 for(const delta of numberApproved.deltas){assert.equal(css.split(delta.after).length,2);css=css.replace(delta.after,delta.before);}
 assert.equal(hash(css),numberApproved.previousCssSha256);
 const oldCss=readFileSync(join(root,'data/backups/phase90-code-20261002/replica.css'),'utf8');
 const addedRules=[
  '.topic-source {max-width:340px;min-width:180px;margin:8px 0;font-size:12px;line-height:1.6;color:var(--mcn-muted);white-space:normal;}',
  '.topic-source p {margin:7px 0;}',
  '.topic-source code {display:block;overflow-wrap:anywhere;white-space:normal;font-variant-numeric:tabular-nums;}',
  '.topic-days summary:focus-visible {outline:2px solid var(--mcn-ink);outline-offset:3px;border-radius:2px;}'
 ];
 for(const rule of addedRules)assert.equal(css.split(rule).length,2);
 for(const rule of approved.addedCssRules)assert.equal(css.split(rule).length,2);
 const cardBefore='.topics [data-slot=card] {box-shadow:none;border-color:var(--mcn-line);border-radius:12px;}',cardAfter='.topics [data-slot=card] {min-width:0;box-shadow:none;border-color:var(--mcn-line);border-radius:12px;}';
 const mobileBefore=' .topics {grid-template-columns:1fr;}.topic-values strong {font-size:23px;}',mobileAfter=' .topics {grid-template-columns:minmax(0,1fr);}.topic-values strong {font-size:23px;}';
 assert.equal(css.split(cardAfter).length,2);assert.equal(css.split(mobileAfter).length,2);
 const restoredCss=css.split('\n').filter(line=>!addedRules.includes(line)&&!approved.addedCssRules.includes(line)).join('\n').replace(cardAfter,cardBefore).replace(mobileAfter,mobileBefore);
 assert.equal(restoredCss,oldCss,'only four exact source rules plus two exact min-content fixes allowed; no hidden clipping or unrelated CSS');
 console.info('SOURCE_REVIEW_CODE '+JSON.stringify(Object.fromEntries(['components/topic-history.tsx','app/page.tsx','app/replica.css'].map(p=>[p,hash(readFileSync(join(site,p)))]))));
});

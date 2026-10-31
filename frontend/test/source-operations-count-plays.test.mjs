import {publishedFixture} from './helpers/published-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buildTuantuanRoster} from '../lib/tuantuan-roster.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sourcePath=name=>root+'public/creator-source/'+name;
const foundationPath=name=>root+'public/table-foundation/'+name;
const json=async path=>{const [section,...name]=path.split('/public/')[1].split('/');return publishedFixture().read(section,name.join('/'));};

async function sourceOperations(){
 const result=await build({entryPoints:[root+'components/source-operations.tsx'],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});
 const bundledModule={exports:{}};
 Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),bundledModule,bundledModule.exports);
 return bundledModule.exports.SourceOperations;
}

test('synthetic eight searchable identities reconcile to six authors and linked count is deduplicated',async()=>{
 const [source,authorsPart,insightsPart,foundationIndex,supplementPart,worksPart]=await Promise.all([
  json(sourcePath('index.json')),json(sourcePath('authors.json')),json(sourcePath('insights.json')),
  json(foundationPath('index.json')),json(foundationPath('authors.json')),json(foundationPath('works.json')),
 ]);
 const authors=authorsPart.items,supplements=supplementPart.items;
 const allTargetIds=[...new Set([...authors,...supplements].flatMap(author=>author.targetIds??[]))];
 const accounts=allTargetIds.map(id=>({id,platform:'douyin',enabled:true,classification:{theme:{key:'tuantuan'}}}));
 const roster=buildTuantuanRoster(authors,accounts,supplements);
 assert.equal(source.stats.authors,5);
 assert.equal(supplements.length,3);
 assert.equal(roster.counts.reconciledAliases,2);
 assert.equal(roster.counts.source,6);
 assert.equal(roster.counts.linkedSource,3);
 assert.equal(roster.counts.sourceWithoutThemeLink,3);

 const SourceOperations=await sourceOperations();
 const props={insights:insightsPart.items[0],source,foundation:{index:foundationIndex,authors:supplements,works:worksPart.items,otherAuthors:[],otherWorks:[],observations:[]},error:'',onInspect:()=>{},onNavigateAccounts:()=>{}};
 const verified=renderToStaticMarkup(React.createElement(SourceOperations,{...props,sourceRosterCount:roster.counts.source}));
 assert.match(verified,/团团表格作者（跨表去重）<\/small><strong>6<\/strong>/);
 assert.match(verified,/原表登记 8 个账号身份，.*其中 2 组同目标同名别名已合并/);
 assert.match(verified,/<strong>3<\/strong><span>去重后来源作者关联了稳定采样目标 ID<\/span>/);
 assert.match(verified,/<strong>3<\/strong><span>仅来源表，未关联采样目标 ID<\/span>/);
 assert.match(verified,/表格播放是原表填报的累计字段，并非平台逐条核验的实际播放/);
 assert.match(verified,/未经平台逐条独立核验/);

 const fallback=renderToStaticMarkup(React.createElement(SourceOperations,{...props,sourceRosterCount:null}));
 assert.match(fallback,/表格登记身份（去重待核）<\/small><strong>8<\/strong>/);
 assert.match(fallback,/<strong>—<\/strong><span>去重待核；已关联采样目标的原始身份数不能当作作者数<\/span>/);
});

test('missing supplement keeps verified main table visible without inventing full counts',async()=>{
 const [source,insightsPart]=await Promise.all([
  json(sourcePath('index.json')),json(sourcePath('insights.json')),
 ]);
 const SourceOperations=await sourceOperations();
 const base={insights:insightsPart.items[0],source,foundation:null,sourceRosterCount:6,onInspect:()=>{},onNavigateAccounts:()=>{}};
 const pending=renderToStaticMarkup(React.createElement(SourceOperations,{...base,error:''}));
 assert.match(pending,/补充表正在读取/);
 assert.match(pending,/总表登记身份（补充表待核）<\/small><strong>5<\/strong>/);
 assert.match(pending,/条已去重的总表作品 · 补充表待核/);
 assert.doesNotMatch(pending,/每天发了多少作品/,'the daily chart must read the unified monitoring publication index, not this static table');
 assert.match(pending,/原表有播放值的作品/);
 assert.match(pending,/补充来源观测待核/);
 assert.doesNotMatch(pending,/可比较的作品样本/);
 assert.doesNotMatch(pending,/团团表格作者（跨表去重）/);
 assert.doesNotMatch(pending,/表格分析暂不可读/);

 const failed=renderToStaticMarkup(React.createElement(SourceOperations,{...base,error:'',foundationError:'补充来源校验不一致'}));
 assert.match(failed,/补充表读取失败/);
 assert.match(failed,/原因：补充来源校验不一致/);
 assert.match(failed,/补充表未读，全部仅来源作者数待核/);
 assert.match(failed,/其他板块保存在补充表中；本次未读到补充表/);
 assert.match(failed,/下方曲线按记录日期归集<strong>每日作品记录<\/strong>/);
 assert.doesNotMatch(failed,/表格分析暂不可读/);

 // Accept the previous parent contract until it passes foundationError separately.
 const legacy=renderToStaticMarkup(React.createElement(SourceOperations,{...base,error:'旧版组合错误'}));
 assert.match(legacy,/补充表读取失败/);
 assert.match(legacy,/原因：旧版组合错误/);
 const critical=renderToStaticMarkup(React.createElement(SourceOperations,{...base,source:null,error:'主表校验失败'}));
 assert.match(critical,/表格分析暂不可读/);
 assert.doesNotMatch(critical,/每天发了多少作品/);
});

test('account growth preview is near the overview start and remains available when source tables fail',async()=>{
 const [source,insightsPart]=await Promise.all([json(sourcePath('index.json')),json(sourcePath('insights.json'))]);
 const SourceOperations=await sourceOperations();
 const accountPreview=React.createElement('section',{'data-preview':'growth'},'真实账号区间变化');
 const props={insights:insightsPart.items[0],source,foundation:null,sourceRosterCount:null,error:'',accountPreview,onInspect:()=>{},onNavigateAccounts:()=>{}};
 const ready=renderToStaticMarkup(React.createElement(SourceOperations,props));
 const preview=ready.indexOf('data-preview="growth"'),hero=ready.indexOf('class="source-ops-hero"'),wayfinder=ready.indexOf('class="source-ops-wayfinder"'),kpis=ready.indexOf('class="source-ops-kpis"');
 assert.ok(preview>=0&&preview<hero&&hero<wayfinder&&wayfinder<kpis,'real account deltas lead the overview; source-table works follow with an explicit boundary');
 assert.match(ready,/class="source-ops-archive"><summary><strong>原始登记与来源核对<\/strong>/);
 assert.doesNotMatch(ready,/class="source-ops-archive" open=/,'source analysis is available without competing with the current account overview');
 assert.match(ready,/原表作品日期至 2026-10-12，不是监控截止/);
 assert.match(ready,/class="source-ops-proofline"[^>]*><span><strong>来源表累计<\/strong>，不是期间新增播放<\/span>/);
 assert.match(ready,/aria-label="本页快速定位"/);
 for(const id of ['source-ops-tracks','source-ops-rankings','source-ops-quality'])assert.match(ready,new RegExp(`id="${id}"`));
 assert.match(ready,/class="source-ops-panel" id="source-ops-quality"[^>]*><p class="source-ops-kicker">数据可信度<\/p>/,'quality jump must land on the quality panel, not the preceding other-boards panel');
 const failed=renderToStaticMarkup(React.createElement(SourceOperations,{...props,source:null,error:'来源校验失败'}));
 assert.match(failed,/表格分析暂不可读/);
 assert.match(failed,/data-preview="growth"/,'account snapshots must not disappear with independent source-table failure');
});

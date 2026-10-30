import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mergeAuthorWorks,orderAuthorWorks,authorWorkExportRows} from '../lib/author-unified-works.mjs';
import {authorDailyPublication} from '../lib/author-daily-publication.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({entryPoints:[root+'components/author-daily-publishing.tsx'],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});
const mod={exports:{}};Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const render=model=>renderToStaticMarkup(React.createElement(mod.exports.AuthorDailyPublishing,{model,onlyDay:false,onDate(){},onFilter(){}}));
const model={date:'2026-10-30',end:'2026-10-30',status:'published',knownWorks:2,undatedWorks:1,futureDatedWorks:0,currentDay:true};
test('actual author daily section states a lower bound, calendar limits and a same-day drilldown',()=>{
 const html=render(model);
 for(const text of ['至少 2 条','当日尚未结束','无记录不能判断为未发布','另有 1 条','仅看这一天的作品','查看全部日期','min="2026-09-12"','max="2026-10-30"','aria-live="polite"','应用日期','name="publicationDate"','type="submit"'])assert.ok(html.includes(text),text);
});
test('unknown day cannot render zero published works or an actionable empty-day button',()=>{
 const html=render({...model,status:'unknown',knownWorks:0,currentDay:false});
 assert.match(html,/发布情况待确认/);assert.match(html,/disabled/);assert.doesNotMatch(html,/至少 0|未发布 0|当日尚未结束/);
});
test('the existing all-author dialog uses its unified works for day filtering, counts and export',()=>{
 const code=readFileSync(root+'components/author-unified-works.tsx','utf8');
 assert.match(code,/authorDailyPublication\(items,/);assert.match(code,/onlyDay\?daily.model\?\.rows/);assert.match(code,/authorWorkExportRows\(rows\)/);assert.match(code,/<AuthorDailyPublishing/);
 const asOf='2026-10-30T04:00:00.000Z',platformWorks=Array.from({length:24},(_,i)=>({id:i+1,targetId:1,externalId:String(7500000000000000000n+BigInt(i+1)),caption:i<21?'selected-day':'other-date',publishedAt:i<21?'2026-10-29T02:00:00.000Z':'2026-10-28T02:00:00.000Z',lastObservedAt:asOf,likes:i+1,plays:null}));
 const items=mergeAuthorWorks({author:{targetIds:[1]},sourceWorks:[],platformWorks,asOf}),daily=authorDailyPublication(items,{asOf,date:'2026-10-29'}),rows=orderAuthorWorks(daily.rows,'adoptedLikes','desc'),exported=authorWorkExportRows(rows);
 assert.equal(daily.knownWorks,21);assert.equal(exported.length,22,'all 21 matching works export even beyond the first page of 20');assert.equal(exported[1][3],21);assert.equal(exported.at(-1)[3],1);assert.equal(JSON.stringify(exported).includes('other-date'),false);
});

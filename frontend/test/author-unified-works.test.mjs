import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeAuthorWorks,orderAuthorWorks} from '../lib/author-unified-works.mjs';
import {readFileSync,readdirSync} from 'node:fs';
const author={name:'甲',douyinId:'a',douyinIds:['a','old-a'],targetIds:[9,10]};
const old={contentId:'7300000000000000001',douyinId:'old-a',likes:10,plays:100,title:'原作品',publishDate:'2026-09-12'};
const sample={id:1,targetId:9,externalId:old.contentId,likes:12,plays:0,lastObservedAt:'2026-10-26T08:00:00.000Z',playsEvidence:{mayBePlaceholder:true},publishedAt:'2026-09-12T04:00:00.000Z'};
test('same ID adopts one value per metric, includes new works and keeps missing as null',()=>{
 const rows=mergeAuthorWorks({author,sourceWorks:[old,{...old,contentId:'7300000000000000002',douyinId:'other'}],platformWorks:[sample,{...sample,id:2,externalId:'7300000000000000003',likes:null,plays:null}]});
 assert.equal(rows.length,2);assert.equal(rows[0].adoptedLikes,12);assert.equal(rows[0].adoptedPlays,100);assert.equal(rows[0].playsObservedAt,null);assert.equal(rows[0].likesObservedAt,sample.lastObservedAt);assert.equal(rows[1].adoptedLikes,null);assert.equal(rows[0].publicationDay,'2026-09-12');
});
test('latest saved sample replaces older duplicate without summing; wrong account is rejected',()=>{
 const rows=mergeAuthorWorks({author,sourceWorks:[old],platformWorks:[sample,{...sample,id:5,targetId:10,likes:8,lastObservedAt:'2026-10-25T08:00:00.000Z'}]});assert.equal(rows.length,1);assert.equal(rows[0].adoptedLikes,12);
 assert.throws(()=>mergeAuthorWorks({author,sourceWorks:[],platformWorks:[{...sample,targetId:99}]}),/身份/);
 assert.throws(()=>mergeAuthorWorks({author,sourceWorks:[old,old],platformWorks:[]}),/重复/);
});
test('sort uses displayed adopted values, missing last both directions; search uses title and ID',()=>{
 const rows=[{externalId:'1',caption:'旧作',adoptedLikes:null},{externalId:'2',caption:'新作',adoptedLikes:0},{externalId:'3',caption:'新作',adoptedLikes:20}];
 assert.deepEqual(orderAuthorWorks(rows,'adoptedLikes','desc').map(r=>r.externalId),['3','2','1']);assert.deepEqual(orderAuthorWorks(rows,'adoptedLikes','asc').map(r=>r.externalId),['2','3','1']);assert.equal(orderAuthorWorks(rows,'adoptedLikes','desc','新作').length,2);
});
test('real sealed data keeps source-only author works available',()=>{
 const base='public/creator-source/';const sources=readdirSync(base).filter(p=>/^works-.*json$/.test(p)).flatMap(p=>JSON.parse(readFileSync(base+p)).items);sources.push(...JSON.parse(readFileSync('public/table-foundation/works.json')).items);
 const a=JSON.parse(readFileSync(base+'authors.json')).items.find(a=>a.douyinId==='41548399093');assert.ok(a);
 const rows=mergeAuthorWorks({author:a,sourceWorks:sources,platformWorks:[]});assert.equal(rows.length,2);assert.equal(rows.reduce((n,r)=>n+r.adoptedLikes,0),47000);assert.equal(rows.reduce((n,r)=>n+r.adoptedPlays,0),1297000);
});

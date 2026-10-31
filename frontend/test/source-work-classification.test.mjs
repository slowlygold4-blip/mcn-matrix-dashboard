import test from 'node:test';import assert from 'node:assert/strict';
import {creatorPartValid,creatorEditionIdentityPayload} from '../lib/replica-creator.mjs';
import {sourceContentClassifications,sourceWorkClassificationLabel,sourceWorkClassificationsValid} from '../lib/source-work-classification.mjs';
import {belongsToSourceTrack} from '../lib/source-ledger-track.mjs';
import {filterSourceLedgerRows,sourceLedgerCsv} from '../lib/source-ledger-filters.mjs';
import {sourceLedgerDefaults,sourceLedgerSelectionPath,sourceLedgerSelection} from '../lib/source-ledger-navigation.mjs';
const at='2026-10-30T23:00:00.000Z';
const work={row:2,contentId:'7300000000000000001',author:'登记作者',douyinId:'author_a',publishDate:'',type:'video',track:'',tracks:'',plays:7,likes:0,title:'登记作品',url:'https://www.douyin.com/video/7300000000000000001'};
const meta={path:'creator/works-001.json',kind:'creatorWorks',count:1};
const part=row=>({version:1,asOf:at,timeZone:'Asia/Shanghai',revision:'fixture',items:[row]});

test('creator work contract accepts old records and a strict optional content category set',()=>{
 assert.equal(creatorPartValid(part(work),meta,at),true);
 assert.equal(creatorPartValid(part({...work,classifications:['slice']}),meta,at),true);
 for(const classifications of [null,'slice',['unknown'],['slice','slice'],['slice','original','ai-remix','contest','slice']])
  assert.equal(creatorPartValid(part({...work,classifications}),meta,at),false);
 assert.equal(creatorPartValid(part({...work,classifications:['slice'],cookie:'never-public'}),meta,at),false);
 assert.notEqual(creatorEditionIdentityPayload({revision:'1'},[],[work]),creatorEditionIdentityPayload({revision:'1'},[],[{...work,classifications:['slice']}]));
});

test('explicit slice classification survives filtering, URL return and full CSV without inventing an incentive track or date',()=>{
 const slice={...work,classifications:['slice']},original={...work,row:3,contentId:'7300000000000000002',classifications:['original']};
 const path=sourceLedgerSelectionPath('/?theme=tuantuan#works',{...sourceLedgerDefaults,view:'works',track:'content:slice'});
 const selected=sourceLedgerSelection(new URL(path,'https://fixture.test').search);
 const rows=filterSourceLedgerRows([slice,original],selected);
 assert.equal(rows.length,1);assert.equal(rows[0].contentId,slice.contentId);assert.equal(rows[0].publishDate,'');assert.equal(rows[0].likes,0);
 assert.equal(belongsToSourceTrack(slice,'切片激励','works'),false);
 assert.equal(belongsToSourceTrack(slice,'__unclassified__','works'),true,'no named track remains no named track');
 assert.equal(sourceWorkClassificationLabel(slice),'切片');
 const csv=sourceLedgerCsv(rows);assert.match(csv,/内容分类/);assert.match(csv,/"切片","日期依据待核验",""/);
 assert.deepEqual(slice.classifications,['slice']);assert.equal(slice.track,'');
});

test('legacy track evidence still implies content while content never implies incentive participation',()=>{
 const legacy={...work,track:'切片激励',tracks:'切片激励 / 创作激励'};
 assert.deepEqual(sourceContentClassifications(legacy),['slice','original']);
 assert.equal(belongsToSourceTrack(legacy,'content:slice','works'),true);
 assert.equal(belongsToSourceTrack(legacy,'创作激励','works'),true);
 assert.equal(sourceWorkClassificationsValid(['slice','contest']),true);
 assert.equal(belongsToSourceTrack({registeredClassifications:['slice']},'content:slice','authors'),true);
 assert.equal(belongsToSourceTrack({name:'切片作者'},'content:slice','authors'),false,'a nickname is not category evidence');
});

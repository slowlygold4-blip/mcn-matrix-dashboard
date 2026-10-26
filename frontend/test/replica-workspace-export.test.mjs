import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceSelection,workspaceSelectionPath,workspaceSelectionScope,workspaceNavigation,workspacePath} from '../lib/replica-navigation.mjs';
import {accountExport} from '../lib/replica-export.mjs';
import {rowsFor,csv} from '../lib/replica-model.mjs';
const asOf='2026-10-01T05:08:10.925Z';
const account={id:234,platform:'douyin',label:'=同名',enabled:true,boardKeys:['matrix'],classification:{theme:{key:'tuantuan',label:'团团'},labels:[{key:'slice',label:'切片'}]}};
test('workspace period/explicit filter query roundtrips without becoming a personal identity',()=>{
 const q='?board=matrix&theme=tuantuan&classification=slice&period=month&start=2026-09-30&end=2026-10-01';
 const s=workspaceSelection(q);assert.equal(workspaceNavigation(q,'#accounts').personal,null);
 assert.equal(workspacePath('/','topics',q),workspaceSelectionPath('/','topics',s));
 assert.deepEqual(workspaceSelection(workspaceSelectionPath('/','overview',s).split('#')[0].slice(1)),s);
 assert.deepEqual(workspaceSelectionScope(s,[account],[{key:'matrix'}]),[account]);
});
test('malformed, duplicate, ambiguous and unregistered scopes cannot silently become all accounts',()=>{
 for(const q of ['?period=evil','?period=month&period=week','?start=2026-09-31&end=2026-10-01','?start=2026-09-30','?start=2026-10-01&end=2026-09-30','?theme=','?period=custom'])assert.throws(()=>workspaceSelection(q));
 assert.throws(()=>workspaceSelectionScope(workspaceSelection('?theme=unknown'),[account],[]));
 assert.throws(()=>workspaceNavigation('?generation='+asOf,'#overview'));
});
test('export anchors true zero, negative changes and missing values to canonical author and exact partition',()=>{
 const start='2026-09-30',end='2026-10-01',points=[{targetId:234,date:start,capturedAt:start+'T02:00:00.000Z',followers:1,likes:3,posts:2},{targetId:234,date:end,capturedAt:end+'T02:00:00.000Z',followers:0,likes:null,posts:2}];
 const row=rowsFor([account],points,start,end),manifest={asOf,files:[{path:'daily/234.json',kind:'daily',targetId:234,sha256:'a'.repeat(64)}]};
 const out=accountExport(row,manifest,start,end),m=Object.fromEntries(out[0].map((k,i)=>[k,out[1][i]]));
 assert.equal(m.targetId,234);assert.equal(m.platform,'douyin');assert.equal(m.asOf,asOf);
 assert.equal(m['粉丝'],0);assert.equal(m['粉丝净变'],-1);assert.equal(m['点赞'],null);assert.equal(m.likesCurrentAt,null);assert.equal(m['作品存量净变'],0);
 assert.equal(m.followersBaselineAt,start+'T02:00:00.000Z');assert.equal(m.followersCurrentAt,end+'T02:00:00.000Z');assert.equal(m.dailyPartSha256,'a'.repeat(64));
 assert.ok(csv(out).includes("'=同名"));assert.ok(csv(out).includes('"-1"'));assert.ok(m['来源说明'].includes('分区指纹'));
 const empty=accountExport(row,{asOf,files:[]},start,end);assert.equal(empty[1].at(-3),null);assert.equal(empty[1].at(-2),null);
});

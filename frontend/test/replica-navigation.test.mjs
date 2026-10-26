import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceNavigation,workspacePath,navigationNeedsLoad} from '../lib/replica-navigation.mjs';

test('all workspace hashes own their initial or restored tab',()=>{
 for(const tab of ['overview','accounts','topics'])assert.deepEqual(workspaceNavigation('','#'+tab),{tab,personal:null,loadView:tab==='topics'?'topics':'global'});
 assert.equal(workspaceNavigation('','').tab,'overview');
 assert.equal(workspaceNavigation('','#unknown').tab,'overview');
});
test('canonical workspace paths remove account query rather than keep mixed views',()=>{
 for(const tab of ['overview','accounts','topics'])assert.equal(workspacePath('/',tab),'/#'+tab);
 for(const path of ['//evil.test/','/x?account=1','/x#topics','/x\n','https://example.test/'])assert.throws(()=>workspacePath(path,'topics'));
 assert.throws(()=>workspacePath('/','account'));
});
test('account identity date and generation validation remains authoritative',()=>{
 const query='?account=234&start=2026-09-12&end=2026-10-01&generation=2026-10-01T03%3A56%3A19.682Z';
 const route=workspaceNavigation(query,'#topics');
 assert.equal(route.tab,'accounts');assert.equal(route.loadView,'account');
 assert.equal(route.personal.id,234);assert.equal(route.personal.start,'2026-09-12');
 assert.equal(route.personal.generation,'2026-10-01T03:56:19.682Z');
 for(const search of ['?account=234&account=235','?account=234&start=2026-09-12','?account=234&generation=bad','?generation=2026-10-01T03%3A56%3A19.682Z'])assert.throws(()=>workspaceNavigation(search,'#topics'));
});
test('topics and same-version personal navigation never require global summary',()=>{
 const data={manifest:{asOf:'2026-10-01T03:56:19.682Z'},summaryLoaded:false};
 assert.equal(navigationNeedsLoad(workspaceNavigation('','#topics'),data),false);
 assert.equal(navigationNeedsLoad(workspaceNavigation('?account=234&generation=2026-10-01T03%3A56%3A19.682Z',''),data),false);
 for(const tab of ['overview','accounts'])assert.equal(navigationNeedsLoad(workspaceNavigation('','#'+tab),data),true);
});
test('global verified summary is reusable but a different or unpinned account version is not',()=>{
 const data={manifest:{asOf:'2026-10-01T03:56:19.682Z'},summaryLoaded:true};
 for(const tab of ['overview','accounts','topics'])assert.equal(navigationNeedsLoad(workspaceNavigation('','#'+tab),data),false);
 assert.equal(navigationNeedsLoad(workspaceNavigation('?account=234',''),data),true);
 assert.equal(navigationNeedsLoad(workspaceNavigation('?account=234&generation=2026-10-01T02%3A43%3A24.280Z',''),data),true);
 assert.equal(navigationNeedsLoad(workspaceNavigation('','#topics'),null),true);
});

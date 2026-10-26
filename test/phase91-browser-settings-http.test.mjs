import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

test('phase91 actual guarded HTTP settings roundtrip: explicit mode, strict values, admin-only four-field projection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase91-settings-http-'));const oldData=process.env.DATA_DIR;process.env.DATA_DIR=dir;
  let server,db;
  try{
    ({server}=await import('../server.mjs'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    const auth=await fetch(origin+'/api/auth/session');const owner=await auth.json();
    const cookie=auth.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    const headers={Cookie:cookie,Origin:origin,'X-CSRF-Token':owner.csrfToken,'Content-Type':'application/json'};
    const read=async()=>{const response=await fetch(origin+'/api/settings',{headers:{Cookie:cookie}});assert.equal(response.status,200);return response.json();};
    const post=body=>fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify(body)});
    const initial=await read();assert.deepEqual(Object.keys(initial).sort(),['publicPostsPerAccount','publicWorksPageHardLimit','publicWorksPageMode','publicWorksRequestThreshold'].sort());
    assert.equal(initial.publicPostsPerAccount,'30');assert.equal(initial.publicWorksPageMode,'legacy');
    db=new DatabaseSync(join(dir,'douyin-monitor.sqlite'),{readOnly:true});
    const originalRow=db.prepare('SELECT * FROM settings WHERE key=?').get('publicPostsPerAccount');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM settings WHERE key LIKE ?').get('publicWorks%').n,0,'GET must not migrate defaults');
    assert.equal((await post({publicWorksPageMode:'whole-page-v2'})).status,400);assert.deepEqual(await read(),initial);
    assert.equal((await post({publicWorksPageMode:'whole-page-v2',publicWorksPageHardLimit:100,publicWorksRequestThreshold:30})).status,200);
    assert.equal((await read()).publicWorksPageMode,'whole-page-v2');
    for(const body of [{publicWorksPageMode:'other'},{publicWorksPageHardLimit:'30.0'},{publicWorksPageHardLimit:null},{publicWorksRequestThreshold:101},{publicWorksPageHardLimit:20}])assert.equal((await post(body)).status,400);
    const after=await read();assert.equal(after.publicWorksPageHardLimit,'100');assert.equal(after.publicWorksRequestThreshold,'30');
    assert.deepEqual(db.prepare('SELECT * FROM settings WHERE key=?').get('publicPostsPerAccount'),originalRow,'new mode cannot overwrite old hard30/timestamp');
    assert.equal((await fetch(origin+'/api/settings',{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},body:JSON.stringify({publicWorksPageMode:'legacy'})})).status,403);
    const invited=await fetch(origin+'/api/access/invites',{method:'POST',headers,body:JSON.stringify({role:'viewer'})});assert.equal(invited.status,201);const invite=await invited.json();
    const joined=await fetch(origin+'/api/auth/join',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:invite.code,displayName:'phase91 local viewer'})});
    assert.equal(joined.status,200);const viewer=await joined.json();const viewerCookie=joined.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    assert.equal((await fetch(origin+'/api/settings',{headers:{Cookie:viewerCookie}})).status,403);
    assert.equal((await fetch(origin+'/api/settings',{method:'POST',headers:{...headers,Cookie:viewerCookie,'X-CSRF-Token':viewer.csrfToken},body:JSON.stringify({publicWorksPageMode:'legacy'})})).status,403);
    assert.equal((await post({publicWorksPageMode:'legacy'})).status,200);assert.equal((await read()).publicPostsPerAccount,'30');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n,0,'settings read/write never creates collection');
  }finally{
    if(server?.listening)await new Promise(resolve=>server.close(resolve));db?.close();
    if(oldData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=oldData;
    await rm(dir,{recursive:true,force:true});
  }
});

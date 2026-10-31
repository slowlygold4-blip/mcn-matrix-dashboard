import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';

const collector = fileURLToPath(new URL('../scripts/douyin_public_collector.py', import.meta.url));
const secUid = 'MS4wLjABAAAAWorksHttpContractFixture123456';
const endpoint = 'https://www.douyin.com/aweme/v1/web/aweme/post/';
const post = { aweme_id: '7770000000000000001', create_time: 1789250000,
  author: { sec_uid: secUid }, statistics: { digg_count: 7 } };
const terminal = { status_code: 0, aweme_list: [], has_more: 0, max_cursor: 0 };

function collect(rows) {
  const program = String.raw`
import importlib.util,json,sys,types,subprocess
s=importlib.util.spec_from_file_location('c',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
out=[]
for row in json.loads(sys.argv[2]):
 calls=[]
 c.register_guest=lambda:'PRIVATE_HTTP_FIXTURE'
 c.fetch_public_profile=lambda *_:({'status_code':0,'user':{'sec_uid':sys.argv[3],'uid':'12345','follower_count':19,'total_favorited':100,'aweme_count':row.get('inventory',0)}},'fixture-profile')
 c.a_bogus_signed_url=lambda base,params:base
 c.time.sleep=lambda _:None
 def request(args,**kwargs):
  calls.append({'noLocation':'--no-location' in args and args.index('--no-location')>args.index('-L')})
  if len(calls)>1:raise AssertionError('No retry or continuation after rejected first page')
  body=json.dumps(row.get('body')).encode()
  output=body+b'\n__CODEX_HTTP_META__'+str(row.get('http',200)).encode()+b'\t'+row.get('finalUrl',c.POSTS_URL).encode()
  return types.SimpleNamespace(stdout=output,stderr=b'HTTP/2 403\r\nSet-Cookie: PRIVATE_HTTP_FIXTURE\r\n\r\n',returncode=row.get('returncode',0))
 c.subprocess.run=request
 raw=c.collect_account(sys.argv[3],30)
 out.append({'raw':raw,'requests':len(calls),'transport':calls})
print(json.dumps(out))
`;
  const p = spawnSync('/usr/bin/python3', ['-B', '-c', program, collector, JSON.stringify(rows), secUid],
    { encoding: 'utf8', timeout: 15_000 });
  assert.equal(p.status, 0, p.stderr);
  assert.doesNotMatch(p.stdout, /PRIVATE_HTTP_FIXTURE|Set-Cookie/);
  return JSON.parse(p.stdout);
}

test('explicit works login and verification flags cannot become complete empty inventory', () => {
  for (const field of ['need_login', 'login_required', 'captcha_required', 'verify_required']) {
    for (const value of [true, 1, 'required', [], {}]) {
      const [{raw, requests}] = collect([{body:{...terminal,[field]:value}}]);
      assert.equal(requests,1);
      assert.equal(raw.worksCoverage,'unavailable', `${field}: ${JSON.stringify(value)}`);
      assert.equal(raw.worksErrorCode,['need_login','login_required'].includes(field)?'login_required':'business_error');
      assert.deepEqual(raw.works.aweme_list,[]);
      assert.equal(raw.works.pagination.pages[0].response,null);
      assert.equal(raw.profile.user.follower_count,19);
      assert.equal(raw.profile.user.total_favorited,100);
    }
  }
});

test('works redirect to another endpoint cannot provide valid-looking works or empty inventory', () => {
  const urls=['https://example.invalid/aweme/v1/web/aweme/post/',
    'https://www.douyin.com/passport/login/','https://www.douyin.com/aweme/v1/web/aweme/detail/',
    'http://www.douyin.com/aweme/v1/web/aweme/post/','https://www.douyin.com:443/aweme/v1/web/aweme/post/'];
  for (const finalUrl of urls) {
    const [{raw,requests}]=collect([{body:{...terminal,aweme_list:[post]},inventory:1,finalUrl}]);
    assert.equal(requests,1);assert.equal(raw.worksCoverage,'unavailable');
    assert.equal(raw.worksErrorCode,'upstream_changed');assert.deepEqual(raw.works.aweme_list,[]);
  }
});

test('partial HTTP works refusal retains its refusal code instead of transient network error', () => {
  for (const [http,code] of [[401,'login_required'],[403,'blocked'],[429,'rate_limited']]) {
    const [{raw,requests}]=collect([{body:terminal,http,returncode:28}]);
    assert.equal(requests,1);assert.equal(raw.worksErrorCode,code);
    assert.equal(raw.worksCoverage,'unavailable');
  }
});

test('instrumented counter requests stop at HTTP redirects before following a destination', () => {
  for (const http of [301,302,303,307,308]) {
    const [{raw,requests,transport}]=collect([{body:terminal,http}]);
    assert.equal(requests,1);assert.equal(transport[0].noLocation,true);
    assert.equal(raw.worksErrorCode,'upstream_changed');assert.equal(raw.worksCoverage,'unavailable');
  }
});

test('explicit nonblocking flags, genuine zero inventory and genuine nonempty works remain accepted', () => {
  for(const v of [null,false,0,'']) {
    const [{raw}]=collect([{body:{...terminal,need_login:v,captcha_required:v}}]);
    assert.equal(raw.worksCoverage,'complete');assert.equal(raw.worksErrorCode,null);
  }
  const [{raw}]=collect([{body:{...terminal,aweme_list:[post]},inventory:1}]);
  assert.equal(raw.worksCoverage,'complete');assert.equal(raw.works.aweme_list[0].statistics.digg_count,7);
  // This marker describes a public limited window, not an explicit login demand.
  const [{raw:limited}]=collect([{body:{...terminal,aweme_list:[post],not_login_module:true},inventory:1}]);
  assert.equal(limited.worksCoverage,'latest-public-window');assert.equal(limited.works.aweme_list.length,1);
});

test('rejected works cannot add fabricated zero-like history or erase existing works; profile still commits', t=>{
  const [good,bad]=collect([{body:{...terminal,aweme_list:[post]},inventory:1},
    {body:{...terminal,need_login:true},inventory:0}]);
  const d=new MonitorDatabase(':memory:');t.after(()=>d.close());
  const target=d.createTarget({type:'account',provider:'public-web',locator:secUid,label:'HTTP works integrity',metadata:{platform:'douyin'}});
  good.raw.capturedAt='2026-10-30T12:00:00.000Z';bad.raw.capturedAt='2026-10-31T12:00:00.000Z';
  d.saveCollection(target,null,normalizeCollection(target,good.raw,{capturedAt:good.raw.capturedAt}));
  const before=d.db.prepare('SELECT * FROM post_metrics').all();
  d.saveCollection(target,null,normalizeCollection(target,bad.raw,{capturedAt:bad.raw.capturedAt}));
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM posts').get().n,1);
  assert.deepEqual(d.db.prepare('SELECT * FROM post_metrics').all(),before);
  const latest=d.db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1').get();
  assert.equal(latest.followers,19);assert.equal(latest.total_likes,100);
  assert.equal(latest.works_coverage,'unavailable');
});

test('collector imports without the retired X-Bogus module or obsolete signed profile function',()=>{
  const program=String.raw`
import builtins,importlib.util,sys
original=builtins.__import__
def guarded(name,*args,**kwargs):
 if name=='xbogus':raise AssertionError('Retired dependency was loaded')
 return original(name,*args,**kwargs)
builtins.__import__=guarded
s=importlib.util.spec_from_file_location('c',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
assert not hasattr(c,'signed_url')
assert not any(p.endswith('/vendor/evil0ctal') for p in sys.path)
print('ok')
`;
  const p=spawnSync('/usr/bin/python3',['-B','-c',program,collector],{encoding:'utf8',timeout:5000});
  assert.equal(p.status,0,p.stderr);assert.equal(p.stdout.trim(),'ok');
});

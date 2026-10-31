import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const collector = fileURLToPath(new URL('../scripts/douyin_public_collector.py', import.meta.url));
const secUid = 'MS4wLjABAAAAProfileHttpContractFixture12345';
const success = { status_code: 0, user: { sec_uid: secUid, uid: '123456789',
  follower_count: 0, total_favorited: 17, aweme_count: 0 } };
function probe(row, { collect = false } = {}) {
  const script = String.raw`
import importlib.util,json,sys,types,subprocess
spec=importlib.util.spec_from_file_location('c',sys.argv[1]);c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
fixture=json.loads(sys.argv[2]);calls=[];signs=[]
def signer(*args):
 signs.append(True)
 return args[0]+'?signature=PRIVATE_TEST_SECRET'
c.signed_url=signer;c.a_bogus_signed_url=signer
def fake_run(args,**kwargs):
 calls.append({'signed':'signature=' in args[-1],'headersCaptured':'-D' in args})
 row=fixture['row']
 if row.get('timeout'):raise subprocess.TimeoutExpired('PRIVATE_TEST_SECRET',1)
 body=row.get('text',json.dumps(row.get('body'))).encode()
 output=body+b'\n__CODEX_HTTP_META__'+str(row.get('status',200)).encode()+b'\t'+row.get('finalUrl','https://www.douyin.com/aweme/v1/web/user/profile/other/').encode()
 return types.SimpleNamespace(returncode=row.get('returncode',0),stdout=output,stderr=b'HTTP/2 403\r\nSet-Cookie: PRIVATE_TEST_SECRET\r\n\r\n')
c.subprocess.run=fake_run;c.register_guest=lambda:'PRIVATE_TEST_SECRET'
try:
 if fixture['collect']:
  raw=c.collect_account(fixture['secUid'],30,works_mode='deferred');result={'ok':True,'value':raw}
 else:
  payload,mode=c.fetch_public_profile(fixture['secUid'],'PRIVATE_TEST_SECRET');result={'ok':True,'value':payload,'mode':mode}
except c.CollectorError as error:result={'ok':False,'code':error.code,'error':str(error)}
result['calls']=calls;result['signs']=len(signs);print(json.dumps(result))
`;
  const child = spawnSync('/usr/bin/python3', ['-B', '-c', script, collector, JSON.stringify({ row, collect, secUid })], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_SECRET|signature=|Set-Cookie/);
  return result;
}

test('successful profile preserves exact counters and current provenance with one unsigned request', () => {
  const result = probe({ body: success });
  assert.equal(result.ok, true); assert.deepEqual(result.value, success);
  assert.equal(result.mode, 'guest-ttwid-unsigned-profile');
  assert.equal(result.calls.length, 1); assert.equal(result.signs, 0);
  assert.equal(result.calls[0].signed, false);
  assert.equal(result.calls[0].headersCaptured, true);
});

test('HTTP refusal, partial refusal and transport failure never change to a signed profile request', () => {
  for (const [row, code] of [
    [{ status: 401, text: 'PRIVATE_TEST_SECRET' }, 'login_required'],
    [{ status: 403, text: 'PRIVATE_TEST_SECRET' }, 'blocked'],
    [{ status: 429, text: 'PRIVATE_TEST_SECRET' }, 'rate_limited'],
    [{ status: 403, returncode: 28, text: 'PRIVATE_TEST_SECRET' }, 'blocked'],
    [{ status: 503, text: 'PRIVATE_TEST_SECRET' }, 'network_error'],
    [{ timeout: true }, 'network_error'],
  ]) {
    const result = probe(row);
    assert.equal(result.ok, false); assert.equal(result.code, code);
    assert.equal(result.calls.length, 1); assert.equal(result.signs, 0);
  }
});

test('profile requires explicit integer business success and rejects HTML or empty bodies', () => {
  for (const body of [
    { user: success.user }, { ...success, status_code: null }, { ...success, status_code: false },
    { ...success, status_code: '0' }, { ...success, status_code: 8, status_msg: 'PRIVATE_TEST_SECRET' },
  ]) {
    const result = probe({ body });
    assert.equal(result.ok, false); assert.equal(result.calls.length, 1); assert.equal(result.signs, 0);
  }
  for (const text of ['', '<script>document.cookie="PRIVATE_TEST_SECRET"</script>']) {
    const result = probe({ text });
    assert.equal(result.ok, false); assert.equal(result.calls.length, 1); assert.equal(result.signs, 0);
  }
});

test('login or verification flags cannot be stripped into an apparently successful profile', () => {
  for (const field of ['need_login', 'login_required', 'captcha_required', 'verify_required']) {
    const result = probe({ body: { ...success, [field]: true } }, { collect: true });
    assert.equal(result.ok, false); assert.equal(result.calls.length, 1); assert.equal(result.signs, 0);
  }
  const result = probe({ body: { ...success, status_code: 2483, status_msg: 'PRIVATE_TEST_SECRET' } });
  assert.equal(result.code, 'login_required'); assert.equal(result.signs, 0);
});

test('a different final endpoint cannot supply apparently valid profile counters', () => {
  for (const finalUrl of ['https://example.invalid/aweme/v1/web/user/profile/other/',
    'https://www.douyin.com/passport/login/', 'http://www.douyin.com/aweme/v1/web/user/profile/other/']) {
    const result = probe({ body: success, finalUrl });
    assert.equal(result.ok, false); assert.equal(result.code, 'upstream_changed');
    assert.equal(result.calls.length, 1); assert.equal(result.signs, 0);
  }
});

test('live account metrics require a matching canonical profile identity before any works request', () => {
  for (const value of [undefined, '', 'MS4wLjABAAAAOtherProfileFixture1234567']) {
    const user = { ...success.user, sec_uid: value };
    const result = probe({ body: { ...success, user } }, { collect: true });
    assert.equal(result.ok, false); assert.equal(result.calls.length, 1); assert.equal(result.signs, 0);
  }
  const result = probe({ body: success }, { collect: true });
  assert.equal(result.ok, true); assert.equal(result.value.profile.user.follower_count, 0);
  assert.equal(result.value.worksCoverage, 'unavailable');
  assert.equal(result.value.works.pagination.requestCount, 0);
});

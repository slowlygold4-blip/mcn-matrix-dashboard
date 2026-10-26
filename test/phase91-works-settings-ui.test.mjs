import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {worksSettingInteger,readWorksSettings,buildWorksSettingsSubmission} from '../public/works-settings.js';
const values={publicWorksPageMode:'legacy',publicPostsPerAccount:'30',publicWorksPageHardLimit:'100',publicWorksRequestThreshold:'30'};
test('phase91 UI canonical receipt preserves old30 and discards unrelated configuration',()=>{
  const input={...values,privateSentinel:'do-not-render'};const before=structuredClone(input);
  assert.deepEqual(readWorksSettings(input),{publicWorksPageMode:'legacy',publicPostsPerAccount:30,publicWorksPageHardLimit:100,publicWorksRequestThreshold:30});
  assert.deepEqual(input,before);assert.equal(Object.hasOwn(readWorksSettings(input),'privateSentinel'),false);
});
test('phase91 whole-page UI submits explicit tuple without reinterpreting or writing old30',()=>{
  assert.deepEqual(buildWorksSettingsSubmission({mode:'whole-page-v2',hard:'100',threshold:'30',legacy:'30'}),
    {publicWorksPageMode:'whole-page-v2',publicWorksPageHardLimit:100,publicWorksRequestThreshold:30});
  assert.deepEqual(buildWorksSettingsSubmission({mode:'legacy',legacy:'30',hard:'invalid',threshold:'invalid'}),{publicWorksPageMode:'legacy',publicPostsPerAccount:30});
});
test('phase91 UI rejects coercion, noninteger and cross-field invalid values rather than clamp',()=>{
  for(const value of [null,undefined,true,false,'',' 30','030','3e1','30.0','0x1e',[],{},0,-1,101,1.2,Infinity,NaN])assert.throws(()=>worksSettingInteger(value,'数量'));
  for(const value of [1,100,'1','100'])assert.equal(worksSettingInteger(value,'数量'),Number(value));
  assert.throws(()=>buildWorksSettingsSubmission({mode:'whole-page-v2',hard:'20',threshold:'30'}));
  assert.throws(()=>readWorksSettings({...values,publicWorksPageMode:'unverified'}));
});
test('phase91 settings component stays independent from metric math and loads before normal shell',async()=>{
  const html=await readFile(new URL('../public/rebuild.html',import.meta.url),'utf8');
  const shell=await readFile(new URL('../public/rebuild.js',import.meta.url),'utf8');
  assert.ok(html.indexOf('src="/works-settings.js')<html.indexOf('src="/rebuild.js'));
  assert.match(html,/id="worksSettingsButton"[^>]+hidden/);
  assert.match(html,/id="worksSettingsDialog"[^>]+aria-labelledby="worksSettingsTitle"/);
  assert.match(shell,/mcn:works-settings-bind/);assert.match(shell,/mcn:works-settings-session/);
  assert.equal((shell.match(/^import /gm)||[]).length,1);
});
test('phase91 UI boundary keeps partial coverage, old settings and request budget explicit',async()=>{
  const html=await readFile(new URL('../public/rebuild.html',import.meta.url),'utf8');
  const source=await readFile(new URL('../public/works-settings.js',import.meta.url),'utf8');
  assert.match(html,/整页保存不是“采到全部作品”/);assert.match(html,/45 秒、最多 3 页/);
  assert.match(source,/!canManage\(\) \|\| !current \|\| loading \|\| saving/);
  assert.match(source,/method: 'POST'/);assert.doesNotMatch(source,/\/api\/collect|\/api\/runs|\.innerHTML/);
});

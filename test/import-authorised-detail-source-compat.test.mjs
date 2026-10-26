import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImportAuthorisedDetail } from '../lib/import-authorised-detail.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';

const VIDEO = '7687242309561306414';
const OTHER = '7687780584391868401';
const SHARE = 'https://v.douyin.com/rjNMWerRDTQ/';
const TAIL = '%20h@o.Du%2012/22%20:5pm%20Bgb:/';
const sourceRow = 268;
const shortRow = () => ({sourceRow, platform:'douyin',douyinId:'97645975976',videoId:'',shareUrl:SHARE,
  videoLink:SHARE+TAIL,videoHyperlink:'',contentId:'',locator:'',status:'resolvable'});
const modalRow = () => ({...shortRow(),douyinId:'26853061752',videoId:VIDEO,shareUrl:'',
  videoLink:`https://www.douyin.com/user/self?from_tab_name=main&modal_id=${VIDEO}`});
const job = row => ({status:'completed',request:{rows:[row]}});
const prepare = row => prepareImportAuthorisedDetail(job(row),{sourceRow});
const reject = row => assert.throws(()=>prepare(row),{code:'IMPORT_DETAIL_INVALID_INPUT'});

test('saved short URL and encoded copy-share suffix prepare the same original key without source mutation',()=>{
  const row=shortRow();Object.freeze(row);const original=JSON.stringify(row);
  assert.deepEqual(prepare(row),{key:buildAuthorEvidenceRequests([row])[0].key,shareUrl:SHARE,submittedId:'97645975976'});
  assert.equal(JSON.stringify(row),original);
  const permutations=[
    '%20:5pm%2011/24%20pDu:/%20G@i.PK',
    '%20CHV:/%2007/23%20:9pm%20t@E.hB',
    '%2006/24%20Z@m.Dh%20QKj:/%20:7pm',
  ];
  for(const tail of permutations) assert.equal(prepare({...row,videoLink:SHARE+tail}).shareUrl,SHARE);
  assert.equal(prepare({...row,videoHyperlink:SHARE+TAIL}).shareUrl,SHARE);
});

test('keeps existing plain caption wrapper support and rejects extra or mismatched URL evidence',()=>{
  assert.equal(prepare({...shortRow(),videoLink:`分享作品 ${SHARE} 打开观看`}).shareUrl,SHARE);
  for(const videoLink of [
    `分享作品 ${SHARE} https://v.douyin.com/OtherToken/`,
    `https://v.douyin.com/OtherToken/${TAIL}`,
    SHARE+TAIL+'%20https://evil.test/', SHARE+TAIL+'%20https://v.douyin.com/OtherToken/',
    SHARE+TAIL+'%20https%3A%2F%2Fevil.test%2F', SHARE+TAIL+'?next=https%3A%2F%2Fevil.test',
    SHARE+TAIL+'#fragment', SHARE+'other/path',SHARE+'%2520h@o.Du%2012/22%20:5pm%20Bgb:/',
    SHARE+'%20//evil.test%2012/22%20:5pm%20Bgb:/',
    SHARE+'%20https:/%2012/22%20:5pm%20Bgb:/',
    SHARE.replace('v.douyin.com','v.douyin.com:443')+TAIL,
    SHARE.replace('v.douyin.com','user@v.douyin.com')+TAIL,
    SHARE.replace('v.douyin.com','v.douyin.com.evil.test')+TAIL,
  ]) reject({...shortRow(),videoLink});
});

test('does not guess arbitrary encoded prose, path fragments, malformed or missing copy-share tokens',()=>{
  for(const tail of [
    '%20some%20words','%20:5pm%2012/22%20:5pm%20Bgb:/','%20h@o.Du%2013/22%20:5pm%20Bgb:/',
    '%20h@o.Du%2012/32%20:5pm%20Bgb:/','%20h@o.Du%2012/22%20:5pm',
    '%09h@o.Du%2012/22%20:5pm%20Bgb:/','%20h@o.Du%2012/22%20:5pm%20Bgb:/%20',
    '%20h@o.Du%2012/22%20:5pm%20Bgb:/\n','%20h@o.Du%2012/22%20:5pm%20Bgb:/%00',
  ]) reject({...shortRow(),videoLink:SHARE+tail});
  reject({...shortRow(),shareUrl:''});
  reject({...shortRow(),shareUrl:'https://v.douyin.com/OtherToken/'});
  reject({...shortRow(),videoLink:SHARE+TAIL,videoHyperlink:'https://v.douyin.com/OtherToken/'});
});

test('official self modal identifies only the same already saved work; it never supplies author identity',()=>{
  const row=modalRow();Object.freeze(row);const original=JSON.stringify(row);
  assert.deepEqual(prepare(row),{key:buildAuthorEvidenceRequests([row])[0].key,videoId:VIDEO,submittedId:'26853061752'});
  assert.equal(JSON.stringify(row),original);
  assert.equal(prepare({...row,videoLink:`https://douyin.com/user/self/?modal_id=${VIDEO}&item_id=${VIDEO}`}).videoId,VIDEO);
  assert.equal(prepare({...row,videoLink:`https://www.douyin.com/user/self?modal_id=${VIDEO}&uid=123`}).expectedUid,undefined);
  assert.equal(prepare({...row,videoLink:`https://www.douyin.com/user/self?modal_id=${VIDEO}&sec_uid=MS4wLjABOTHERabcdefghijklmnop`}).expectedSecUid,undefined);
});

test('modal URL rejects absent, duplicate, conflicting or unsafe ID, wrong origin, profile context and fragment',()=>{
  for(const videoLink of [
    'https://www.douyin.com/user/self', `https://www.douyin.com/user/self?modal_id=${OTHER}`,
    `https://www.douyin.com/user/self?modal_id=${VIDEO}&modal_id=${VIDEO}`,
    `https://www.douyin.com/user/self?modal_id=${VIDEO}&modal_id=${OTHER}`,
    `https://www.douyin.com/user/self?modal_id=${VIDEO}&item_id=${OTHER}`,
    `https://www.douyin.com/user/self?modal_id=${VIDEO}&aweme_id=${VIDEO}&aweme_id=${VIDEO}`,
    'https://www.douyin.com/user/self?modal_id=7.687242309561306e18',
    `https://www.douyin.com/user/self?modal_id=${VIDEO}#modal_id=${OTHER}`,
    `https://www.iesdouyin.com/user/self?modal_id=${VIDEO}`,
    `https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrstuvwx?modal_id=${VIDEO}`,
    `https://www.douyin.com:443/user/self?modal_id=${VIDEO}`,
    `https://user@www.douyin.com/user/self?modal_id=${VIDEO}`,
    `https://%77ww.douyin.com/user/self?modal_id=${VIDEO}`,
    `https://www.douyin.com.evil.test/user/self?modal_id=${VIDEO}`,
    `http://www.douyin.com/user/self?modal_id=${VIDEO}`,
    `https://www.douyin.com/user/self?modal_id=${VIDEO} https://www.douyin.com/video/${OTHER}`,
    `https://www.douyin.com/user/self?modal_id=${VIDEO} https://www.douyin.com/user/self?modal_id=${VIDEO}`,
  ]) reject({...modalRow(),videoLink});
  reject({...modalRow(),videoId:''});
  reject({...modalRow(),videoId:Number(VIDEO)});
  reject({...modalRow(),douyinId:'昵称不是账号ID'});
  reject({...modalRow(),identityConflict:'existing conflict'});
});

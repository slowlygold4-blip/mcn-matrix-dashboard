import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareImportAuthorisedDetail} from '../lib/import-authorised-detail.mjs';
const make = changes=>({status:'completed',request:{rows:[{sourceRow:2,platform:'douyin',name:'作者',douyinId:'12345',videoId:'',shareUrl:'https://v.douyin.com/aBc_def-1/',...changes}]}});
test('exact original official short link is prepared without inventing videoId',()=>{
  const job=make(),before=JSON.stringify(job),item=prepareImportAuthorisedDetail(job,{sourceRow:2});
  assert.equal(item.shareUrl,'https://v.douyin.com/aBc_def-1/');assert.equal(item.submittedId,'12345');assert.equal(item.videoId,undefined);
  assert.equal(JSON.stringify(job),before);
  assert.equal(prepareImportAuthorisedDetail(make({videoLink:'分享作品 https://v.douyin.com/aBc_def-1/ 打开观看'}),{sourceRow:2}).shareUrl,item.shareUrl);
  assert.throws(()=>prepareImportAuthorisedDetail(make({videoLink:'分享 https://v.douyin.com/aBc_def-1/ 另一个 https://v.douyin.com/other/'}),{sourceRow:2}));
});
test('short-link preparation refuses multi evidence, tracking input, host deception and unsafe video IDs',()=>{
  for(const change of [{contentId:'123'},{videoLink:'https://v.douyin.com/other/'},{shareUrl:'https://v.douyin.com/a/?cookie=secret'},
    {shareUrl:'https://v.douyin.com.evil.test/a/'},{shareUrl:'https://v.douyin.com:443/a/'},{shareUrl:'https://v.douyin.com/a/#x'},
    {videoId:7686424948055891786},{shareUrls:['https://v.douyin.com/a/']},{shareUrl:'分享 https://v.douyin.com/a/'}]) {
    assert.throws(()=>prepareImportAuthorisedDetail(make(change),{sourceRow:2}),undefined,JSON.stringify(change));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mapBitableAuthorRows } from '../lib/source-bitable-mapping.mjs';
const map = link => mapBitableAuthorRows({fields:['作者','抖音号','作品链接'],rows:[
  {recordId:'recFirstAuthor',values:['作者甲','author-a',link]},
  {recordId:'recSecondAuthor',values:['作者乙','author-b','https://v.douyin.com/next/']},
]});
test('exact Markdown URL echo does not block all source rows; entire URL retained', async()=>{
  const url='https://www.douyin.com/video/7688384079717777242/?tracking='+'x'.repeat(850);
  const rows=await map(`[${url}](${url})`);
  assert.equal(rows.length,2); assert.equal(rows[0].videoLink,url);
  assert.equal(rows[0].videoId,'7688384079717777242');
  assert.equal(rows[1].sourceRow,2); assert.equal(rows[1].sourceRecordId,'recSecondAuthor');
});
test('different label and target, or two oversized distinct links still fail closed',async()=>{
  const url='https://www.douyin.com/video/7688384079717777242/?tracking='+'x'.repeat(850);
  await assert.rejects(map(`[${url}](https://v.douyin.com/different/)`+'x'.repeat(300)),/未截断/);
  await assert.rejects(map(`[${url}](${url}) https://v.douyin.com/other/ `+'y'.repeat(300)),/未截断/);
});
test('normalizing exact echo never trusts a lookalike domain',async()=>{
  const url='https://www.douyin.com.evil.test/video/7688384079717777242/?tracking='+'x'.repeat(800);
  const [row]=await map(`[${url}](${url})`);
  assert.equal(row.videoId,null); assert.equal(row.locator,null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { publicText, createPublicTextRedactor } from '../lib/public-text.mjs';

test('snapshot redactor preserves exact ordered literal replacement, including overlapping locators',()=>{
 for(const locators of [['abcdef','bcdefgh'],['bcdefgh','abcdef'],['[标识已隐藏]','abcdef'],['abcdef','[标识已隐藏]']]){
  const redact=createPublicTextRedactor(locators);
  for(const value of ['abcdefgh abcdef bcdefgh','[标识已隐藏] abcdef',null,1,'plain text'])
   assert.equal(redact(value),publicText(value,locators));
 }
});

test('regex characters, brackets, backslashes and Unicode locators remain literal and private',()=>{
 const locators=['aa.*+?^${}()|[]\\','账号私有身份甲乙丙','MS4w.fixture.123','a/b/c/d'];const redact=createPublicTextRedactor(locators);
 for(const locator of locators) {
  const value='before '+locator+' after';assert.equal(redact(value),publicText(value,locators));
  assert.ok(!redact(value).includes(locator));
 }
 assert.equal(redact('MS4wXfixtureX123'), 'MS4wXfixtureX123');
});

test('base URL, markup, control and credential redaction still precedes locator replacement and truncation',()=>{
 const locators=['secret_locator','[凭据已隐藏]'];const redact=createPublicTextRedactor(locators);
 for(const value of ['<b>姓名</b>\n cookie="secret_locator" https://private.test/secret_locator Bearer SECRET',
  'secret_locator boundary text', 'TOKEN=SECRET valid name', '0', '', null]){
  for(const limit of [0,5,300])assert.equal(redact(value,limit),publicText(value,locators,limit));
 }
});

test('factory captures one source-read snapshot without global reuse or mutable-array privacy state',()=>{
 const locators=['initial_private'];const first=createPublicTextRedactor(locators);locators[0]='updated_private';
 const second=createPublicTextRedactor(locators);
 assert.equal(first('initial_private updated_private'),'[标识已隐藏] updated_private');
 assert.equal(second('initial_private updated_private'),'initial_private [标识已隐藏]');
});

test('oversized matcher construction falls back to exact literal redaction',()=>{
 const locators=['a'.repeat(512001),'private_id'];const redact=createPublicTextRedactor(locators);
 assert.equal(redact('safe private_id'), publicText('safe private_id',locators));
});

test('deterministic mixed payload corpus is byte-equivalent to the original redactor',()=>{
 let seed=271828;
 const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 const atoms=['safe','秘密文本','abcdef','bcdefgh','regex.*literal','https://private.test/path','cookie=SECRET','<b>name</b>','[标识已隐藏]','🟢'];
 const locators=['bcdefgh','abcdef','regex.*literal','[标识已隐藏]'];const redact=createPublicTextRedactor(locators);
 for(let i=0;i<600;i++){
  const value=Array.from({length:8},()=>atoms[next()%atoms.length]).join(' ');const limit=next()%160;
  assert.equal(redact(value,limit),publicText(value,locators,limit));
 }
});

test('unmatched text does not perform the original per-locator split scans',()=>{
 const locators=Array.from({length:1000},(_,i)=>'MS4w-private-fixture-'+i),set=new Set(locators);
 const redact=createPublicTextRedactor(locators),original=String.prototype.split;
 let splits=0;
 String.prototype.split=function(separator,...rest){if(set.has(separator))splits++;return original.call(this,separator,...rest);};
 try{
  for(let i=0;i<100;i++)assert.equal(redact('plain author title '+i),'plain author title '+i);
  assert.equal(splits,0);
  publicText('plain author title',locators);assert.equal(splits,1000);
  redact('MS4w-private-fixture-9');assert.equal(splits,2000); // Exact old loop on a real match.
 }finally{String.prototype.split=original;}
});

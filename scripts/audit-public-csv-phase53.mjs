import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

// Independent audit of the actual anonymous browser download, against saved source bytes.
const root='data/public-replica-staging/publisher-2026-10-01T05-08-10-925Z';
const file='output/playwright/date-proof-public-month-slice-20261001.csv';
const parse=text=>{const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(ch===','&&!quoted){row.push(cell);cell='';}else if(ch==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=ch;}if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}assert.equal(quoted,false);return rows;};
const bytes=readFileSync(file),csv=parse(bytes.toString('utf8').replace(/^\ufeff/,'')),headers=csv.shift();
const records=csv.map(r=>Object.fromEntries(headers.map((key,i)=>[key,r[i]])));
const catalog=JSON.parse(readFileSync(root+'/catalog.json')),manifest=JSON.parse(readFileSync(root+'/manifest.json'));
const accounts=catalog.accounts.filter(a=>a.enabled&&a.classification.theme.key==='tuantuan'&&a.classification.labels.some(l=>l.key==='slice'));
assert.equal(records.length,accounts.length);assert.equal(new Set(records.map(r=>r.targetId)).size,accounts.length);
const names={followers:'粉丝',likes:'点赞',posts:'作品存量'},sums={followers:0,likes:0,posts:0},comparable={followers:0,likes:0,posts:0};
for(const account of accounts){const row=records.find(r=>Number(r.targetId)===account.id);assert.ok(row);const path='daily/'+account.id+'.json',raw=readFileSync(root+'/'+path),part=manifest.files.find(f=>f.path===path),points=JSON.parse(raw).items;
 assert.equal(row.asOf,manifest.asOf);assert.equal(row.platform,account.platform);assert.equal(row['作者'],account.label.replace(/^\s*[=+@-]/,s=>"'"+s));assert.equal(row['主题'],'团团');assert.equal(row['账号状态'],'启用');assert.equal(row['起点采样日'],'2026-09-30');assert.equal(row['终点采样日'],'2026-10-01');assert.equal(row.dailyPart,path);assert.equal(row.dailyPartSha256,createHash('sha256').update(raw).digest('hex'));assert.equal(row.dailyPartSha256,part.sha256);
 const start=points.find(p=>p.date==='2026-09-30'),end=points.find(p=>p.date==='2026-10-01');
 for(const [key,name] of Object.entries(names)){const b=start?.[key]??null,e=end?.[key]??null,d=b===null||e===null?null:e-b;assert.equal(row[name+'基准'],b===null?'':String(b));assert.equal(row[name],e===null?'':String(e));assert.equal(row[name+'净变'],d===null?'':String(d));assert.equal(row[key+'BaselineAt'],b===null?'':start[key+'At']??start.capturedAt);assert.equal(row[key+'CurrentAt'],e===null?'':end[key+'At']??end.capturedAt);if(d!==null){sums[key]+=d;comparable[key]++;}}
}
console.log(JSON.stringify({checkedAt:new Date().toISOString(),download:file,sha256:createHash('sha256').update(bytes).digest('hex'),asOf:manifest.asOf,start:'2026-09-30',end:'2026-10-01',theme:'tuantuan',classification:'slice',rows:records.length,uniqueIds:accounts.length,comparable,sums,estimatedPlaysChange:sums.likes*100,estimateMeaning:'点赞净变化乘100，非平台实际播放量',errors:0},null,2));

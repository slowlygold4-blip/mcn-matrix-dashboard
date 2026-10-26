// Read-only acceptance against exact immutable publication; not a collector.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root='data/public-replica-staging/publisher-2026-10-01T05-44-51-113Z';
const manifest=JSON.parse(readFileSync(root+'/manifest.json'));
const hash=b=>createHash('sha256').update(b).digest('hex');
function part(path){const meta=manifest.files.find(f=>f.path===path);assert.ok(meta);const bytes=readFileSync(root+'/'+path);assert.equal(bytes.length,meta.bytes);assert.equal(hash(bytes),meta.sha256);const value=JSON.parse(bytes);assert.equal(value.asOf,manifest.asOf);return {meta,value};}
function parse(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}assert.equal(quoted,false);return rows;}
const bytes=readFileSync('data/maintenance-journal/2026-10-01-phase57-tuantuan-daily-gap-dom.csv');
const table=parse(bytes.toString('utf8').replace(/^\ufeff/,'')),header=table.shift();
assert.equal(new Set(header).size,13);assert.equal(header.length,13);
const rows=table.map(r=>{assert.equal(r.length,13);return Object.fromEntries(header.map((k,i)=>[k,r[i]]));});
const catalog=part('catalog.json').value;
const selected=catalog.accounts.filter(a=>a.enabled&&a.classification.theme.key==='tuantuan'&&a.classification.labels.some(l=>l.key==='slice'));
assert.equal(selected.length,276);
const safe=v=>v==null?'':typeof v==='string'&&/^\s*[=+@-]/.test(v)?"'"+v:String(v);
const wanted=[];let zeros=0;
for(const a of selected){const {meta,value}=part('daily/'+a.id+'.json'),today=value.items.find(p=>p.date==='2026-09-20'),baseline=value.items.find(p=>p.date==='2026-09-19');if(today?.followers==null||baseline?.followers!=null)continue;wanted.push(a.id);const row=rows.find(r=>Number(r['账号编号'])===a.id);assert.ok(row);assert.equal(row['作者'],safe(a.label));assert.equal(row['平台'],a.platform);assert.equal(row['观察日'],'2026-09-20');assert.equal(row['指标'],'followers');assert.equal(row['缺口状态'],'missingBaseline');assert.equal(row['前日指标值'],'');assert.equal(row['前日真实采样UTC'],baseline?.followersAt??'');assert.equal(row['本日指标值'],String(today.followers));assert.equal(row['本日真实采样UTC'],today.followersAt);assert.equal(row['相邻日净变化'],'');assert.equal(row['固定数据截止UTC'],manifest.asOf);assert.equal(row['账号日历史分区SHA256'],meta.sha256);zeros+=Number(today.followers===0);}
assert.equal(rows.length,275);assert.equal(new Set(rows.map(r=>r['账号编号'])).size,275);assert.deepEqual(rows.map(r=>Number(r['账号编号'])).sort((a,b)=>a-b),wanted.sort((a,b)=>a-b));
console.log(JSON.stringify({checkedAt:new Date().toISOString(),asOf:manifest.asOf,scope:'tuantuan/slice',date:'2026-09-20',baselineDate:'2026-09-19',metric:'followers',reason:'missingBaseline',selected:276,rows:275,zeroCurrentValues:zeros,csvSha256:hash(bytes),errors:0,source:'actual rendered readonly CSV textarea, not successful download'},null,2));

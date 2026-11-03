import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditPublicationCoverage} from '../lib/publication-coverage-audit.mjs';
import {publishingPartitions} from '../lib/replica-publishing.mjs';
import {auditPublishedCoverageDirectory} from '../scripts/audit-published-coverage.mjs';
import {recordConfirmedPublicationCoverage} from '../scripts/public-replica-publisher.mjs';

const asOf='2026-10-03T01:00:00.000Z',common={version:1,asOf,timeZone:'Asia/Shanghai'};
const native=(id,extra={})=>({externalId:String(id),targetId:1,publishedAt:'2026-09-12T17:00:00.000Z',...extra});
const row=(id,extra={})=>({contentId:String(id),date:'2026-09-13',author:'synthetic author',title:'synthetic work',targetId:1,classifications:[],origin:'platform',...extra});
function fixture({works=[native(100)],sources=[],references=[],rows=[row(100)],accounts=[{id:1,platform:'douyin'}],scoped=false}={}){
  const files=[],parts=new Map();
  const add=(path,kind,part,count,targetId)=>{const meta={path,kind,count,...(targetId==null?{}:{targetId})};files.push(meta);parts.set(path,{...common,...part});};
  add('catalog.json','catalog',{accounts},accounts.length);
  for(const account of accounts){const items=works.filter(work=>work.targetId===account.id);add(`works/${account.id}.json`,'works',{items},items.length,account.id);}
  if(sources.length)add('creator/works-001.json','creatorWorks',{items:sources},sources.length);
  if(references.length)add('foundation/other-works.json','foundationOtherWorks',{items:references},references.length);
  const ledgerRows=scoped?rows.map(r=>({...r,scopeId:0,platform:r.platform??'douyin',metrics:{likes:{value:0,origin:'platform'},plays:{value:null,origin:'unavailable'}}})):rows;
  for(const {path,kind,items,count,...part}of publishingPartitions(ledgerRows,scoped?{withMetrics:true,scopes:[{theme:'tuantuan',boardKeys:[],labels:[]}]}:{}))add(path,kind,items?{items}:{...part,count},items?.length??count);
  return {manifest:{...common,files},parts,readPart:async meta=>parts.get(meta.path)};
}
test('same work from source and platform is one dated ledger row, not a new addend',async()=>{
  const f=fixture({sources:[{contentId:'100',publishDate:'2026-09-15'}]});
  const result=await auditPublicationCoverage(f);
  assert.equal(result.status,'passed');assert.equal(result.expectedLedgerWorks,1);assert.equal(result.savedSourceWorks,1);
  assert.equal(result.ledgerWorks,1);assert.equal(result.mismatchCount,0);
  assert.equal(result.overlappingSavedWorks,1);assert.equal(result.uniqueSavedWorks,1);
});
test('native timestamp uses Beijing day and cannot borrow a different ledger date',async()=>{
  const result=await auditPublicationCoverage(fixture({rows:[row(100,{date:'2026-09-12'})]}));
  assert.equal(result.status,'failed');assert.equal(result.mismatchKinds['publication-day-mismatch'],1);
  assert.equal(result.mismatches[0].expectedDate,'2026-09-13');
});
test('stronger native date before business start explains an unknown or later source date without losing the raw source',async()=>{
  for(const publishDate of ['', '2026-09-15']){
    const f=fixture({works:[native(100,{publishedAt:'2026-08-21T01:00:00.000Z'})],sources:[{contentId:'100',publishDate}],rows:[]});
    const before=JSON.stringify([...f.parts]);const result=await auditPublicationCoverage(f);
    assert.equal(result.status,'passed');assert.equal(result.sourceDateSupersededBeforeStart,1);assert.equal(result.excludedBeforeStart,1);
    assert.equal(JSON.stringify([...f.parts]),before);
  }
});
test('unknown publication day remains a retained undated work and never takes first-seen as its date',async()=>{
  const f=fixture({works:[native(100,{publishedAt:null,firstSeenAt:asOf})],rows:[row(100,{date:''})]});
  assert.equal((await auditPublicationCoverage(f)).status,'passed');
  f.parts.get('publishing/000001.json').items[0].date='2026-10-03';
  await assert.rejects(auditPublicationCoverage(f),/date-conflict/);
});
test('missing known work and an untraceable extra work fail even with internally valid ledger totals',async()=>{
  const missing=await auditPublicationCoverage(fixture({works:[native(100),native(200)]}));
  assert.equal(missing.mismatchKinds['missing-from-ledger'],1);
  const extra=await auditPublicationCoverage(fixture({rows:[row(100),row(300)]}));
  assert.equal(extra.mismatchKinds['untraceable-ledger-row'],1);
});
test('native duplicates fail; conflicting native ownership and unsupported platforms remain incomplete',async()=>{
  const duplicate=await auditPublicationCoverage(fixture({works:[native(100),native(100)]}));
  assert.equal(duplicate.mismatchKinds['native-duplicate'],1);
  const ambiguous=await auditPublicationCoverage(fixture({accounts:[{id:1,platform:'douyin'},{id:2,platform:'douyin'}],works:[native(100),native(100,{targetId:2})],rows:[]}));
  assert.equal(ambiguous.status,'incomplete');assert.equal(ambiguous.ambiguousNativeOwnership,1);
  const unsupported=await auditPublicationCoverage(fixture({accounts:[{id:1,platform:'xiaohongshu'}],rows:[]}));
  assert.equal(unsupported.status,'incomplete');assert.equal(unsupported.unsupportedNativeRows,1);
});
test('conflicting source days cannot be resolved by choosing the latest or largest value',async()=>{
  const result=await auditPublicationCoverage(fixture({works:[],sources:[{contentId:'100',publishDate:'2026-09-13'},{contentId:'100',publishDate:'2026-09-14'}]}));
  assert.equal(result.status,'incomplete');assert.equal(result.unresolvedDateConflicts,1);assert.equal(result.mismatchCount,0);
});
test('valid source-only and Bilibili records are included; a truly empty saved edition stays distinct from source completeness',async()=>{
  assert.equal((await auditPublicationCoverage(fixture({works:[],sources:[{contentId:'100',publishDate:'2026-09-13'}]}))).status,'passed');
  const bili=fixture({accounts:[{id:1,platform:'bilibili'}],works:[native('BV1234567890')],rows:[row('BV1234567890',{platform:'bilibili'})],scoped:true});
  assert.equal((await auditPublicationCoverage(bili)).status,'passed');
  const invalid=fixture({accounts:[{id:1,platform:'bilibili'}],works:[native('BV1234567890')],rows:[row('BV1234567890')]});
  // Legacy unscoped ledger rows are Douyin-only. A source cannot silently
  // change namespaces merely because its display title matches.
  await assert.rejects(auditPublicationCoverage(invalid));
  const empty=await auditPublicationCoverage(fixture({works:[],rows:[]}));
  assert.equal(empty.status,'passed');assert.equal(empty.ledgerWorks,0);assert.match(empty.limits[0],/not complete platform inventory/);
});
test('a shard omitted from the day index or duplicate ledger identity cannot pass bookkeeping audit',async()=>{
  const f=fixture();f.parts.get('publishing.json').days=[];
  await assert.rejects(auditPublicationCoverage(f),/total-conflict/);
  const duplicate=fixture({rows:[row(100),row(200)]});duplicate.parts.get('publishing/000001.json').items[1]=row(100);
  await assert.rejects(auditPublicationCoverage(duplicate),/identity-or-date-conflict/);
});

async function onDisk(t,f){
  const directory=await mkdtemp(join(tmpdir(),'mcn-publication-coverage-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  for(const meta of f.manifest.files){
    const content=JSON.stringify(f.parts.get(meta.path))+'\n';meta.bytes=Buffer.byteLength(content);meta.sha256=createHash('sha256').update(content).digest('hex');
    const path=join(directory,meta.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,content);
  }
  await writeFile(join(directory,'manifest.json'),JSON.stringify(f.manifest));return directory;
}
test('directory adapter verifies every consumed byte and refuses symlinks and traversal',async t=>{
  const f=fixture(),directory=await onDisk(t,f);assert.equal((await auditPublishedCoverageDirectory(directory)).status,'passed');
  const file=join(directory,'works/1.json'),before=await readFile(file);await writeFile(file,Buffer.concat([before,Buffer.from(' ')]));
  await assert.rejects(auditPublishedCoverageDirectory(directory),/partition-size/);
  await rm(file);await symlink(join(directory,'catalog.json'),file);await assert.rejects(auditPublishedCoverageDirectory(directory));
  f.manifest.files.find(m=>m.kind==='works').path='../outside.json';await writeFile(join(directory,'manifest.json'),JSON.stringify(f.manifest));
  await assert.rejects(auditPublishedCoverageDirectory(directory),/partition-path/);
});
test('CLI reports failure with nonzero exit and leaves original partitions unchanged',async t=>{
  const directory=await onDisk(t,fixture({works:[native(100),native(200)]}));
  const before=await readFile(join(directory,'works/1.json'));
  const command=fileURLToPath(new URL('../scripts/audit-published-coverage.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[command,directory],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).mismatchKinds['missing-from-ledger'],1);
  assert.equal(result.stdout.includes('synthetic author'),false);assert.deepEqual(await readFile(join(directory,'works/1.json')),before);
});
test('automatic receipt is generation-bound and retains incomplete findings without changing publication state',async()=>{
  let saved;const report={asOf,status:'incomplete',unresolvedDateConflicts:1};
  const result=await recordConfirmedPublicationCoverage('/synthetic-only',asOf,{inspect:async()=>report,persist:async value=>{saved=value;}});
  assert.equal(result.status,'incomplete');assert.equal(saved.asOf,asOf);assert.equal(saved.unresolvedDateConflicts,1);
  const wrong=await recordConfirmedPublicationCoverage('/synthetic-only',asOf,{inspect:async()=>({...report,asOf:'2026-10-02T01:00:00.000Z'}),persist:async value=>{saved=value;}});
  assert.equal(wrong.status,'unavailable');assert.equal(saved.asOf,asOf);
  const wrongBytes=await recordConfirmedPublicationCoverage('/synthetic-only',asOf,{expectedManifestSha256:'a'.repeat(64),inspect:async()=>({...report,sourceManifestSha256:'b'.repeat(64)}),persist:async()=>{}});
  assert.equal(wrongBytes.status,'unavailable');
});
test('audit and private report persistence failures cannot throw or expose private source errors after activation',async()=>{
  const unavailable=await recordConfirmedPublicationCoverage('/synthetic-only',asOf,{inspect:async()=>{throw Error('PRIVATE_SOURCE_ERROR');},persist:async()=>{}});
  assert.equal(unavailable.status,'unavailable');assert.equal(JSON.stringify(unavailable).includes('PRIVATE_SOURCE_ERROR'),false);
  const failed=await recordConfirmedPublicationCoverage('/synthetic-only',asOf,{inspect:async()=>({asOf,status:'passed'}),persist:async()=>{throw Error('PRIVATE_DISK_ERROR');}});
  assert.equal(failed.code,'publication-coverage-report-write-failed');assert.equal(JSON.stringify(failed).includes('PRIVATE_DISK_ERROR'),false);
});
test('registered link-only works are audited too, without inventing a date or resurrecting a known old work',async()=>{
 const references=[{contentId:'200',author:'登记作者',board:'未分板块'}];
 const missing=await auditPublicationCoverage(fixture({references}));assert.equal(missing.mismatchKinds['missing-from-ledger'],1);
 assert.equal(missing.referenceOnlyWorks,1);assert.equal(missing.mismatches[0].expectedDate,'');
 const found=await auditPublicationCoverage(fixture({references,rows:[row(100),row(200,{date:'',targetId:null,origin:'source'})]}));
 assert.equal(found.status,'passed');assert.equal(found.savedReferenceRows,1);
 const old=await auditPublicationCoverage(fixture({works:[native(200,{publishedAt:'2026-08-01T00:00:00.000Z'})],references,rows:[]}));
 assert.equal(old.status,'passed');assert.equal(old.excludedBeforeStart,1);assert.equal(old.referenceOnlyWorks,0);
});

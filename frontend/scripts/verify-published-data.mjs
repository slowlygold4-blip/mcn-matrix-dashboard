import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadCreatorSourceEdition,loadTableFoundationEdition} from '../lib/source-edition-loader.mjs';
import {buildCreatorIntelligence,summarizeSourceObservations} from '../lib/creator-intelligence.mjs';
const fail=code=>{throw Error('published-verification-failed:'+code);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const privateField=value=>value&&typeof value==='object'&&Object.entries(value).some(([key,child])=>/^(raw_json|rawJson|metadata|metadata_json|cookie|cookies|password|token|authorization|accessToken|refreshToken|bonus|reward|settings)$/i.test(key)||privateField(child));
export async function verifyPublishedDirectory(directory,{expectedRevision}={}){
 if(typeof directory!=='string'||!directory.trim())fail('directory-required');
 const root=await realpath(resolve(directory));let verifiedFiles=0;
 const read=async(section,path,descriptor=null,revision=null)=>{
  if(!['creator-source','table-foundation'].includes(section)||!path.split('/').every(x=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(x))||!path.endsWith('.json'))fail('unsafe-path');
  const actual=await realpath(resolve(root,section,path)),rel=relative(root,actual);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))fail('escaped-file');
  if((await stat(actual)).size>8_000_000)fail('file-budget');const bytes=await readFile(actual);
  if(descriptor&&(bytes.length!==descriptor.bytes||hash(bytes)!==descriptor.sha256))fail('seal');
  const body=JSON.parse(bytes);if(privateField(body))fail('private-field');
  // Legacy sealed exports have {revision,items}; current exports add version:1.
  // Both retain the exact root revision, byte/hash seal and declared row count.
  if(descriptor&&((body.version!==undefined&&body.version!==1)||String(body.revision)!==revision||!Array.isArray(body.items)||body.items.length!==descriptor.count))fail('part-contract');
  verifiedFiles++;return descriptor?body.items:body;
 };
 const source=await read('creator-source','index.json');if(expectedRevision!==undefined&&String(source.revision)!==expectedRevision)fail('revision');
 const edition=await loadCreatorSourceEdition(source,(file,revision)=>read('creator-source',file.path,file,revision));
 const authors=edition.authors.items,works=edition.works.items;
 const ids=authors.map(a=>String(a.douyinId??'').normalize('NFKC').trim().toLowerCase());if(ids.some(id=>!id)||new Set(ids).size!==ids.length)fail('duplicate-author');
 const workIds=works.map(w=>w.contentId);if(workIds.some(id=>!/^\d{16,22}$/.test(id))||new Set(workIds).size!==works.length)fail('duplicate-work');
 const computed=buildCreatorIntelligence(authors,works),saved=edition.insights?.items;
 if(!saved)fail('insights-required');
 for(const key of ['tableAuthors','tableWorks','datedWorks','playsKnown','likesKnown','cumulativePlays','cumulativeLikes'])if(computed.counts[key]!==saved.counts[key])fail('insights-count');
 const stats={datedWorks:'datedWorks',worksWithPlays:'playsKnown',worksWithLikes:'likesKnown',cumulativePlays:'cumulativePlays',cumulativeLikes:'cumulativeLikes'};
 for(const [field,key]of Object.entries(stats))if(source.stats[field]!==computed.counts[key])fail('source-count');
 if(source.stats.rawAuthorRows-source.stats.reciprocalDuplicates!==authors.length)fail('raw-author-count');
 const index=await read('table-foundation','index.json'),foundation=await loadTableFoundationEdition(index,(file,revision)=>read('table-foundation',file.path,file,revision));
 for(const rows of [foundation.authors,foundation.works,foundation.pendingAuthors]){
  const keys=rows.map(row=>row.contentId??(row.douyinId?.trim()?row.douyinId:row.rowKey));if(keys.some(k=>typeof k!=='string'||!k)||new Set(keys).size!==keys.length)fail('supplement-identity');
 }
 const observations=summarizeSourceObservations(foundation.observations);
 return {sourceRevision:String(source.revision),foundationRevision:String(index.revision),authors:authors.length,works:works.length,supplementAuthors:foundation.authors.length,supplementWorks:foundation.works.length,pendingAuthors:foundation.pendingAuthors.length,observationRows:observations.rows,ambiguousObservedWorks:observations.ambiguousWorks,verifiedFiles,readOnly:true,platformRequests:0,modelCalls:0,actualPlaysIndependentlyVerified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);let directory,expectedRevision;
 for(let i=0;i<args.length;i++){if(args[i]==='--directory')directory=args[++i];else if(args[i]==='--expected-revision')expectedRevision=args[++i];else{console.error('Usage: npm run test:published -- --directory /absolute/export/public [--expected-revision ID]');process.exit(2);}}
 if(!directory){console.error('必须显式提供 --directory；普通源码测试不会读取业务数据。');process.exitCode=2;}
 else try{console.log(JSON.stringify(await verifyPublishedDirectory(directory,{expectedRevision})));}catch(error){console.error(error.message?.startsWith('published-verification-failed:')?error.message:'published-verification-failed: unavailable-or-invalid-data');process.exitCode=1;}
}

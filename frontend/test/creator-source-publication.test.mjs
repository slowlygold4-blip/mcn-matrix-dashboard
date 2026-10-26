import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const directory = new URL('../public/creator-source/', import.meta.url);
const forbidden = /授权|奖金|候选|原始来源|来源键|收集记录|登记记录|metadata|cookie|token/i;
const authorFields = ['row','name','douyinId','posts','slicePosts','creationPosts','aiPosts','cupPosts','plays','likes','followers','targetIds'];
const workFields = ['row','contentId','author','douyinId','publishDate','type','track','tracks','plays','likes','title','url'];
test('public creator projection contains every imported author/work, exact sealed bytes, and no private columns', async () => {
  const index = JSON.parse(await readFile(new URL('index.json',directory),'utf8'));
  assert.equal(index.version,1);
  assert.equal(index.revision,'1697');
  assert.equal(index.stats.authors,4389);
  assert.equal(index.stats.rawAuthorRows,4481);
  assert.equal(index.stats.reciprocalDuplicates,92);
  assert.equal(index.stats.rawAuthorRows-index.stats.reciprocalDuplicates,index.stats.authors);
  assert.equal(index.stats.works,18179);
  let authorCount=0,workCount=0,plays=0,likes=0,withPlays=0,withLikes=0;
  for (const file of index.files) {
    assert.match(file.path,/^(authors|insights|works-\d{3})\.json$/);
    const bytes=await readFile(new URL(file.path,directory));
    assert.equal(bytes.length,file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
    const body=JSON.parse(bytes);
    assert.equal(body.revision,index.revision);
    assert.equal(body.items.length,file.count);
    if(file.path==='insights.json'){
      assert.equal(body.items.length,1);
      assert.equal(body.items[0].counts.tableAuthors,index.stats.authors);
      assert.equal(body.items[0].counts.datedWorks+(body.items[0].counts.undatedWorks??0),index.stats.works);
      continue;
    }
    const authors=file.path==='authors.json';
    for (const row of body.items) {
      assert.deepEqual(Object.keys(row),authors?authorFields:workFields);
      assert.ok(!Object.keys(row).some(key=>forbidden.test(key)));
      if(authors){authorCount++;assert.ok(Array.isArray(row.targetIds));}
      else {workCount++;if(row.plays!==null){plays+=row.plays;withPlays++;}if(row.likes!==null){likes+=row.likes;withLikes++;}
        if(row.url){const url=new URL(row.url);assert.equal(url.protocol,'https:');assert.match(url.hostname,/(^|\.)douyin\.com$/);assert.equal(url.search,'');}}
    }
  }
  assert.equal(authorCount,index.stats.authors);
  assert.equal(workCount,index.stats.works);
  assert.equal(withPlays,index.stats.worksWithPlays);
  assert.equal(withLikes,index.stats.worksWithLikes);
  assert.equal(plays,index.stats.cumulativePlays);
  assert.equal(likes,index.stats.cumulativeLikes);
});

const script=fileURLToPath(new URL('../scripts/export-creator-source.mjs',import.meta.url));
function fixture(databasePath){
 const db=new DatabaseSync(databasePath);
 db.exec('CREATE TABLE creator_source_imports(id INTEGER,source_revision TEXT,source_modified_at TEXT,imported_at TEXT,source_row_count INTEGER); CREATE TABLE source_rows(sheet_id TEXT,row_number INTEGER,values_json TEXT); CREATE TABLE account_links(author_row INTEGER,target_id INTEGER)');
 db.prepare('INSERT INTO creator_source_imports VALUES(?,?,?,?,?)').run(1,'fixture-v1','2026-10-23T00:00:00Z','2026-10-23T01:00:00Z',4);
 const author=['测试作者','author1',null,null,null,null,3,3,0,0,0,300,7,null,null];
 db.prepare('INSERT INTO source_rows VALUES(?,?,?)').run('08',2,JSON.stringify(author));
 const works=[
  ['7300000000000000000','测试作者','author1','2026-10-12','切片','切片激励','切片激励',100,7,null,'有日期作品','https://www.douyin.com/video/7300000000000000000'],
  ['7300000000000000001','测试作者','author1',null,'切片','切片激励','切片激励',200,' ',null,'无日期作品','https://www.douyin.com/video/7300000000000000001'],
  ['7300000000000000002','测试作者','author1','', '切片','切片激励','切片激励',0,0,null,'未填写日期作品',null],
 ];
 for(const [index,row] of works.entries())db.prepare('INSERT INTO source_rows VALUES(?,?,?)').run('09',index+2,JSON.stringify(row));
 db.close();
 return works;
}
const exportTo=(databasePath,output)=>spawnSync(process.execPath,[script,databasePath,output],{encoding:'utf8'});
async function bytesIn(directory){const result={};for(const file of await readdir(directory))result[file]=await readFile(join(directory,file));return result;}

test('source publication includes undated works and seals counts, known metrics and chronology separately',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcn-source-publication-'));
 try{
  const databasePath=join(root,'source.sqlite'),output=join(root,'public');fixture(databasePath);
  const before=await readFile(databasePath),run=exportTo(databasePath,output);
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(await readFile(databasePath),before);
  const index=JSON.parse(await readFile(join(output,'index.json'),'utf8'));
  assert.equal(index.stats.works,3);assert.equal(index.stats.datedWorks,1);assert.equal(index.stats.undatedWorks,2);
  assert.equal(index.stats.cumulativePlays,300);assert.equal(index.stats.cumulativeLikes,7);
  assert.equal(index.stats.worksWithLikes,2);
  const parts={};
  for(const file of index.files){
   const bytes=await readFile(join(output,file.path));
   assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
   const body=JSON.parse(bytes);assert.equal(body.revision,index.revision);assert.equal(body.items.length,file.count);
   parts[file.path]=body.items;
  }
  const analysis=parts['insights.json'][0];
  assert.equal(analysis.counts.tableWorks,3);assert.equal(analysis.counts.datedWorks,1);assert.equal(analysis.counts.undatedWorks,2);
  assert.equal(analysis.counts.sevenDayWorks,1);assert.equal(analysis.counts.cumulativePlays,300);
  assert.equal(analysis.days.reduce((sum,day)=>sum+day.works,0),1);
  assert.deepEqual(parts['works-001.json'].map(work=>work.likes),[7,null,0]);
  assert.equal(analysis.leaderboards.all.works[0].contentId,'7300000000000000001');
  assert.equal(analysis.leaderboards.all.works[0].date,null);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('invalid source analysis fails before overwriting any published partition or creating a new output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcn-source-validation-'));
 try{
  const databasePath=join(root,'source.sqlite'),output=join(root,'public'),works=fixture(databasePath);
  const first=exportTo(databasePath,output);assert.equal(first.status,0,first.stderr);
  const published=await bytesIn(output);
  for(const invalid of ['2026-02-30','2026-13-01','unknown']){
   const db=new DatabaseSync(databasePath);
   works[1][3]=invalid;
   db.prepare("UPDATE source_rows SET values_json=? WHERE sheet_id='09' AND row_number=3").run(JSON.stringify(works[1]));
   db.prepare("UPDATE creator_source_imports SET source_revision='fixture-v2'").run();db.close();
   const before=await readFile(databasePath),failed=exportTo(databasePath,output);
   assert.notEqual(failed.status,0);assert.match(failed.stderr,/Invalid publication date: 7300000000000000001/);
   assert.deepEqual(await readFile(databasePath),before);
   assert.deepEqual(await bytesIn(output),published);
  }
  const absentOutput=join(root,'not-created');assert.notEqual(exportTo(databasePath,absentOutput).status,0);
  await assert.rejects(stat(absentOutput),error=>error.code==='ENOENT');
 }finally{await rm(root,{recursive:true,force:true});}
});

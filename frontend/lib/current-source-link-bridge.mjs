import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const hasImport = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_source_imports'").get());
const hash = value => createHash('sha256').update(value).digest('hex');

function sourceRowsFingerprint(db, frozen, importId) {
 const sha=createHash('sha256');
 const sql=frozen
  ? 'SELECT sheet_id,row_number,values_json FROM creator_source_rows WHERE import_id=? ORDER BY sheet_id,row_number'
  : 'SELECT sheet_id,row_number,values_json FROM source_rows ORDER BY sheet_id,row_number';
 let count=0;
 for(const row of db.prepare(sql).iterate(...(frozen?[importId]:[]))){
  sha.update(JSON.stringify([row.sheet_id,row.row_number,row.values_json])).update('\n');
  count++;
 }
 return {count,sha256:sha.digest('hex')};
}

/** Both DB connections must already be in read-only snapshot transactions. */
export async function readValidatedCurrentSourceLinks(creator,monitor,monitorPath,{allowAbsent=false,readLinks}={}) {
 const creatorHas=hasImport(creator),monitorHas=hasImport(monitor);
 if(!creatorHas&&!monitorHas&&allowAbsent){
  const hasRows=Boolean(creator.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_rows'").get()
   && creator.prepare("SELECT 1 FROM source_rows WHERE sheet_id IN ('08','09') LIMIT 1").get());
  if(!hasRows)return {accountLinks:[],workLinks:[],fingerprint:hash('no-current-source'),mode:'absent'};
 }
 if(!creatorHas||!monitorHas)throw Error('主库与作者总表的来源导入状态不一致，拒绝关联');
 const original=creator.prepare('SELECT * FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
 const current=monitor.prepare('SELECT * FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
 if(!original?.source_sha256||!current||original.source_sha256!==current.source_sha256
  ||String(original.source_revision)!==String(current.source_revision)
  ||original.source_modified_at!==current.source_modified_at
  ||original.source_row_count!==current.source_row_count)
  throw Error('主库与作者总表的来源版本不一致，拒绝关联');
 const source=sourceRowsFingerprint(creator,false),frozen=sourceRowsFingerprint(monitor,true,current.id);
 if(source.count!==frozen.count||source.sha256!==frozen.sha256)
  throw Error('主库冻结来源行与作者总表原始行不一致，拒绝关联');
 if(!readLinks){
  const workbenchRoot=dirname(dirname(resolve(monitorPath)));
  ({readCurrentCreatorSourceLinks:readLinks}=await import(pathToFileURL(join(workbenchRoot,'lib/creator-source-current-links.mjs')).href));
 }
 const result=readLinks(monitor,{imported:current});
 return {...result,mode:'current-strict'};
}

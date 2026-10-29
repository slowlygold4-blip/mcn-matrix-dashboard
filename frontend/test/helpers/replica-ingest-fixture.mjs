import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as wait} from 'node:timers/promises';

/** SQLite-backed D1/R2 adapter. Synthetic records only; no external I/O. */
export function ingestFixture(producer) {
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('CREATE TABLE replica_files(generation TEXT,path TEXT,checksum TEXT,bytes INTEGER,PRIMARY KEY(generation,path));CREATE TABLE replica_generations(generation TEXT PRIMARY KEY,manifest TEXT,published_at TEXT)');
 sqlite.exec('CREATE TABLE replica_file_references(generation TEXT,path TEXT,source_generation TEXT,source_checksum TEXT,source_bytes INTEGER,trailing_newline INTEGER,PRIMARY KEY(generation,path))');
 const metrics={heads:0,reads:0,individualWrites:0,batches:0,puts:0,activePuts:0,peakPuts:0},objects=new Map();
 const control={putDelay:0,failPut:null,failBatch:false,beforeBatch:null};
 function prepare(sql){return{bind(...params){const statement=sqlite.prepare(sql);return{
  sql,params,
  async first(){metrics.reads++;return statement.get(...params)??null;},
  async all(){metrics.reads++;return{results:statement.all(...params)};},
  async run(){metrics.individualWrites++;statement.run(...params);return{success:true};},
 };}};}
 const env={REPLICA_INGEST_SECRET:producer,DB:{prepare,async batch(statements){
  metrics.batches++;control.beforeBatch?.(sqlite);sqlite.exec('BEGIN');
  try{if(control.failBatch)throw Error('SYNTHETIC_PRIVATE_FAILURE');
   const result=statements.map(statement=>{sqlite.prepare(statement.sql).run(...statement.params);return{success:true};});
   sqlite.exec('COMMIT');return result;
  }catch(error){sqlite.exec('ROLLBACK');throw error;}
 }},BUCKET:{async head(key){metrics.heads++;const data=objects.get(key);return data===undefined?null:{size:Buffer.byteLength(data),etag:createHash('md5').update(data).digest('hex')};},async put(key,data){
  const index=metrics.puts++;metrics.activePuts++;metrics.peakPuts=Math.max(metrics.peakPuts,metrics.activePuts);
  try{if(control.putDelay)await wait(control.putDelay);
   if(control.failPut===index)throw Error('SYNTHETIC_PRIVATE_FAILURE');objects.set(key,data);
  }finally{metrics.activePuts--;}
 }}};
 return {env,sqlite,metrics,objects,control,reset(){
  sqlite.exec('DELETE FROM replica_file_references;DELETE FROM replica_files;DELETE FROM replica_generations');objects.clear();
  for(const key of Object.keys(metrics))metrics[key]=0;
  Object.assign(control,{putDelay:0,failPut:null,failBatch:false,beforeBatch:null});
 },close(){sqlite.close();}};
}

import {createHash} from 'node:crypto';
const hash=text=>createHash('sha256').update(text).digest('hex');
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;

// A transport hint only. The hosted receiver must read and hash the old
// published object before it can acknowledge these generation-bound bytes.
export function createReplicaUploadCompactor(generation,previous){
 if(!stamp(generation)||!stamp(previous?.asOf)||Date.parse(previous.asOf)>=Date.parse(generation)||!Array.isArray(previous.files)
  ||!previous.files.every(file=>file&&typeof file.path==='string'&&/^[a-f0-9]{64}$/.test(file.sha256)&&Number.isSafeInteger(file.bytes)&&file.bytes>0))return files=>({files});
 const byPath=new Map(previous.files.map(file=>[file.path,file]));
 return files=>{let compacted=0;
 const compact=files.map(file=>{
  const prior=byPath.get(file.path);if(!prior||typeof file.data!=='string')return file;
  try{
   const value=JSON.parse(file.data),plain=JSON.stringify(value);
   const ending=file.data===plain?'':file.data===plain+'\n'?'\n':null;
   if(ending===null||value.asOf!==generation||hash(file.data)!==file.sha256)return file;
   const old=JSON.stringify({...value,asOf:previous.asOf})+ending;
   if(hash(old)!==prior.sha256||Buffer.byteLength(old)!==prior.bytes)return file;
   compacted++;return {path:file.path,sha256:file.sha256,bytes:Buffer.byteLength(file.data)};
  }catch{return file;}
 });
 return compacted?{files:compact,referenceGeneration:previous.asOf,compacted}:{files};};
}
export const compactReplicaUpload=(files,generation,previous)=>createReplicaUploadCompactor(generation,previous)(files);

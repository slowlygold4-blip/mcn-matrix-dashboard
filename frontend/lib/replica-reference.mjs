// Reuse immutable content while retaining the exact generation-bound public bytes.
import {createHash}from'node:crypto';
const sha=t=>createHash('sha256').update(t).digest('hex');
const md5=t=>createHash('md5').update(t).digest('hex');
const time=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
const checksum=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const fail=()=>{throw Object.assign(Error('replica-reference-invalid'),{code:'replica-storage-repair'});};
const newline=(text,value)=>text===JSON.stringify(value)?0:text===JSON.stringify(value)+'\n'?1:null;
export function referenceCandidate(file,previous,previousGeneration,generation){
 if(!previous||!time(previousGeneration)||!time(generation)||Date.parse(previousGeneration)>=Date.parse(generation))return null;
 let value;try{value=JSON.parse(file.data);}catch{return null;}
 const ending=newline(file.data,value);if(ending===null||value?.asOf!==generation||sha(file.data)!==file.sha256)return null;
 const suffix=ending?'\n':'',prior=JSON.stringify({...value,asOf:previousGeneration})+suffix;
 if(sha(prior)!==previous.checksum||Buffer.byteLength(prior)!==previous.bytes)return null;
 const source_generation=previous.source_generation??previousGeneration;
 const source_checksum=previous.source_checksum??previous.checksum;
 const source_bytes=previous.source_bytes??previous.bytes;
 if(!time(source_generation)||Date.parse(source_generation)>Date.parse(previousGeneration)||!checksum(source_checksum)||!Number.isSafeInteger(source_bytes)||source_bytes<1)return null;
 const source=JSON.stringify({...value,asOf:source_generation})+suffix;
 if(sha(source)!==source_checksum||Buffer.byteLength(source)!==source_bytes)return null;
 return{source_generation,source_checksum,source_bytes,trailing_newline:ending,etag:md5(source),data:source};
}
export function referenceHeadMatches(head,ref){return !!head&&head.size===ref.source_bytes&&head.etag===ref.etag;}
export async function readReplicaText(bucket,generation,meta,ref){
 const referenced=ref?.source_generation!=null;
 if(referenced&&(!time(ref.source_generation)||Date.parse(ref.source_generation)>=Date.parse(generation)||!checksum(ref.source_checksum)||!Number.isSafeInteger(ref.source_bytes)||ref.source_bytes<1||![0,1].includes(ref.trailing_newline)))fail();
 const object=await bucket.get(referenced?`${ref.source_generation}/${ref.source_checksum}`:`${generation}/${meta.sha256}`);
 if(!object)return undefined;
 const expectedBytes=referenced?ref.source_bytes:meta.bytes;
 if(typeof object.size==='number'&&object.size!==expectedBytes)fail();
 let text=await object.text();
 if(Buffer.byteLength(text)!==expectedBytes||sha(text)!==(referenced?ref.source_checksum:meta.sha256))fail();
 if(referenced){
  let value;try{value=JSON.parse(text);}catch{fail();}
  if(value?.asOf!==ref.source_generation||newline(text,value)!==ref.trailing_newline)fail();
  text=JSON.stringify({...value,asOf:generation})+(ref.trailing_newline?'\n':'');
  if(Buffer.byteLength(text)!==meta.bytes||sha(text)!==meta.sha256)fail();
 }
 return text;
}

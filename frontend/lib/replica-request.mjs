// Authenticated producer bodies only. Bound wire and expanded bytes independently.
const fail=code=>Object.assign(Error('replica-request-rejected'),{code});
export async function readReplicaRequest(request,{maxBytes=11_500_000}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>11_500_000)throw fail('invalid-limit');
 const encoding=(request.headers.get('content-encoding')||'identity').trim().toLowerCase();
 if(!['identity','gzip'].includes(encoding))throw fail('unsupported-encoding');
 if(!request.body)return '';
 let wire=0,expanded=0;const chunks=[],decoder=new TextDecoder('utf-8',{fatal:true});
 const counted=request.body.pipeThrough(new TransformStream({transform(chunk,controller){wire+=chunk.byteLength;if(wire>maxBytes)throw fail('too-large');controller.enqueue(chunk);}}),{signal:request.signal});
 const reader=(encoding==='gzip'?counted.pipeThrough(new DecompressionStream('gzip')):counted).getReader();
 try{
  while(true){const {value,done}=await reader.read();if(done)break;expanded+=value.byteLength;if(expanded>maxBytes)throw fail('too-large');chunks.push(decoder.decode(value,{stream:true}));}
  chunks.push(decoder.decode());return chunks.join('');
 }catch(error){await reader.cancel().catch(()=>{});if(error?.code==='too-large')throw error;throw fail('invalid-body');}
 finally{reader.releaseLock();}
}

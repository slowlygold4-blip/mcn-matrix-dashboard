/** Bound the whole read, including body decoding; never starts a second request. */
export async function withReplicaReadDeadline({controller,operation,timeoutMs=20000}) {
 if(!controller?.signal||typeof controller.abort!=='function'||typeof operation!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw Error('读取期限参数无效');
 const signal=controller.signal;
 const canceled=()=>signal.reason instanceof Error?signal.reason:Object.assign(new Error('读取已取消。'),{name:'AbortError'});
 if(signal.aborted)throw canceled();
 let timer,onAbort;
 const stopped=new Promise((_,reject)=>{
  onAbort=()=>reject(canceled());signal.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>{const error=Object.assign(new Error('读取已保存数据超时，请重试。'),{name:'TimeoutError'});controller.abort(error);reject(error);},timeoutMs);
 });
 try{return await Promise.race([operation(signal),stopped]);}
 finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
}

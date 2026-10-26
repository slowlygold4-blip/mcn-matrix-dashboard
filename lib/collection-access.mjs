import {collectionTransport} from './collection-transport.mjs';
import {randomBytes,createHash} from 'node:crypto';
import {join} from 'node:path';
import {privateRead} from '../scripts/public-replica-publisher.mjs';
import {PUBLIC_REPLICA_ORIGIN} from './public-replica-sync.mjs';
export async function createCollectionAccess(dataDir){
 const secret=await privateRead(join(dataDir,'public-replica-publisher','credential'),{credential:true});
 const code=randomBytes(32).toString('hex');
 const response=await collectionTransport(PUBLIC_REPLICA_ORIGIN+'/api/collection',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({action:'grant',hash:createHash('sha256').update(code).digest('hex')})});
 if(!response.ok)throw Error('无法建立管理连接，请稍后重试');
 return {url:PUBLIC_REPLICA_ORIGIN+'/#collection-access='+code};
}

import {collectionTransport} from '../lib/collection-transport.mjs';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {privateRead} from './public-replica-publisher.mjs';
import {PUBLIC_REPLICA_ORIGIN} from '../lib/public-replica-sync.mjs';
const code=randomBytes(32).toString('hex');
const secret=await privateRead(fileURLToPath(new URL('../data/public-replica-publisher/credential',import.meta.url)),{credential:true});
const response=await collectionTransport(PUBLIC_REPLICA_ORIGIN+'/api/collection',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({action:'grant',hash:createHash('sha256').update(code).digest('hex')})});
if(!response.ok)throw Error('管理连接未创建，请确认发布服务在线后重试。');
// The one-time secret is a fragment: it is never sent in HTTP paths/referrers.
// Browser consumes it once and replaces it with a Secure HttpOnly cookie.
await new Promise((ok,no)=>execFile('/usr/bin/open',[PUBLIC_REPLICA_ORIGIN+'/#collection-access='+code],{timeout:10000},error=>error?no(error):ok()));
console.log('已在浏览器开启管理连接。仅此浏览器可下达采集指令，有效期 30 天；不会自动开始采集。');

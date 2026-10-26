import {env} from 'cloudflare:workers';
import {handleCollection} from '@/lib/collection-control.mjs';
export const dynamic='force-dynamic';
async function handle(request:Request){
 try{return await handleCollection(request,{db:env.DB,secret:(env as unknown as Record<string,unknown>).REPLICA_INGEST_SECRET});}
 catch{return Response.json({error:'采集状态暂不可用，请稍后重试'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
export const GET=handle;
export const POST=handle;

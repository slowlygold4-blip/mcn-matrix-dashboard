import {loadSummary} from './replica-summary.mjs';
import {loadSummaryRange,catalogDateWindow} from './replica-date-range.mjs';
import {dailyCoverageRequest} from './replica-daily-request.mjs';
import {workspaceSelectionScope} from './replica-navigation.mjs';
import {periodWindowFromCatalog} from './replica-periods.mjs';

/** Metadata and independent account/topic pages never depend on global history. */
/** @param {{manifest: any, readPart: (part: string) => Promise<any>, personal?: boolean, topicsOnly?: boolean, directoryOnly?: boolean, signal?: AbortSignal, rangeRequest?: any, workspace?: Record<string, any> | null, comparison?: Record<string, any>}} options */
export async function loadReplicaView({manifest,readPart,personal=false,topicsOnly=false,directoryOnly=false,signal,rangeRequest,workspace=null,comparison}){
 const dateIndexed=!personal&&!topicsOnly&&!directoryOnly&&manifest.files.some(f=>f.kind==='summaryDateIndex');
 // The index is independent of catalog and topics. Start its verified read in
 // parallel, but keep historical failures non-fatal to the account directory.
 const dateIndexRead=dateIndexed?(async()=>{try{return {value:await readPart('date-summary-index.json')};}catch(error){return {error};}})():null;
 const [rawCatalog,topics]=await Promise.all([readPart('catalog.json'),directoryOnly?Promise.resolve({topics:[],items:[]}):readPart('topics.json')]);
 const catalog={...rawCatalog,topicsLoaded:!directoryOnly};
 signal?.throwIfAborted();
 if(personal||topicsOnly||directoryOnly)return {...catalog,topics,points:[],summaryLoaded:false,summaryError:''};
 try{if(dateIndexed){const prefetched=await dateIndexRead;if('error' in prefetched)throw prefetched.error;const historyRead=path=>path==='date-summary-index.json'?Promise.resolve(prefetched.value):readPart(path);const scope=workspaceSelectionScope(workspace,catalog.accounts,catalog.boards),dateWindow=workspace?.period!=='since'&&workspace?.start?{start:workspace.start,end:workspace.end}:workspace?periodWindowFromCatalog(workspace.period,scope,manifest.asOf):catalogDateWindow(catalog.accounts,manifest.asOf),request=rangeRequest||dailyCoverageRequest({...dateWindow,...(comparison?.compare?{otherStart:comparison.otherStart,otherEnd:comparison.otherEnd}:{})}),loaded=await loadSummaryRange({manifest,readPart:historyRead,request,signal});return {...catalog,...loaded,dateWindow,topics,dateIndexed:true,summaryLoaded:true,summaryError:''};}const points=await loadSummary(manifest,readPart);signal?.throwIfAborted();return {...catalog,topics,points,dateIndexed:false,summaryLoaded:true,summaryError:''};}
 catch(error){if(signal?.aborted||error?.name==='AbortError')throw error;return {...catalog,topics,points:[],summaryLoaded:false,summaryError:'矩阵日历史暂不可读；账号独立历史与话题仍可查看。'+(error instanceof Error?error.message:'读取失败')};}
}

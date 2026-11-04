import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldStagePublicReplica,shouldPreparePublicDateIndex} from '../scripts/public-replica-publisher.mjs';
import {PUBLIC_REPLICA_EXPORT_REVISION} from '../lib/public-replica-export.mjs';
const t=Date.parse('2026-10-01T03:25:33.439Z'),state={coveredMarker:'same',lastConfirmedPublishedAt:new Date(t).toISOString()},observed={running:false,marker:'same'};
test('schema upgrade stages saved data once without bypassing cooldown or active collection',()=>{
 assert.equal(shouldStagePublicReplica(state,observed,t+1800000-1),false);
 assert.equal(shouldStagePublicReplica(state,observed,t+1800000),true);
 assert.equal(shouldStagePublicReplica({...state,exportRevision:PUBLIC_REPLICA_EXPORT_REVISION},observed,t+1800000),false);
 assert.equal(shouldStagePublicReplica(state,{...observed,running:true},t+1800000),false);
 assert.equal(shouldStagePublicReplica(state,observed,t-1),false);
 assert.equal(shouldStagePublicReplica({...state,lastConfirmedPublishedAt:'invalid'},observed,t+1800000),false);
});
test('preserved work-date basis gets one new export from unchanged data without replacing an active sealed generation',()=>{
 assert.equal(PUBLIC_REPLICA_EXPORT_REVISION,'catalog-date-range-v23-preserved-work-date-basis');
 const old={...state,exportRevision:'catalog-date-range-v22-http-work-clocks',publishedAsOf:new Date(t).toISOString()};
 assert.equal(shouldStagePublicReplica(old,observed,t+1),true,'changed projection must not wait for another source/collection event');
 assert.equal(shouldStagePublicReplica({...old,active:{asOf:new Date(t).toISOString(),exportRevision:old.exportRevision,dateIndex:true}},observed,t+1),false,'existing immutable generation must finish unchanged');
 assert.equal(shouldStagePublicReplica({...old,exportRevision:PUBLIC_REPLICA_EXPORT_REVISION},observed,t+1800000),false,'same data is not exported repeatedly once v23 is confirmed');
 assert.equal(shouldStagePublicReplica(old,{...observed,running:true},t+1),false,'revision does not bypass collection publication evidence');
});
test('v22 active generation without an explicit dateIndex flag retains its exact preparation feature',()=>{
 const active={exportRevision:'catalog-date-range-v22-http-work-clocks'};
 assert.equal(shouldPreparePublicDateIndex(active),true);
 assert.equal(shouldPreparePublicDateIndex({...active,dateIndex:false}),false,'an explicit sealed flag remains authoritative');
 assert.equal(shouldPreparePublicDateIndex({exportRevision:PUBLIC_REPLICA_EXPORT_REVISION}),true);
});

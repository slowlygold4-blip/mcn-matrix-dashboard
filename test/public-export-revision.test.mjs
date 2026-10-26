import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldStagePublicReplica} from '../scripts/public-replica-publisher.mjs';
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

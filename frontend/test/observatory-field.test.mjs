import test from 'node:test';
import assert from 'node:assert/strict';
import {FIELD_POINTS,FRAME_INTERVAL,orbitPoint,shouldAnimate} from '../lib/observatory-field.mjs';
test('geometry stays finite and bounded across rotation and pointer tilt',()=>{
 assert.ok(FIELD_POINTS<=80);assert.ok(FRAME_INTERVAL>=1000/30);
 for(let i=0;i<FIELD_POINTS;i++)for(const time of [0,90,36000])for(const x of [-.3,.3]){
  const p=orbitPoint(i,time,x,.2);assert.ok(Object.values(p).every(Number.isFinite));assert.ok(Math.abs(p.x)<1.5&&Math.abs(p.y)<1.5);assert.ok(p.opacity>=0&&p.opacity<=1);
 }
});
test('motion stops independently for system preference, user choice, hidden tab and offscreen',()=>{
 const active={reduced:false,disabled:false,hidden:false,intersecting:true};assert.equal(shouldAnimate(active),true);
 for(const key of ['reduced','disabled','hidden'])assert.equal(shouldAnimate({...active,[key]:true}),false);
 assert.equal(shouldAnimate({...active,intersecting:false}),false);
});

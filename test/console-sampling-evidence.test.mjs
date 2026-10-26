import test from 'node:test';
import assert from 'node:assert/strict';
import { periodEvidenceCaption, metricObservationCaption } from '../public/console-model.js';

test('sampling cutoff uses Beijing date even before midnight in the host timezone', () => {
  const text = periodEvidenceCaption({end: '2026-09-25T16:10:00Z', partialEndDay: true});
  assert.match(text, /2026\/09\/26 00:10/);
  assert.match(text, /结束日尚未结束/);
  assert.match(text, /不是实时数据/);
});
test('a completed calendar date does not claim completed data coverage', () => {
  const text = periodEvidenceCaption({end: '2026-09-24T15:59:59.999Z', partialEndDay: false});
  assert.match(text, /2026\/09\/24 23:59/);
  assert.match(text, /所选日期已结束，缺采不代表已补齐/);
});
test('missing or invalid time evidence remains explicit rather than becoming now or zero', () => {
  for (const range of [undefined, {}, {end:'invalid'}]) assert.match(periodEvidenceCaption(range), /待确认/);
  assert.match(periodEvidenceCaption({end:'2026-09-26T03:00:00Z'}), /日期完成状态待确认/);
});
test('known metric counts and endpoint-day observations are visibly independent', () => {
  const text = metricObservationCaption('followers', {value:381757081,observedCount:700}, 701, {followersObservedCount:696});
  assert.match(text, /期末已知合计 3.82亿 · 700\/701/);
  assert.match(text, /期末当日新采 696\/701/);
  assert.doesNotMatch(text, /期末观测/);
});
test('zero and missing metric evidence remain different and each metric uses its own coverage', () => {
  const point = {followersObservedCount:2,likesObservedCount:0,postsObservedCount:1};
  assert.match(metricObservationCaption('likes', {value:0,observedCount:1}, 2, point), /合计 0 · 1\/2 账号；期末当日新采 0\/2/);
  assert.match(metricObservationCaption('posts', {value:null,observedCount:0}, 2, point), /合计 — · 0\/2 账号；期末当日新采 1\/2/);
  assert.match(metricObservationCaption('followers', {value:null}, 2, undefined), /新采覆盖待核验/);
});
test('estimated play caption never presents converted cumulative likes as real playback', () => {
  const text=metricObservationCaption('estimatedPlays',{value:498371281600,observedCount:700},701,{});
  assert.equal(text,'点赞净变化 × 100 · 不是实际播放量');
  assert.doesNotMatch(text,/498371281600/);
});

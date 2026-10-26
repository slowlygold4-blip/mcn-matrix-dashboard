import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { failureKind, resourceKind, projectDocumentStructure } from '../scripts/probes/douyin-native-environment-probe.mjs';

test('native probe errors and resources emit only bounded categories, never transport text', () => {
  assert.equal(failureKind('net::ERR_NAME_NOT_RESOLVED https://example.invalid/?secret=PRIVATE'), 'ERR_NAME_NOT_RESOLVED');
  assert.equal(failureKind('private arbitrary reason'), 'unclassified');
  assert.equal(failureKind(undefined), 'unclassified');
  assert.equal(resourceKind({resourceType: () => 'script'}), 'script');
  assert.equal(resourceKind({resourceType: () => 'PRIVATE'}), 'other');
});
test('native structural projection has no body, IDs, script contents or credential fields', () => {
  const result = vm.runInNewContext(`(${projectDocumentStructure.toString()})()`, {
    document: { readyState: 'loading', body: null, scripts: {length: 10}, querySelector: () => null, querySelectorAll: () => [] },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    readyState:'loading', bodyPresent:false, scriptCount:10, renderDataPresent:false, worksRegionPresent:false, gate:'none',
  });
});
test('native probe treats a visible challenge as a gate without reading or handling it', () => {
  const node={getClientRects: () => [1]};
  const result = vm.runInNewContext(`(${projectDocumentStructure.toString()})()`, {
    document: {readyState:'complete',body:{},scripts:[],querySelector: () => null,querySelectorAll: selector => selector.includes('captcha') ? [node] : []},
    getComputedStyle: () => ({visibility:'visible', display:'block'}),
  });
  assert.equal(result.gate,'challenge');
});

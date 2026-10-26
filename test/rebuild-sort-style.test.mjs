import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../public/rebuild.css',import.meta.url),'utf8');
const js=readFileSync(new URL('../public/rebuild.js',import.meta.url),'utf8');

test('sortable column buttons retain accessible semantics and receive the table styling',()=>{
  assert.match(js,/<button class="sort-button" data-sort=/);
  assert.match(js,/aria-sort=/);
  const rule=css.match(/\.table \.sort-button\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule,'style the actual button, not a removed th[data-sort] attribute');
  for(const declaration of ['appearance: none','border: 0','background: transparent','color: inherit','font: inherit','min-height: 44px'])assert.ok(rule.includes(declaration),declaration);
});

test('sorting provides pointer and visible keyboard focus feedback without motion',()=>{
  assert.match(css,/\.table \.sort-button:hover\s*\{[^}]*color: var\(--blue\)/);
  assert.match(css,/\.table \.sort-button:focus-visible\s*\{[^}]*outline: 2px solid var\(--blue\)/);
  assert.doesNotMatch(css,/\.table \.sort-button[^}]*transition:\s*all/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import postcss from 'postcss';

const css = postcss.parse(await readFile(new URL('../app/replica.css', import.meta.url), 'utf8'));
const mobile = css.nodes.find(node => node.type === 'atrule' && node.name === 'media'
  && node.params === '(max-width:760px)' && node.nodes.some(rule => rule.selector?.includes('.source-ledger,.tuantuan-roster-table')));
const rule = selector => mobile?.nodes.find(node => node.type === 'rule' && node.selector === selector);
const declarations = node => Object.fromEntries(node.nodes.map(item => [item.prop, item.value]));
const scope = ':is(.source-ledger,.tuantuan-roster-table) > .table-scroll-shell .source-table';

test('narrow-tablet source ledgers pin identity without affecting nested observation tables', () => {
 assert.ok(mobile, 'mobile ledger styles must have an explicit breakpoint');
 const cells = declarations(rule(`${scope} :is(th,td):first-child`));
 assert.equal(cells.position, 'sticky');
 assert.equal(cells.left, '0');
 assert.match(cells.background, /--mcn-surface/);
 assert.equal(cells['min-width'], cells.width);
 assert.equal(cells['max-width'], cells.width);
 assert.match(cells.width, /^clamp\(132px,38vw,160px\)$/);
 assert.ok(!scope.includes('.source-observations'));
 assert.ok(scope.includes('> .table-scroll-shell'), 'only a direct ledger table shell is pinned');

 const heading = declarations(rule(`${scope} th:first-child`));
 assert.equal(heading['z-index'], '2');
 assert.ok(heading.background && heading.background !== 'transparent');
 assert.equal(declarations(rule(`${scope} :is(th,td):first-child :is(button,a)`))['min-height'], '44px');

 for (const viewport of [681, 760]) {
  const pinned = Math.min(160, Math.max(132, viewport * .38));
  const remaining = viewport - 32 - 2 - pinned; // mobile content padding and panel border
  assert.ok(remaining >= 150, `${viewport}px must leave room to read a metric beside the fixed identity`);
 }
});

test('phone source ledger presents every field vertically while keeping real table headings', async () => {
 const cards = css.nodes.find(node => node.type === 'atrule' && node.name === 'media'
  && node.params === 'screen and (max-width:680px)' && node.nodes.some(item => item.selector?.includes('.source-ledger > .table-scroll-shell .source-table tbody')));
 assert.ok(cards, 'the phone layout must have a dedicated breakpoint');
 const find = selector => cards.nodes.find(node => node.type === 'rule' && node.selector === selector);
 assert.equal(declarations(find('.source-ledger > .table-scroll-shell .source-table'))['min-width'], '0');
 assert.equal(declarations(find('.source-ledger > .table-scroll-shell .source-table tbody tr')).display, 'block');
 assert.equal(declarations(find('.source-ledger > .table-scroll-shell .source-table tbody td')).display, 'block');
 assert.match(declarations(find('.source-ledger > .table-scroll-shell .source-table thead'))['clip-path'], /inset/);
 for (const view of ['authors', 'works']) for (let i = 1; i <= 5; i++) {
  const label = find(`.source-ledger[data-source-view="${view}"] > .table-scroll-shell .source-table tbody td:nth-child(${i})::before`);
  assert.ok(label, `${view} column ${i} needs its own visible phone label`);
 }
 const component = await readFile(new URL('../components/creator-source-panel.tsx', import.meta.url), 'utf8');
 assert.match(component, /data-source-view=\{view\}/);
 assert.match(component, /<table className="source-table"><thead>/, 'keep native table/thead semantics');
});

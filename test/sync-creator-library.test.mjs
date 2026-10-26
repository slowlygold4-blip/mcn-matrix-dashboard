import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestCoversSourceRevision, planCreatorLibrarySync } from '../scripts/sync-creator-library.mjs';

const remote = { revision: 1697, modified_time: '2026-10-22T13:09:53.000Z' };
const latest = { source_revision: '1697', source_modified_at: '2026-10-22T13:09:53.000Z' };

test('unchanged cloud version is skipped without export or database writes', () => {
  assert.deepEqual(planCreatorLibrarySync(remote, latest), { action: 'unchanged', revision: 1697 });
});

test('newer revision or modified timestamp triggers full export and audited classification', () => {
  assert.deepEqual(planCreatorLibrarySync({ ...remote, revision: 1698 }, latest),
    { action: 'export-and-audit', revision: 1698 });
  assert.deepEqual(planCreatorLibrarySync({ ...remote, modified_time: '2026-10-22T14:09:53.000Z' }, latest),
    { action: 'export-and-audit', revision: 1697 });
});

test('invalid or older cloud revisions never replace saved source data', () => {
  for (const invalid of [{ revision: null, modified_time: remote.modified_time },
    { revision: 1697, modified_time: 'invalid' }, { revision: 1696, modified_time: remote.modified_time }]) {
    assert.throws(() => planCreatorLibrarySync(invalid, latest));
  }
});

test('a changed export with identical audited cells is not re-exported each hour', () => {
  const checked = { status: 'unchanged-content', revision: 1698, modifiedTime: remote.modified_time, importId: 9 };
  assert.equal(manifestCoversSourceRevision(checked, { ...remote, revision: 1698 }, { id: 9 }), true);
  assert.equal(manifestCoversSourceRevision(checked, { ...remote, revision: 1699 }, { id: 9 }), false);
  assert.equal(manifestCoversSourceRevision(checked, { ...remote, revision: 1698 }, { id: 10 }), false);
});

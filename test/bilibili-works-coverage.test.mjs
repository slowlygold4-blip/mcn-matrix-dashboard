import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';

const target = { id: 2, type: 'account', label: '测试账号', locator: '1809444890', metadata: { platform: 'bilibili' } };
const work = { aweme_id: 'BV1fi416bEpi', author: { uid: target.locator }, statistics: { digg_count: 12 } };
async function collect(total, works) {
  return new PublicWebProvider({}, { execFileImpl: (_file, _args, _options, callback) => callback(null, JSON.stringify({ ok: true, data: {
    profile: { user: { uid: target.locator, aweme_count: total, follower_count: 100, total_favorited: 500 } },
    ...(works === undefined ? {} : { works: { aweme_list: works } }), warnings: [],
    ...(Array.isArray(works) ? { worksListEvidence: { status: 'success', source: 'wbi', statusCode: 0, listObserved: true, rawCount: works.length } } : {}),
  } }), '') }).collect(target);
}
test('Bilibili latest windows remain limited without proof of complete pagination', async () => {
  for (const total of [2316, 1, null]) {
    const result = await collect(total, [work]);
    assert.equal(result.worksCoverage, 'limited');
    assert.equal(result.snapshot.totalPosts, total);
    assert.equal(result.snapshot.totalLikes, 500);
    assert.equal(result.posts[0].likes, 12);
    assert.match(result.warnings.join(' '), /未证明全部作品完整覆盖/);
  }
});
test('Bilibili empty or absent lists cannot erase a positive or unknown inventory', async () => {
  for (const total of [22, null]) for (const works of [[], undefined]) {
    const result = await collect(total, works);
    assert.equal(result.worksCoverage, 'unavailable');
    assert.equal(result.snapshot.totalPosts, total);
    assert.equal(result.snapshot.followers, 100);
  }
});
test('Bilibili explicitly zero inventory and explicit empty list are complete', async () => {
  const result = await collect(0, []);
  assert.equal(result.worksCoverage, 'complete');
  assert.equal(result.snapshot.totalPosts, 0);
  assert.equal(result.posts.length, 0);
});

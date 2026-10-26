import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeBrowserWorks } from '../scripts/douyin_browser_collector.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEC = 'MS4wLjABAAAACompactIdentityFixture12345678';
const UID = '1234567890123456789';
const START = '2026-10-09T15:00:00.000Z', END = '2026-10-09T15:00:01.000Z';
const author = fields => ({ sec_uid: SEC, uid: UID, nickname: '昵称不是抖音号', ...fields });
const work = fields => ({ aweme_id: '7690000000000000001', author: author(fields), desc: '原始作品', create_time: 1791558000, statistics: { digg_count: 8 } });
const payload = fields => ({ status_code: 0, has_more: false, max_cursor: 0, aweme_list: [work(fields)] });
const validCases = [
  { unique_id: 'Case_Example.123-ABC', short_id: '1234567890123456789' },
  { unique_id: '9007199254740993123456789', short_id: '0001234567890123456789012' },
  { unique_id: 'A'.repeat(100), short_id: '9'.repeat(25) },
  { unique_id: '0', short_id: '0' },
];
const invalidText = ['', ' ', ' abc', 'abc ', 'abc\n', 'abc\r', 'a\tb', 'a\0b', 'a\u007fb', 'a\u0085b', 'a\u200bb', '\u202eabc', '中文', 'Ｆｕｌｌ', 'a/b', 'a@b', 'a%2fb', 'https://example.com'];
const invalidValues = [null, true, false, 123456789, Number.MAX_SAFE_INTEGER + 1, {}, [], ['123'], { toString: '123' }, ...invalidText];
const invalidCases = [
  ...invalidValues.map(value => ({ field: 'unique_id', fields: { unique_id: value, short_id: '123456789' } })),
  ...invalidValues.map(value => ({ field: 'short_id', fields: { unique_id: 'Valid_Name', short_id: value } })),
  { field: 'unique_id', fields: { unique_id: 'x'.repeat(101) } },
  ...['9'.repeat(26), '123abc', '1.1', '-123', '+123', '1e9'].map(value => ({ field: 'short_id', fields: { short_id: value } })),
];

function pythonPosts(fields) {
  const code = `import sys, json, importlib.util\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location("collector", "scripts/douyin_public_collector.py")\nmodule=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\ndef network_forbidden(*args, **kwargs):\n    raise AssertionError("network or child process forbidden in compact-author tests")\nmodule.urllib.request.urlopen=network_forbidden\nmodule.subprocess.run=network_forbidden\nitems=json.load(sys.stdin)\noriginal=json.dumps(items,ensure_ascii=False)\nresult=[module.public_post(item) for item in items]\nassert json.dumps(items,ensure_ascii=False)==original\nprint(json.dumps(result,ensure_ascii=False))\n`;
  const result = spawnSync('/usr/bin/python3', ['-c', code], { cwd: ROOT, input: JSON.stringify(fields.map(work)), encoding: 'utf8', timeout: 10_000, maxBuffer: 2_000_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

async function providerPost(fields, { directRawAuthor = false } = {}) {
  let now = Date.parse(START);
  const value = payload(fields), before = structuredClone(value);
  const normalized = normalizeBrowserWorks(value, SEC, 30);
  const pager = new BrowserWorksPagination({ limit: 30 });
  pager.accept({ requestCursor: 0, body: value, normalized, observedAt: END });
  const item = { key: '7', status: 'ok', ...pager.result(1), errorCode: null };
  if (directRawAuthor) item.posts[0].author = author(fields);
  const originalItem = structuredClone(item);
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { accountBrowserFallback: true,
    now: () => now, worksRequestPolicyOptions: { now: () => now },
    fetchImpl: () => { throw new Error('network prohibited'); }, execFileImpl: () => { throw new Error('process prohibited'); } });
  provider.collectAccount = provider.run = async () => { throw new Error('profile collection prohibited'); };
  provider.runBrowserWorks = async () => { now = Date.parse(END); return { items: [item] }; };
  const result = await provider.collectWorksOnly({ id: 7, enabled: true, type: 'account', provider: 'public-web', locator: SEC, metadata: {} },
    { snapshotId: 11, sourceChecksum: 'a'.repeat(64), capturedAt: '2026-10-09T14:59:00.000Z', secUid: SEC, uid: UID });
  assert.equal(result.result.status, 'ok'); assert.equal(result.result.worksCoverage, 'limited');
  assert.deepEqual(value, before); assert.deepEqual(item, originalItem);
  return result.result.posts[0];
}

test('Python public post projection preserves exact original text and never mutates source fields', () => {
  const posts = pythonPosts([...validCases, ...invalidCases.map(value => value.fields), {}]);
  validCases.forEach((fields, index) => {
    assert.deepEqual(posts[index].author, author(fields));
    assert.equal(typeof posts[index].author.short_id, 'string');
  });
  invalidCases.forEach(({ field }, index) => assert.equal(Object.hasOwn(posts[validCases.length + index].author, field), false, `${field} ${JSON.stringify(invalidCases[index].fields[field])}`));
  assert.deepEqual(posts.at(-1).author, author({}), 'uid and nickname never become invented handles');
});

test('browser post projection retains exact IDs and drops malformed values without dropping the work', () => {
  for (const fields of validCases) {
    const value = payload(fields), before = structuredClone(value);
    const result = normalizeBrowserWorks(value, SEC, 30);
    assert.equal(result.posts.length, 1); assert.deepEqual(result.posts[0].author, author(fields));
    assert.deepEqual(value, before);
  }
  for (const { fields, field } of invalidCases) {
    const result = normalizeBrowserWorks(payload(fields), SEC, 30);
    assert.equal(result.posts.length, 1); assert.equal(Object.hasOwn(result.posts[0].author, field), false, `${field} ${JSON.stringify(fields[field])}`);
    assert.equal(result.posts[0].author.uid, UID); assert.equal(result.posts[0].author.sec_uid, SEC);
  }
  const missing = normalizeBrowserWorks(payload({}), SEC, 30).posts[0].author;
  assert.equal(Object.hasOwn(missing, 'unique_id'), false); assert.equal(Object.hasOwn(missing, 'short_id'), false);
});

test('works-only provider independently validates optional text identities without coercion', async () => {
  for (const fields of validCases) {
    const post = await providerPost(fields, { directRawAuthor: true });
    assert.deepEqual(post.author, { sec_uid: SEC, uid: UID, ...fields });
  }
  for (const { fields, field } of invalidCases) {
    const post = await providerPost(fields, { directRawAuthor: true });
    assert.equal(Object.hasOwn(post.author, field), false, `${field} ${JSON.stringify(fields[field])}`);
    assert.equal(post.author.uid, UID); assert.equal(post.author.sec_uid, SEC);
  }
  assert.deepEqual((await providerPost({}, { directRawAuthor: true })).author, { sec_uid: SEC, uid: UID });
});

test('browser-to-provider chain preserves both handles without declaring identity binding or complete works', async () => {
  const post = await providerPost(validCases[0]);
  assert.deepEqual(post.author, { sec_uid: SEC, uid: UID, ...validCases[0] });
  assert.equal(post.statistics.digg_count, 8); assert.equal(post.statistics.play_count, undefined);
  assert.equal(post.verified, undefined); assert.equal(post.targetId, undefined);
});

test('optional handles never weaken canonical author filtering', () => {
  const value = payload(validCases[0]); value.aweme_list[0].author.sec_uid = `${SEC}Other`;
  assert.throws(() => normalizeBrowserWorks(value, SEC, 30), /未包含可确认属于该账号/);
});

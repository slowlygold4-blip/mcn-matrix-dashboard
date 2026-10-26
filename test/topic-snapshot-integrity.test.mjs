import test from 'node:test';
import assert from 'node:assert/strict';
import { checksum } from '../lib/utils.mjs';
import { validateTopicSnapshot } from '../lib/topic-snapshot-integrity.mjs';

const TARGET = { id: 7, type: 'hashtag', provider: 'public-web', locator: '#一条小团团OvO' };
const CAPTURED = '2026-09-28T10:00:00.000Z';
const ENDPOINT = 'https://www.douyin.com/aweme/v1/web/challenge/detail/';

function directEvidence({ participants = 0, views = 0, quality = 'validated' } = {}) {
  const raw = {
    scope: 'douyin-official-challenge-detail', businessStatusCode: 0,
    challengeId: '7684603502', label: '一条小团团OvO', officialName: '一条小团团OvO',
    participants, views, capturedAt: CAPTURED,
    provenance: { mode: 'douyin-official-anonymous-challenge-detail', endpoint: ENDPOINT,
      authenticated: false, runtimeAI: false, paidAPI: false },
  };
  const digest = checksum(raw);
  return {
    id: 11, target_id: TARGET.id, captured_at: CAPTURED,
    hashtag_participants: participants, hashtag_views: views, quality_status: quality,
    source_checksum: digest, raw_json: JSON.stringify(raw),
    audit_id: 12, audit_target_id: TARGET.id, audit_provider: 'public-web',
    audit_status: quality, audit_checksum: digest, audit_created_at: '2026-09-28T10:00:01.000Z',
    run_id: 13, run_target_id: null, run_status: 'success',
    started_at: '2026-09-28T09:59:00.000Z', finished_at: '2026-09-28T10:00:02.000Z',
  };
}

test('topic counters require a verified public Douyin source bound to target, audit, run, payload and time', () => {
  const result = validateTopicSnapshot(directEvidence(), TARGET, { asOf: Date.parse('2026-09-29T00:00:00Z') });
  assert.deepEqual(result, { valid: true, reason: null, participants: 0, views: 0, timeBinding: 'payload-observation-time' }, 'real zero stays distinguishable from missing');
});

test('topic evidence fails closed for manual provider, audit mismatch, nonplatform payload and metric mutation', () => {
  const asOf = Date.parse('2026-09-29T00:00:00Z');
  const variants = [
    [directEvidence(), { ...TARGET, provider: 'manual' }, 'provider'],
    [{ ...directEvidence(), audit_provider: 'manual' }, TARGET, 'target-audit-binding'],
    [{ ...directEvidence(), audit_target_id: 99 }, TARGET, 'target-audit-binding'],
    [{ ...directEvidence(), audit_checksum: 'f'.repeat(64) }, TARGET, 'checksum-binding'],
    [{ ...directEvidence(), audit_status: 'rejected' }, TARGET, 'quality'],
    [{ ...directEvidence(), run_target_id: 99 }, TARGET, 'run-binding'],
    [{ ...directEvidence(), run_status: 'running' }, TARGET, 'run-state'],
    [{ ...directEvidence(), run_status: 'failed' }, TARGET, 'run-state'],
    [{ ...directEvidence(), finished_at: '2026-09-28T09:59:30.000Z' }, TARGET, 'time'],
  ];
  const badRaw = directEvidence();
  const raw = JSON.parse(badRaw.raw_json); raw.businessStatusCode = 403;
  badRaw.raw_json = JSON.stringify(raw);
  variants.push([badRaw, TARGET, 'source-payload']);
  const changedCounter = directEvidence(); changedCounter.hashtag_views += 1;
  variants.push([changedCounter, TARGET, 'source-payload']);
  const wrongTopic = directEvidence();
  const wrong = JSON.parse(wrongTopic.raw_json); wrong.officialName = '其他话题';
  wrongTopic.raw_json = JSON.stringify(wrong); wrongTopic.source_checksum = checksum(wrong);
  wrongTopic.audit_checksum = wrongTopic.source_checksum;
  variants.push([wrongTopic, TARGET, 'source-identity']);

  for (const [row, target, reason] of variants) {
    assert.deepEqual(validateTopicSnapshot(row, target, { asOf }),
      { valid: false, reason, participants: null, views: null }, reason);
  }
});

test('topic partial metric remains independently observable only with a warning and matching raw vector', () => {
  const row = directEvidence({ participants: 31, views: null, quality: 'warning' });
  const result = validateTopicSnapshot(row, TARGET, { asOf: Date.parse('2026-09-29T00:00:00Z') });
  assert.deepEqual(result, { valid: true, reason: null, participants: 31, views: null, timeBinding: 'payload-observation-time' });
  row.quality_status = 'validated'; row.audit_status = 'validated';
  assert.equal(validateTopicSnapshot(row, TARGET).valid, false, 'missing official counterpart cannot be mislabeled fully validated');
});

test('authenticated browser evidence is checked against its dedicated source checksum contract', () => {
  const row = directEvidence({ participants: 8, views: 90 });
  const raw = {
    challengeId: '7684603502', officialName: '一条小团团OvO', searchKeyword: '#一条小团团OvO',
    hashtag: '一条小团团OvO', capturedAt: CAPTURED,
    provenance: { mode: 'douyin-authenticated-browser-search-and-detail', authenticated: true, paidAPI: false, runtimeAI: false },
  };
  row.raw_json = JSON.stringify(raw);
  row.source_checksum = checksum({ tag: raw.hashtag,
    snapshot: { followers: null, totalLikes: null, totalPosts: null, hashtagParticipants: 8,
      hashtagViews: 90, hashtagPosts: null, authorCount: null },
    raw: { challengeId: raw.challengeId, officialName: raw.officialName, searchKeyword: raw.searchKeyword },
  });
  row.audit_checksum = row.source_checksum;
  assert.equal(validateTopicSnapshot(row, TARGET).valid, true);
  delete raw.capturedAt;
  row.raw_json = JSON.stringify(raw);
  assert.equal(validateTopicSnapshot(row, TARGET).reason, 'time-binding',
    'authenticated observations cannot borrow an audit without their exact sample instant');
  raw.capturedAt = CAPTURED;
  row.raw_json = JSON.stringify(raw);
  row.hashtag_views = 91;
  assert.equal(validateTopicSnapshot(row, TARGET).valid, false);
});

// Read-only, offline investigation. Output is candidate evidence, never an
// instruction to bind a target or to call a platform endpoint.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readImportMonitoringStatus } from '../lib/import-monitoring-status.mjs';
import { verifyStoredDouyinProfileIdentity } from '../lib/profile-identity-proof.mjs';
import { readStoredDouyinAliasMatches } from '../lib/roster-alias-history.mjs';

const jobId = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f';
const id = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
const video = value => typeof value === 'string' && /^\d{15,25}$/.test(value) ? value : null;
const sha = value => createHash('sha256').update(value).digest('hex');
const rawSheets = JSON.parse(readFileSync('data/maintenance-journal/20261009-upload/parsed-rows.json', 'utf8'));
const originalRows = new Map(rawSheets[0].rows.map(row => [row.sourceRow, row]));
function urls(value) {
  return (String(value ?? '').match(/https?:\/\/[^\s<>"“”]+/g) ?? []).flatMap(text => {
    try { return [new URL(text.replace(/[，。；！）]+$/u, ''))]; } catch { return []; }
  });
}
function shareKey(url) {
  if (url.protocol !== 'https:' || url.hostname !== 'v.douyin.com' || !/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/`;
}
function officialVideo(url) {
  if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname)) return null;
  return video(url.pathname.match(/^\/(?:share\/)?video\/(\d{15,25})(?:\/|$)/)?.[1]);
}
const db = new DatabaseSync('data/douyin-monitor.sqlite', { readOnly: true });
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
try {
  const started = performance.now(), now = new Date();
  const storedJob = db.prepare('SELECT id,status,request_json FROM author_resolution_jobs WHERE id=?').get(jobId);
  const job = { id: storedJob.id, status: storedJob.status, request: JSON.parse(storedJob.request_json) };
  const first = readImportMonitoringStatus(db, job, { now, status: 'pending', limit: 100 });
  const pending = [...first.items];
  for (let offset = 100; offset < first.pagination.total; offset += 100) {
    pending.push(...readImportMonitoringStatus(db, job, { now, status: 'pending', limit: 100, offset }).items);
  }
  const pendingIds = new Set(pending.map(row => id(row.submittedId)));
  const rows = job.request.rows.filter(row => pendingIds.has(id(row.douyinId)));
  const sourceVideos = new Map(), sourceShares = new Map(), recoveredOfficialPaths = [], noEvidence = [];
  const add = (map, key, record) => { if (!map.has(key)) map.set(key, []); map.get(key).push(record); };
  for (const row of rows) {
    const submittedId = id(row.douyinId), original = originalRows.get(row.sourceRow) ?? {};
    const links = [...urls(row.shareUrl), ...urls(original.videoLink), ...urls(original.videoHyperlink)];
    const directIds = new Set([video(row.videoId), video(row.contentId), ...links.map(officialVideo)].filter(Boolean));
    const shares = [...new Set(links.map(shareKey).filter(Boolean))];
    for (const externalId of directIds) add(sourceVideos, externalId, { submittedId, sourceRow: row.sourceRow, basis: video(row.videoId) === externalId ? 'submitted-video-id' : 'official-video-url-path' });
    for (const shareUrl of shares) add(sourceShares, shareUrl, { submittedId, sourceRow: row.sourceRow });
    if (!row.videoId && directIds.size) recoveredOfficialPaths.push({ submittedId, sourceRow: row.sourceRow, videoIds: [...directIds], originalHost: links.find(url => officialVideo(url))?.hostname });
    if (!directIds.size && !shares.length) {
      const rawText = `${original.videoLink ?? ''} ${original.videoHyperlink ?? ''}`.trim();
      const category = /https?:\/\/v\.douyin\.com\/?(?:\s|$)/.test(rawText) ? 'bare-douyin-host-without-token'
        : links.some(url => !['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'].includes(url.hostname)) ? 'different-platform-link'
          : !rawText ? 'blank' : 'text-without-usable-work-link';
      noEvidence.push({ submittedId, sourceRow: row.sourceRow, category });
    }
  }
  const directHits = db.prepare(`SELECT id,target_id,external_id,author_id,first_seen_at,last_seen_at,raw_json
    FROM posts WHERE external_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...sourceVideos.keys()]));
  const postShares = db.prepare(`SELECT id,target_id,external_id,author_id,url,
    json_extract(raw_json,'$.url') raw_url,json_extract(raw_json,'$.share_url') share_url
    FROM posts WHERE json_valid(raw_json) AND (url LIKE '%v.douyin.com%' OR raw_json LIKE '%v.douyin.com%')`).all();
  const shareHits = [];
  for (const post of postShares) for (const key of new Set([post.url, post.raw_url, post.share_url].flatMap(urls).map(shareKey).filter(Boolean))) {
    if (sourceShares.has(key)) shareHits.push({ postId: post.id, targetId: post.target_id, externalId: post.external_id, shareUrl: key, sources: sourceShares.get(key) });
  }
  // Co-listing is deliberately NOT called a decoded-link receipt. Search only
  // exact requested links and the same explicit submitted identity.
  const coListed = [], queueRows = db.prepare('SELECT id,douyin_id,video_ids_json,share_urls_json FROM author_resolution_queue WHERE json_array_length(video_ids_json)>0 AND json_array_length(share_urls_json)>0').all();
  for (const row of queueRows) {
    if (!pendingIds.has(id(row.douyin_id))) continue;
    const videos = JSON.parse(row.video_ids_json).filter(video);
    const shares = JSON.parse(row.share_urls_json).flatMap(urls).map(shareKey).filter(key => key && sourceShares.get(key)?.some(source => source.submittedId === id(row.douyin_id)));
    if (videos.length && shares.length) coListed.push({ queueId: row.id, submittedId: id(row.douyin_id), videoIds: videos, exactSubmittedShareCount: new Set(shares).size, verifiedExpansion: false });
  }
  const coListedVideoIds = [...new Set(coListed.flatMap(row => row.videoIds))];
  const coListedHits = db.prepare('SELECT id,target_id,external_id,author_id,raw_json FROM posts WHERE external_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(coListedVideoIds));
  const candidates = [];
  for (const post of directHits) {
    const raw = JSON.parse(post.raw_json), author = raw.author ?? {}, target = db.prepare('SELECT * FROM targets WHERE id=?').get(post.target_id);
    const snapshot = db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY julianday(captured_at) DESC,id DESC LIMIT 1').get(post.target_id);
    const audit = snapshot && db.prepare("SELECT * FROM audits WHERE target_id=? AND source_checksum=? AND provider='public-web' ORDER BY created_at DESC,id DESC LIMIT 1").get(post.target_id, snapshot.source_checksum);
    const run = audit && db.prepare('SELECT * FROM runs WHERE id=?').get(audit.run_id);
    for (const source of sourceVideos.get(post.external_id)) {
      const exactWorkAndCanonical = raw.aweme_id === post.external_id && author.sec_uid === target.locator
        && post.author_id === target.locator && typeof author.uid === 'string' && /^[1-9]\d{1,24}$/.test(author.uid);
      const profile = verifyStoredDouyinProfileIdentity({ target, snapshot, audit, run, submittedAccountId: source.submittedId, reference: now });
      const alias = readStoredDouyinAliasMatches(db, [source.submittedId], { reference: now }).matches.find(match => match.targetId === target.id && match.uid === author.uid);
      candidates.push({ ...source, postId: post.id, targetId: target.id, externalId: post.external_id, uid: author.uid, secUid: author.sec_uid,
        exactWorkAndCanonical, profileProof: profile && profile.uid === author.uid ? profile : null, historicalAliasProof: alias ?? null,
        localPostRawSha256: sha(post.raw_json), storedPostSourceChecksumAvailable: false,
        requiresOriginalChecksumBoundWorkEnvelope: true, autoBindingAuthorized: false });
    }
  }
  const historicalJobs = db.prepare('SELECT count(*) jobs FROM author_resolution_jobs WHERE result_json IS NOT NULL').get().jobs;
  const storedDecodedShareReceipts = db.prepare(`SELECT count(*) n FROM author_resolution_jobs j,json_tree(j.result_json) x
    WHERE json_valid(j.result_json) AND x.key='sourceEvidenceUrl'`).get().n;
  const perIdentity = [...pendingIds].map(submittedId => {
    const ownRows = rows.filter(row => id(row.douyinId) === submittedId);
    return { submittedId, rows: ownRows.length, directVideoIds: [...sourceVideos].filter(([, sources]) => sources.some(source => source.submittedId === submittedId)).map(([value]) => value),
      shareCount: [...sourceShares].filter(([, sources]) => sources.some(source => source.submittedId === submittedId)).length };
  });
  const categories = {};
  for (const row of noEvidence) categories[row.category] = (categories[row.category] ?? 0) + 1;
  console.log(JSON.stringify({ checkedAt: now.toISOString(), jobId, mode: 'offline readonly work-id and exact-share intersection, no platform request or application write',
    currentImportCounts: first.counts, inputPendingRows: rows.length, uniquePendingIdentities: pendingIds.size,
    syntacticallyInvalidSubmittedIds: [...pendingIds].filter(value => !/^[a-z0-9_.-]{1,100}$/.test(value) || value === '0'),
    explicitVideoRows: rows.filter(row => video(row.videoId)).length, explicitUniqueVideoIds: new Set(rows.map(row => video(row.videoId)).filter(Boolean)).size,
    allExactVideoIdsIncludingOriginalOfficialPaths: sourceVideos.size, uniqueShortShareUrls: sourceShares.size,
    recoveredOfficialPaths, directMatchedPostCount: directHits.length, storedPostShareUrlMatchedCount: shareHits.length, shareHits,
    coListedEvidenceNotVerifiedExpansion: { queueRows: coListed.length, distinctVideoIds: coListedVideoIds.length, matchedPosts: coListedHits.map(row => ({ postId: row.id, targetId: row.target_id, externalId: row.external_id })), records: coListed },
    historicalJobsCheckedForDecodedLinkReceipts: historicalJobs, persistedSourceEvidenceUrlFields: storedDecodedShareReceipts,
    candidates, validProfileOrAliasCandidateCount: candidates.filter(row => row.exactWorkAndCanonical && (row.profileProof || row.historicalAliasProof)).length,
    noUsableWorkEvidenceRows: noEvidence.length, noEvidenceCategories: categories, noEvidence,
    identitiesWithNoUsableWorkEvidence: perIdentity.filter(row => !row.directVideoIds.length && !row.shareCount),
    durationMs: Math.round(performance.now() - started), productionChanges: db.prepare('SELECT total_changes() n').get().n }, null, 2));
} finally { db.exec('ROLLBACK'); db.close(); }

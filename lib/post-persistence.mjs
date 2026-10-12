function serializedRawPost(value) {
  if (value === null || value === undefined) return '{}';
  if (typeof value === 'string' && !value.trim()) return '{}';
  if (Array.isArray(value) && value.length === 0) return '{}';
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return '{}';
  return JSON.stringify(value) ?? '{}';
}

// The caller owns the transaction. Run this guard before any target/ledger
// mutation so both full collections and works-only writes fail as one batch.
export function assertPostHistoryIdentity(db, target, posts, expectedAuthorId = null) {
  const getPost = db.prepare('SELECT author_id FROM posts WHERE target_id=? AND external_id=?');
  let conflict = target.type === 'account' && expectedAuthorId && db.prepare(`
    SELECT 1 FROM posts WHERE target_id=? AND author_id IS NOT NULL AND author_id<>'' AND author_id<>? LIMIT 1
  `).get(target.id, String(expectedAuthorId));
  for (const post of posts) {
    const previous = getPost.get(target.id, post.externalId);
    if (previous?.author_id && post.authorId && String(previous.author_id) !== String(post.authorId)) conflict = true;
  }
  if (conflict) throw Object.assign(new Error('作品存量作者身份冲突；已保留原作品与指标历史，本次采集未写入，需审查原始来源'), {
    code: 'COLLECTION_HISTORY_AUTHOR_CONFLICT',
  });
}

export function persistPosts(db, { target, posts, expectedAuthorId = null, capturedAt, postTimes = null }) {
  const upsertPost = db.prepare(`
    INSERT INTO posts(target_id,external_id,author_id,author_name,caption,published_at,likes,comments,shares,collects,plays,url,first_seen_at,last_seen_at,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(target_id,external_id) DO UPDATE SET
      author_id=COALESCE(NULLIF(excluded.author_id,''),posts.author_id),
      author_name=COALESCE(NULLIF(excluded.author_name,''),posts.author_name),
      caption=CASE WHEN TRIM(excluded.caption)<>'' THEN excluded.caption ELSE posts.caption END,
      published_at=COALESCE(excluded.published_at,posts.published_at), likes=COALESCE(excluded.likes,posts.likes),
      comments=COALESCE(excluded.comments,posts.comments), shares=COALESCE(excluded.shares,posts.shares),
      collects=COALESCE(excluded.collects,posts.collects), plays=COALESCE(excluded.plays,posts.plays),
      url=COALESCE(excluded.url,posts.url), last_seen_at=excluded.last_seen_at,
      raw_json=CASE WHEN excluded.raw_json IN ('{}','[]','null','""','') THEN posts.raw_json ELSE excluded.raw_json END
    WHERE julianday(excluded.last_seen_at)>=julianday(posts.last_seen_at)
  `);
  const getPost = db.prepare('SELECT id FROM posts WHERE target_id=? AND external_id=?');
  const fields = ['likes', 'comments', 'shares', 'collects', 'plays'];
  const getMetric = db.prepare('SELECT likes,comments,shares,collects,plays FROM post_metrics WHERE post_id=? AND captured_at=?');
  const insertMetric = db.prepare(`INSERT INTO post_metrics(post_id,captured_at,likes,comments,shares,collects,plays)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(post_id,captured_at) DO NOTHING`);
  for (const post of posts) {
    // Preserve the legacy full-collection rule; works-only validation rejects
    // any such mismatch before reaching this common storage primitive.
    if (target.type === 'account' && expectedAuthorId && post.authorId && String(post.authorId) !== String(expectedAuthorId)) continue;
    const at = postTimes?.get(post.externalId) ?? capturedAt;
    upsertPost.run(target.id, post.externalId, post.authorId ?? null, post.authorName ?? null, post.caption ?? '', post.publishedAt ?? null,
      post.likes ?? null, post.comments ?? null, post.shares ?? null, post.collects ?? null, post.plays ?? null, post.url ?? null,
      at, at, serializedRawPost(post.raw));
    const stored = getPost.get(target.id, post.externalId);
    const previous = getMetric.get(stored.id, at);
    if (previous && fields.some(field => previous[field] !== (post[field] ?? null))) {
      throw Object.assign(new Error('同一作品同一观察时刻的指标与已存历史冲突；原记录已保留，本次采集未写入'), {
        code: 'COLLECTION_HISTORY_METRIC_CONFLICT',
      });
    }
    insertMetric.run(stored.id, at, post.likes ?? null, post.comments ?? null, post.shares ?? null, post.collects ?? null, post.plays ?? null);
  }
}

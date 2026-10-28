/** Indexed, per-account period endpoints. Read-only; nulls and tie-breakers
 * retain the legacy report contract without materializing seven history CTEs.
 */
export function readAccountSnapshotComparisons(db, { bounds, boardScope }) {
  const fields = [
    ['current', null, false, false],
    ['followers', 'followers', false, false],
    ['follower_baseline', 'followers', true, false],
    ['first_follower', 'followers', false, true],
    ['likes', 'total_likes', false, false],
    ['likes_baseline', 'total_likes', true, false],
    ['first_like', 'total_likes', false, true],
  ];
  const parameters = [];
  const joins = fields.map(([alias, metric, before, first], index) => {
    if (before) parameters.push(bounds.start);
    else parameters.push(bounds.start, bounds.end);
    const time = before ? 's.captured_at<?' : 's.captured_at>=? AND s.captured_at<=?';
    const direction = first ? 'ASC' : 'DESC';
    return `${index === 0 ? 'JOIN' : 'LEFT JOIN'} snapshots ${alias} ON ${alias}.id=(
      SELECT s.id FROM snapshots s WHERE s.target_id=t.id
        AND s.quality_status!='rejected' ${metric ? `AND s.${metric} IS NOT NULL` : ''}
        AND ${time} ORDER BY s.captured_at ${direction},s.id ${direction} LIMIT 1
    )`;
  }).join('\n');
  return db.prepare(`
      SELECT
        current.target_id,
        current.captured_at AS current_captured_at,
        current.quality_status AS current_quality_status,
        current.account_status AS current_account_status,
        current.works_coverage AS current_works_coverage,
        current.account_error AS current_account_error,
        current.works_error AS current_works_error,
        current.warnings_json AS current_warnings_json,
        followers.captured_at AS followers_current_captured_at,
        COALESCE(follower_baseline.captured_at, CASE WHEN first_follower.captured_at<followers.captured_at THEN first_follower.captured_at END) AS followers_baseline_captured_at,
        followers.source_checksum AS followers_current_checksum,
        COALESCE(follower_baseline.source_checksum, CASE WHEN first_follower.captured_at<followers.captured_at THEN first_follower.source_checksum END) AS followers_baseline_checksum,
        followers.followers AS current_followers,
        COALESCE(follower_baseline.followers, CASE WHEN first_follower.captured_at<followers.captured_at THEN first_follower.followers END) AS baseline_followers,
        CASE WHEN follower_baseline.target_id IS NOT NULL THEN 'period-start' WHEN first_follower.captured_at<followers.captured_at THEN 'first-in-period' END AS followers_baseline_mode,
        likes.captured_at AS likes_current_captured_at,
        COALESCE(likes_baseline.captured_at, CASE WHEN first_like.captured_at<likes.captured_at THEN first_like.captured_at END) AS likes_baseline_captured_at,
        likes.source_checksum AS likes_current_checksum,
        COALESCE(likes_baseline.source_checksum, CASE WHEN first_like.captured_at<likes.captured_at THEN first_like.source_checksum END) AS likes_baseline_checksum,
        likes.total_likes AS current_total_likes,
        COALESCE(likes_baseline.total_likes, CASE WHEN first_like.captured_at<likes.captured_at THEN first_like.total_likes END) AS baseline_total_likes,
        CASE WHEN likes_baseline.target_id IS NOT NULL THEN 'period-start' WHEN first_like.captured_at<likes.captured_at THEN 'first-in-period' END AS likes_baseline_mode
      FROM targets t
      ${joins}
      WHERE t.type='account' AND ${boardScope.clause}
      ORDER BY current.target_id
  `).all(...parameters, ...boardScope.params);
}

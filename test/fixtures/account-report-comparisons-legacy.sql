WITH scoped_targets AS (
        SELECT t.id,t.type FROM targets t
        WHERE 1=1
          AND 1=1
      ), current_any AS (
        SELECT s.target_id, s.captured_at, s.quality_status, s.account_status AS current_account_status,
          s.works_coverage AS current_works_coverage, s.account_error AS current_account_error,
          s.works_error AS current_works_error, s.warnings_json,
          ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY s.captured_at DESC, s.id DESC) AS rank
        FROM snapshots s JOIN scoped_targets t ON t.id=s.target_id
        WHERE t.type='account' AND s.quality_status!='rejected'
          AND s.captured_at>=? AND s.captured_at<=?
      ), current_followers AS (
        SELECT s.target_id, s.captured_at, s.followers, s.source_checksum,
          ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY s.captured_at DESC, s.id DESC) AS rank
        FROM snapshots s JOIN scoped_targets t ON t.id=s.target_id
        WHERE t.type='account' AND s.quality_status!='rejected'
          AND s.followers IS NOT NULL AND s.captured_at>=? AND s.captured_at<=?
      ), baseline_followers AS (
        SELECT s.target_id, s.captured_at, s.followers, s.source_checksum,
          ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY s.captured_at DESC, s.id DESC) AS rank
        FROM snapshots s JOIN scoped_targets t ON t.id=s.target_id
        WHERE t.type='account' AND s.quality_status!='rejected'
          AND s.followers IS NOT NULL AND s.captured_at<?
      ), first_followers_in_period AS (
        SELECT s.target_id, s.captured_at, s.followers, s.source_checksum,
          ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY s.captured_at ASC, s.id ASC) AS rank
        FROM snapshots s JOIN scoped_targets t ON t.id=s.target_id
        WHERE t.type='account' AND s.quality_status!='rejected'
          AND s.followers IS NOT NULL AND s.captured_at>=? AND s.captured_at<=?
      ), current_likes AS (
        SELECT s.target_id, s.captured_at, s.total_likes, s.source_checksum,
          ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY s.captured_at DESC, s.id DESC) AS rank
        FROM snapshots s JOIN scoped_targets t ON t.id=s.target_id
        WHERE t.type='account' AND s.quality_status!='rejected'
          AND s.total_likes IS NOT NULL AND s.captured_at>=? AND s.captured_at<=?
      ), baseline_likes AS (
        SELECT s.target_id, s.captured_at, s.total_likes, s.source_checksum,
          ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY s.captured_at DESC, s.id DESC) AS rank
        FROM snapshots s JOIN scoped_targets t ON t.id=s.target_id
        WHERE t.type='account' AND s.quality_status!='rejected'
          AND s.total_likes IS NOT NULL AND s.captured_at<?
      ), first_likes_in_period AS (
        SELECT s.target_id, s.captured_at, s.total_likes, s.source_checksum,
          ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY s.captured_at ASC, s.id ASC) AS rank
        FROM snapshots s JOIN scoped_targets t ON t.id=s.target_id
        WHERE t.type='account' AND s.quality_status!='rejected'
          AND s.total_likes IS NOT NULL AND s.captured_at>=? AND s.captured_at<=?
      )
      SELECT
        current.target_id,
        current.captured_at AS current_captured_at,
        current.quality_status AS current_quality_status,
        current.current_account_status,
        current.current_works_coverage,
        current.current_account_error,
        current.current_works_error,
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
      FROM current_any current
      LEFT JOIN current_followers followers ON followers.target_id=current.target_id AND followers.rank=1
      LEFT JOIN baseline_followers follower_baseline ON follower_baseline.target_id=current.target_id AND follower_baseline.rank=1
      LEFT JOIN first_followers_in_period first_follower ON first_follower.target_id=current.target_id AND first_follower.rank=1
      LEFT JOIN current_likes likes ON likes.target_id=current.target_id AND likes.rank=1
      LEFT JOIN baseline_likes likes_baseline ON likes_baseline.target_id=current.target_id AND likes_baseline.rank=1
      LEFT JOIN first_likes_in_period first_like ON first_like.target_id=current.target_id AND first_like.rank=1
      WHERE current.rank=1 ORDER BY current.target_id

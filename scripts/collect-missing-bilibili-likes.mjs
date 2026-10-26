// One-time repair after the Bilibili like_num mapping fix. Existing history is
// never backfilled: all new observations pass through the running collector.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const ids = Array.from({ length: 14 }, (_, index) => 985 + index);
const execute = process.argv.includes('--execute');
const db = new DatabaseSync(new URL('../data/douyin-monitor.sqlite', import.meta.url), { readOnly: true });
const base = 'http://127.0.0.1:4188';
const reportPath = new URL('../output/playwright/bilibili-likes-repair.json', import.meta.url);
const report = { startedAt: new Date().toISOString(), mode: execute ? 'collect-current-observations' : 'preview', results: [] };

function candidate(id) {
  const target = db.prepare('SELECT id,label,type,provider,enabled,metadata_json FROM targets WHERE id=?').get(id);
  if (!target || target.type !== 'account' || target.provider !== 'public-web' || !target.enabled
    || JSON.parse(target.metadata_json).platform !== 'bilibili') throw new Error(`Target ${id} is outside the verified repair scope`);
  const observed = db.prepare("SELECT COUNT(*) AS count FROM snapshots WHERE target_id=? AND total_likes IS NOT NULL AND quality_status<>'rejected'").get(id).count;
  return { id, label: target.label, alreadyHasLikes: observed > 0 };
}

try {
  const targets = ids.map(candidate);
  if (!execute) {
    console.log(JSON.stringify({ mode: 'preview', targets }));
  } else {
    const authResponse = await fetch(`${base}/api/bootstrap`);
    const cookie = authResponse.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const bootstrap = await authResponse.json();
    if (!authResponse.ok || !bootstrap.auth?.permissions?.edit || !bootstrap.auth?.csrfToken) throw new Error('Application authentication failed');
    const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': bootstrap.auth.csrfToken, origin: base };
    for (const target of targets) {
      if (candidate(target.id).alreadyHasLikes) {
        report.results.push({ ...target, skipped: true, reason: 'Current likes already observed' });
        continue;
      }
      const before = db.prepare('SELECT COUNT(*) AS count,MAX(id) AS maxId FROM snapshots WHERE target_id=?').get(target.id);
      const response = await fetch(`${base}/api/sync`, { method: 'POST', headers, body: JSON.stringify({ targetId: target.id }), signal: AbortSignal.timeout(240_000) });
      const result = await response.json();
      if (response.status === 409) throw new Error('Collector is busy or target paused; leave remaining targets for the next normal run');
      const observation = db.prepare('SELECT id,captured_at,followers,total_likes,total_posts,quality_status,source_checksum FROM snapshots WHERE target_id=? AND id>? ORDER BY id DESC LIMIT 1').get(target.id, before.maxId ?? 0);
      const entry = { ...target, httpStatus: response.status, success: response.ok && result.successCount === 1 && observation?.total_likes !== null && observation?.total_likes !== undefined, observation: observation ?? null, error: result.error ?? null };
      report.results.push(entry);
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(entry));
    }
    report.finishedAt = new Date().toISOString();
    report.successCount = report.results.filter((item) => item.success).length;
    report.remainingMissing = ids.filter((id) => !candidate(id).alreadyHasLikes).length;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ event: 'complete', successCount: report.successCount, remainingMissing: report.remainingMissing }));
  }
} finally {
  db.close();
}

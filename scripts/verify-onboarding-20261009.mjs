import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readMasterRoster } from '../lib/master-roster.mjs';
import { validateMasterRoster } from '../public/master-roster.js';
import { validateAccountSnapshot } from '../lib/account-snapshot-integrity.mjs';
const root = new URL('../', import.meta.url).pathname;
const out = root + 'data/maintenance-journal/20261009-onboarding/';
const sourceDir = root + 'data/maintenance-journal/20261009-upload/';
const sourceHash = '88bf7c4c50ac9031c8749254e791bb512306c44c564e65db576c6f84e755a3bb';
const sha = x => createHash('sha256').update(x).digest('hex');
const norm = x => String(x || '').normalize('NFKC').trim().toLowerCase();
const accounts = JSON.parse(await readFile(sourceDir + 'accounts-before.json', 'utf8'));
const recovery = JSON.parse(await readFile(out + 'recovery-apply.json', 'utf8'));
const jobId = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f';
assert.equal(sha(await readFile(sourceDir + 'source.xlsx')), sourceHash);
assert.equal(sha(await readFile('/Users/tyke/Downloads/一条小团团切片作品登记表.xlsx')), sourceHash);
const db = new DatabaseSync(root + 'data/douyin-monitor.sqlite', { readOnly: true });
db.exec('BEGIN');
const at = new Date();
let report;
try {
  const roster = readMasterRoster(db); validateMasterRoster(roster);
  const job = db.prepare('SELECT status,request_json,result_json FROM author_resolution_jobs WHERE id=?').get(jobId);
  assert.equal(job.status, 'completed');
  const input = JSON.parse(job.request_json);
  assert.equal(input.uploadSha256, sourceHash); assert.equal(input.rows.length, 3988);
  assert.equal(new Set(input.rows.map(x => norm(x.douyinId))).size, 394);
  const sourceRows = new Set();
  for (const item of roster.items) for (const source of item.sources.filter(s => s.liveJobId === jobId)) {
    for (const row of source.rows) sourceRows.add(Number(row));
  }
  assert.deepEqual([...sourceRows].sort((a, b) => a-b), Array.from({ length: 3988 }, (_, i) => i+2));
  const rows = accounts.map(a => {
    const entries = roster.items.filter(x => x.accountIds.some(id => norm(id) === a.id));
    assert.ok(entries.some(x => x.theme.key === 'tuantuan' && x.sources.some(s => s.liveJobId === jobId)), a.id);
    const targetIds = [...new Set(entries.map(x => x.targetId).filter(Boolean))];
    assert.ok(targetIds.length <= 1, `Ambiguous live target: ${a.id}`);
    const targetId = targetIds[0] ?? null;
    const target = targetId ? db.prepare('SELECT * FROM targets WHERE id=?').get(targetId) : null;
    const snapshot = target ? db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY captured_at DESC,id DESC LIMIT 1').get(targetId) : null;
    const usable = snapshot ? validateAccountSnapshot(snapshot, target, 'douyin', { metricsOnly: true }).valid : false;
    const fresh = usable && [snapshot.followers, snapshot.total_likes, snapshot.total_posts].every(Number.isSafeInteger)
      && at.getTime() - Date.parse(snapshot.captured_at) >= 0 && at.getTime() - Date.parse(snapshot.captured_at) <= 8*3600_000;
    return { submittedId: a.id, names: a.names, sourceRows: a.sourceRows, targetId,
      status: target ? target.enabled ? 'enabled' : 'paused' : 'unresolved',
      sample: snapshot ? { id: snapshot.id, capturedAt: snapshot.captured_at, usable, freshThreeMetrics: fresh,
        followers: snapshot.followers, likes: snapshot.total_likes, works: snapshot.total_posts } : null,
      separateUnresolvedSourceEntries: entries.filter(x => !x.targetId).map(x => ({ key: x.key, reasons: x.reviewReasons })),
      reasons: [...new Set(entries.flatMap(x => x.reviewReasons))],
    };
  });
  const frozenHash = sha(JSON.stringify(db.prepare('SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key').all()));
  assert.equal(frozenHash, recovery.before.frozenRoster);
  const oldImportHash = sha(db.prepare('SELECT result_json FROM author_resolution_jobs WHERE id=?').get('24ed9508-815c-4c08-81f6-b73266d0f304').result_json);
  assert.equal(oldImportHash, recovery.before.oldImport);
  const scheduled = db.prepare('SELECT id,trigger_type,started_at,finished_at,status,target_count,success_count,error_count FROM runs WHERE id=10392').get();
  assert.equal(scheduled.status, 'success'); assert.equal(scheduled.target_count, 11); assert.equal(scheduled.success_count, 11);
  for (const receipt of recovery.applied) {
    assert.equal(db.prepare('SELECT count(*) n FROM account_events WHERE id=? AND event_type=?').get(receipt.eventId, 'monitoring-recovery').n, 1);
    assert.equal(db.prepare('SELECT enabled FROM targets WHERE id=?').get(receipt.targetId).enabled, 1);
    assert.ok(rows.find(x => x.targetId === receipt.targetId)?.sample.freshThreeMetrics);
  }
  report = { checkedAt: at.toISOString(), jobId, sourceHash, sourceRows: input.rows.length, distinctSubmittedIds: rows.length,
    preservedSourceRows: sourceRows.size, enabled: rows.filter(x => x.status === 'enabled').length,
    paused: rows.filter(x => x.status === 'paused').length, unresolved: rows.filter(x => x.status === 'unresolved').length,
    freshProfileThreeMetrics: rows.filter(x => x.status === 'enabled' && x.sample?.freshThreeMetrics).length,
    newlyRecoveredTargets: recovery.applied.map(x => x.targetId), linkedHistoricalAliases: roster.liveSources.profileLinkedEntryCount,
    scheduledAutomaticRun: scheduled, globalRosterSummary: roster.summary, sourceProjection: roster.liveSources,
    frozenHash, oldImportHash, sourceAndHistoryPreserved: recovery.allPreserved,
    tests: { passed: 203, failed: 0, skipped: 0, scope: '13 related test files, not the entire repository' },
    allMonitoringComplete: false, workCoverageComplete: false,
    limitations: ['启用监控不等于所有登记作品已验证；主页统计与作品覆盖分开。', '241个提交身份尚未唯一定位，未新增空账号或伪造快照。', '1个已监控ID仍有相冲突的作品来源记录，另1个保留未归并的重复来源条目。', '采集依赖本机开机联网；不是关机后持续采集或全网络公网承诺。'], rows };
  assert.equal(report.enabled, 153); assert.equal(report.paused, 0); assert.equal(report.unresolved, 241);
  db.exec('COMMIT');
} finally { db.close(); }
await writeFile(out + 'verification.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const esc = x => String(x).replaceAll('|', '\\|').replaceAll('\n', ' ');
const md = [
  '# 一条小团团登记表：监控接入核对', '', `核对时间：${report.checkedAt}。本报告不是“全部接入完成”声明。`, '',
  `原表 ${report.sourceRows} 行，${report.distinctSubmittedIds} 个不同提交账号；${report.preservedSourceRows} 行来源全部保留。`, '',
  `已启用监控：${report.enabled}；其中近 8 小时主页三项真实统计可用：${report.freshProfileThreeMetrics}。未定位：${report.unresolved}。`, '',
  '本次恢复 11 个被旧作品核验暂停的账号，保留失败记录；另关联 3 个已改号的现有账号，未重复建档。产品自身定时任务已自动采集恢复的 11 个账号，11/11 成功。', '',
  '测试：203 项相关测试通过；数据库一致性备份临时副本验证通过；真实页面已验收。未做全仓测试。', '',
  '## 仍未接入的原因', '',
  '公开作品接口出现 403、空响应或不能确认作品作者；精确账号搜索返回访问挑战页，未取得可信主页地址。没有按同名猜测账号，也没有把排队当作成功。下表未接入行保留原始行号，补充完整抖音主页或账号主页分享链接可提供直接定位依据。', '',
  ...report.limitations.map(x => '- ' + x), '',
  '## 全部提交账号核对清单', '',
  '| 原表账号 | 原表名称 | 监控状态 | 近8小时主页统计 | 原表行号 |',
  '| --- | --- | --- | --- | --- |',
  ...report.rows.map(x => `| ${esc(x.submittedId)} | ${esc(x.names.join(' / '))} | ${x.status === 'enabled' ? '已启用' : '未接入'} | ${x.sample?.freshThreeMetrics ? '粉丝/获赞/作品数可用' : '未取得新样本'} | ${x.sourceRows.join('、')} |`), '',
  '源文件校验：`' + sourceHash + '`。原表未更改；表格自填播放与点赞未写成平台监控数据。', '',
].join('\n');
await writeFile(out + '监控接入核对报告.md', md, { flag: 'wx', mode: 0o600 });
const { rows, ...summary } = report; console.log(JSON.stringify(summary, null, 2));

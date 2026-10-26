import { DatabaseSync } from 'node:sqlite';
import { statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checksum } from '../lib/utils.mjs';

const baseline = process.argv[2];
if (!baseline || !statSync(baseline).isFile()) throw new Error('An exact existing pre-release backup path is required');
const database = new DatabaseSync(new URL('../data/douyin-monitor.sqlite', import.meta.url), { readOnly: true });
try {
  database.prepare('ATTACH DATABASE ? AS baseline').run(resolve(baseline));
  const preservation = {};
  for (const table of ['snapshots', 'post_metrics', 'audits', 'runs', 'target_boards', 'board_catalog']) {
    preservation[table] = database.prepare(`SELECT COUNT(*) lostOrChanged FROM (SELECT * FROM baseline.${table} EXCEPT SELECT * FROM main.${table})`).get().lostOrChanged;
  }
  if (database.prepare("SELECT 1 FROM baseline.sqlite_master WHERE type='table' AND name='account_events'").get()) {
    preservation.accountEvents = database.prepare('SELECT COUNT(*) lostOrChanged FROM (SELECT * FROM baseline.account_events EXCEPT SELECT * FROM main.account_events)').get().lostOrChanged;
  }
  preservation.postIdentities = database.prepare(`SELECT COUNT(*) lostOrChanged FROM (
    SELECT id,target_id,external_id,author_id,first_seen_at FROM baseline.posts
    EXCEPT SELECT id,target_id,external_id,author_id,first_seen_at FROM main.posts
  )`).get().lostOrChanged;
  const targetChanges = [];
  for (const before of database.prepare('SELECT * FROM baseline.targets').all()) {
    const after = database.prepare('SELECT * FROM main.targets WHERE id=?').get(before.id);
    const prior = JSON.parse(before.metadata_json);
    const current = after ? JSON.parse(after.metadata_json) : {};
    const preserved = after && before.locator === after.locator && before.enabled === after.enabled
      && before.provider === after.provider && prior.douyinId === current.douyinId
      && JSON.stringify(prior.importSource) === JSON.stringify(current.importSource)
      && JSON.stringify(prior.resolution) === JSON.stringify(current.resolution);
    if (!preserved) targetChanges.push(before.id);
  }
  const events = database.prepare('SELECT id,event_type,source_checksum,raw_json,event_json FROM account_events ORDER BY id').all();
  const eventChecks = events.map((row) => {
    const evidence = JSON.parse(row.event_json);
    const valid = checksum(JSON.parse(row.raw_json)) === row.source_checksum
      && (row.event_type === 'lifecycle' ? evidence.sourceChecksum : evidence.currentRawSha256) === row.source_checksum;
    return { id: row.id, type: row.event_type, valid };
  });
  const integrity = database.prepare('PRAGMA quick_check').get().quick_check;
  const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all().length;
  const result = { checkedAt: new Date().toISOString(), baseline: resolve(baseline), preservation, targetChanges, eventChecks,
    integrity, foreignKeyViolations, ok: Object.values(preservation).every((value) => value === 0)
      && targetChanges.length === 0 && eventChecks.every((row) => row.valid) && integrity === 'ok' && foreignKeyViolations === 0 };
  writeFileSync(new URL('../output/playwright/account-continuity-preservation.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally { database.close(); }

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { MonitorDatabase } from "../lib/database.mjs";
import { getAccountInsight, getProductInsights } from "../lib/product-insights.mjs";
import { checksum } from "../lib/utils.mjs";

const reference = new Date("2026-10-04T16:00:00.000Z");
const timeZone = "Asia/Shanghai";

// Oracle copied from the former candidate query. Keeping the old query in this
// test makes the equivalence check portable; the test never reads production
// backups or exposes a production-only switch in the implementation.
const legacySnapshotSql = [
  "    WITH eligible AS (",
  "      SELECT s.id,s.target_id,strftime('%Y-%m-%dT%H:%M:%fZ',s.captured_at) AS captured_at,s.followers,s.total_likes,s.total_posts,",
  "        s.quality_status,s.account_status,s.works_coverage,s.account_error,s.works_error,",
  "        s.warnings_json,s.source_checksum,s.raw_json,",
  "        CASE WHEN json_valid(s.raw_json) AND (",
  "          json_extract(s.raw_json,'$.codexObservation.source')='manual-import'",
  "          OR json_type(s.raw_json,'$.snapshot')='object'",
  "        ) THEN 1 ELSE 0 END AS manual_import,",
  "        CASE WHEN json_valid(s.raw_json) THEN json_extract(s.raw_json,'$.profile.user.unique_id') END AS observed_public_id",
  "      FROM snapshots s JOIN targets t ON t.id=s.target_id",
  "      WHERE ${targetClause} AND julianday(s.captured_at)<=julianday(?)",
  "    ), older AS (",
  "      SELECT *, ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY captured_at DESC,id DESC) AS latest_rank,",
  "        ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY CASE WHEN quality_status!='rejected' AND typeof(followers) IN ('integer','real') AND followers>=0 THEN 0 ELSE 1 END,captured_at DESC,id DESC) AS followers_rank,",
  "        ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY CASE WHEN quality_status!='rejected' AND typeof(total_likes) IN ('integer','real') AND total_likes>=0 THEN 0 ELSE 1 END,captured_at DESC,id DESC) AS likes_rank,",
  "        ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY CASE WHEN quality_status!='rejected' AND typeof(total_posts) IN ('integer','real') AND total_posts>=0 THEN 0 ELSE 1 END,captured_at DESC,id DESC) AS posts_rank",
  "      FROM eligible WHERE captured_at<?",
  "    )",
  "    SELECT * FROM eligible WHERE captured_at>=?",
  "      OR id IN (SELECT id FROM older WHERE latest_rank=1 OR followers_rank=1 OR likes_rank=1 OR posts_rank=1)",
  "    ORDER BY captured_at,id",
].join("\n");

async function loadLegacyOracle() {
  const sourcePath = fileURLToPath(new URL("../lib/product-insights.mjs", import.meta.url));
  const original = readFileSync(sourcePath, "utf8");
  const queryPattern = /const snapshotQuery = db\.prepare\(`([\s\S]*?)\n  `\);/g;
  const matches = [...original.matchAll(queryPattern)];
  assert.equal(matches.length, 1, "expected exactly one snapshot query to replace with the legacy oracle");
  const legacyBlock = `const snapshotQuery = db.prepare(\`\n${legacySnapshotSql}\n  \`);`;
  let oracleSource = original.replace(queryPattern, () => legacyBlock);
  oracleSource = oracleSource.replace(/(from\s+)(["'])(\.{1,2}\/[^"']+)\2/g, (_match, prefix, quote, specifier) =>
    `${prefix}${quote}${pathToFileURL(resolve(dirname(sourcePath), specifier)).href}${quote}`);
  return import(`data:text/javascript;base64,${Buffer.from(oracleSource).toString("base64")}`);
}

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), "narrow-snapshot-candidates-"));
  const database = new MonitorDatabase(resolve(directory, "fixture.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const account = (label, { createdAt = "2026-08-01T00:00:00.000Z", board = "一条小团团切片矩阵" } = {}) => {
    sequence += 1;
    const target = database.createTarget({ type: "account", label,
      locator: `MS4wLjABAAAAaccount${sequence}abcdefghijklmnop`, provider: "public-web", metadata: { platform: "douyin" } });
    database.db.prepare("UPDATE targets SET created_at=?,updated_at=? WHERE id=?")
      .run(createdAt, createdAt, target.id);
    if (board) {
      database.assignTargetsToBoard([target.id], board);
      database.db.prepare("UPDATE target_boards SET created_at=? WHERE target_id=?").run(createdAt, target.id);
    }
    return target;
  };
  const sample = (target, capturedAt, values, { quality = "validated", identity = target.locator,
    corruptChecksum = false, manual = false } = {}) => {
    const raw = { capturedAt: new Date(capturedAt).toISOString(),
      profile: { user: { sec_uid: identity, uid: "222523170759696", follower_count: values[0] ?? null,
        total_favorited: values[1] ?? null, aweme_count: values[2] ?? null } }, works: { aweme_list: [] } };
    if (manual) raw.codexObservation = { source: "manual-import" };
    const rawJson = JSON.stringify(raw);
    const sourceChecksum = corruptChecksum ? checksum({ ...raw, deliberatelyChanged: true }) : checksum(raw);
    return Number(database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
      quality_status,account_status,works_coverage,source_checksum,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(target.id, capturedAt, values[0] ?? null, values[1] ?? null, values[2] ?? null,
        quality, "available", "complete", sourceChecksum, rawJson).lastInsertRowid);
  };
  return { database, account, sample };
}

test("narrow snapshot candidates are deep-equal to the former wide query across integrity and time boundaries", async (t) => {
  const legacy = await loadLegacyOracle();
  const { database, account, sample } = fixture(t);
  const primary = account("正常账号");
  const partial = account("缺失指标基线");
  const createdAfterB = account("B区间后才入库", { createdAt: "2026-09-10T00:00:00.000Z" });
  const otherBoard = account("其他板块账号", { board: "其他矩阵" });

  // Offset timestamps resolve to the same normalized UTC instants; for the
  // duplicate A-end instant, contradictory counters are withheld independently.
  sample(primary, "2026-09-11T15:00:00.000Z", [70, 700, 7]);
  sample(primary, "2026-09-01T08:00:00+08:00", [10, 100, 1]);
  sample(primary, "2026-09-03T20:00:00+08:00", [20, 200, 2]);
  sample(primary, "2026-09-12T08:00:00+08:00", [0, null, 0]);
  sample(primary, "2026-09-14T12:00:00+08:00", [6, null, 1]);
  sample(primary, "2026-09-14T04:00:00.000Z", [8, 50, 2]);
  sample(primary, "2026-09-13T08:00:00+08:00", [999, 999, 999], { identity: "MS4wLjABAAAAwrongidentityabcdefghijklmnop" });
  sample(primary, "2026-09-13T09:00:00+08:00", [888, 888, 888], { corruptChecksum: true });
  sample(primary, "2026-09-13T10:00:00+08:00", [777, 777, 777], { manual: true });
  sample(primary, "2026-10-05T00:00:00.000Z", [1234, 1234, 1234]); // after the requested reference/range

  sample(partial, "2026-08-31T17:00:00+08:00", [25, null, 0], { quality: "warning" });
  sample(partial, "2026-08-31T18:00:00+08:00", [90, 90, 90], { quality: "rejected" });
  sample(partial, "2026-09-02T12:00:00+08:00", [null, 10, null]);
  sample(partial, "2026-09-03T12:00:00+08:00", [30, 12, 1]);
  sample(partial, "2026-09-11T15:30:00.000Z", [null, null, null]);
  sample(partial, "2026-09-12T08:30:00+08:00", [30, null, 1]);
  sample(partial, "2026-09-14T08:30:00+08:00", [35, 0, 2]);

  for (const target of [createdAfterB, otherBoard]) {
    sample(target, "2026-08-31T16:30:00Z", [100, 1000, 10]);
    sample(target, "2026-09-02T08:00:00Z", [110, 1100, 11]);
    sample(target, "2026-09-11T16:30:00Z", [120, 1200, 12]);
    sample(target, "2026-09-14T08:00:00Z", [130, 1300, 13]);
  }

  for (const range of [
    { startDate: "2026-09-01", endDate: "2026-09-03" },
    { startDate: "2026-09-12", endDate: "2026-09-14" },
  ]) {
    const options = { period: "custom", ...range, reference, timeZone, board: "一条小团团切片矩阵" };
    const actual = getProductInsights(database, options);
    const expected = legacy.getProductInsights(database, options);
    assert.deepStrictEqual(actual, expected, `matrix result differs for ${range.startDate}..${range.endDate}`);
    assert.ok(actual.accounts.some((entry) => entry.id === primary.id));
    assert.ok(!actual.accounts.some((entry) => entry.id === otherBoard.id), "board scope remains applied");
    if (range.startDate === "2026-09-01") {
      assert.ok(!actual.accounts.some((entry) => entry.id === createdAfterB.id), "period-end cohort still excludes later targets");
    }
    for (const target of [primary, partial, createdAfterB, otherBoard]) {
      const detailOptions = { period: "custom", ...range, reference, timeZone };
      assert.deepStrictEqual(getAccountInsight(database, target.id, detailOptions),
        legacy.getAccountInsight(database, target.id, detailOptions), `account detail differs for target ${target.id}`);
    }
  }

  const primaryA = getAccountInsight(database, primary.id, { period: "custom", startDate: "2026-09-12",
    endDate: "2026-09-14", reference, timeZone }).account;
  assert.equal(primaryA.metrics.followers.delta, null, "equal-instant contradictory followers cannot pick the greatest row ID");
  assert.match(primaryA.metrics.followers.reason, /冲突/);
  assert.equal(primaryA.metrics.likes.delta, -650);
  assert.equal(primaryA.metrics.posts.delta, null, "the same conflict rule applies to account inventory");
  const partialB = getAccountInsight(database, partial.id, { period: "custom", startDate: "2026-09-01",
    endDate: "2026-09-03", reference, timeZone }).account;
  assert.equal(partialB.metrics.likes.delta, null, "a missing likes baseline is not manufactured from null observations");
});

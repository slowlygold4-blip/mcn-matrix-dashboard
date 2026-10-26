import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("../", import.meta.url));

test("极炫名单导入拒绝把搜索结果页模糊匹配成账号，并保留审查警告", () => {
  const tempDir = mkdtempSync(join("/tmp", "jixuan-import-contract-"));
  try {
    const historyDir = join(tempDir, "history");
    mkdirSync(historyDir);
    const secUid = "MS4wLjABAAAAabcdefghijklmnop";
    const roster = [
      { name: "稳定作者", link: `https://www.douyin.com/user/${secUid}`, dyid: "stable-id", rating: "头部" },
      { name: "搜索结果作者", link: "https://www.douyin.com/search/搜索结果作者", dyid: "search-id", rating: "长尾" },
    ];
    const latest = {
      generated: "2026-09-10 10:00",
      count: 2,
      ok: 1,
      fail: 1,
      talents: [
        { name: "稳定作者", link: roster[0].link, sec_uid: secUid, fans: 1000, likes: 2000, works: 3 },
        { name: "搜索结果作者", link: roster[1].link, error: "抓取失败(暂用上次值)" },
      ],
    };
    writeFileSync(join(tempDir, "roster.json"), JSON.stringify(roster));
    writeFileSync(join(tempDir, "latest.json"), JSON.stringify(latest));
    writeFileSync(join(historyDir, "2026-09-10.json"), JSON.stringify(latest));

    const dbPath = join(tempDir, "monitor.sqlite");
    const output = execFileSync(process.execPath, [
      join(root, "scripts/import-jixuan-douyin-board.mjs"),
      "--db", dbPath,
      "--roster", join(tempDir, "roster.json"),
      "--latest", join(tempDir, "latest.json"),
      "--history", historyDir,
    ], { cwd: root, encoding: "utf8" });
    const result = JSON.parse(output);
    assert.equal(result.activeBoardTargets, 1);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0].name, "搜索结果作者");
    assert.match(result.unresolved[0].reason, /搜索结果页/);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audits WHERE status='warning'").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM target_boards WHERE board_key='抖音主播板块'").get().count, 1);
    database.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

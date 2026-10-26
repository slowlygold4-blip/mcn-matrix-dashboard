import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourcePollKey } from "../lib/source-poller-status.mjs";

const registry = JSON.parse(readFileSync(new URL("../data/source-poll/registry.json", import.meta.url), "utf8"));
const allEntries = registry.sources.flatMap((source) => [source, ...(source.aliases || [])]);

test("daily source catalog retains all six original user supplied source objects", () => {
  for (const token of ["Jx5zs1SFLhzoyqtCqOZcPwSbnNb", "SLe2sW0xQhr5bOtYTZ7cEg8Cnyg", "C1uqwXn0Xiu7Kzk6cpCcEG6nn8f",
    "UbeEsThm3h1fsktWiEaclM1enOe", "shrcnpxtmZOnE8VRs1k15H89zhh", "RQq6ws8K9iK7mYkkUxYcZK0InTc"]) {
    assert.ok(allEntries.some((source) => source.sourceUrl.includes(token)), `Missing original source ${token}`);
  }
});

test("content-statistics workbooks never enter the automatic author-import path", () => {
  const content = registry.sources.filter((source) => source.kind === "content-statistics");
  assert.equal(content.length, 2);
  for (const source of content) {
    assert.equal(source.sourceType, "lark-sheet");
    assert.equal(source.monitorOnly, true);
    assert.equal(source.defaultBoard, "");
    assert.ok(source.registrationEvidence);
  }
});

test("all five cloud-evidenced Tuantuan workbook tabs have explicit daily destinations", () => {
  const sources = registry.sources.filter((source) => source.sourceUrl.includes("UbeEsThm3h1fsktWiEaclM1enOe"));
  assert.equal(sources.length, 5);
  assert.deepEqual(sources.map((source) => source.sheetId).sort(), ["6Nt0HU", "c7IttQ", "fF65AK", "fa676d", "HyRxYp"].sort());
  for (const source of sources) {
    assert.equal(source.defaultBoard, "一条小团团切片矩阵");
    assert.equal(source.sourceType, "lark-sheet");
    assert.equal(source.kind, "author-roster");
    assert.equal(new URL(source.sourceUrl).searchParams.get("sheet"), source.sheetId);
    if (source.sheetId === "HyRxYp") {
      assert.match(source.registrationEvidence, /完整读取A1:G52、revision5320/);
      assert.equal(source.revision, 0, "catalog discovery is not an ingestion receipt");
    } else assert.ok(source.registrationEvidence.includes("7a2c9fe2-2aa7-4bb1-88fa-14e3c31a91b6"));
    assert.ok(source.sheetName);
  }
});

test("unresolved source aliases remain blocked and do not invent an authorized destination", () => {
  const aliases = registry.sources.filter((source) => source.kind === "source-alias");
  assert.equal(aliases.length, 1);
  assert.match(aliases[0].sourceUrl, /share\/base\/form/);
  for (const source of aliases) {
    assert.equal(source.readPolicy, "unresolved-alias");
    assert.equal(source.monitorOnly, true);
    assert.equal(source.resolvedTo, null);
    assert.ok(source.blockedReason);
  }
  const resolved = registry.sources.flatMap((source) => (source.aliases || []).map((alias) => ({ alias, source })));
  assert.equal(resolved.length, 2);
  for (const item of resolved) assert.equal(item.alias.resolvedTo, item.source.sourceUrl);
  assert.match(resolved.find(item => item.alias.sourceUrl.includes("RQq6ws8")).alias.resolutionEvidence, /author_resolution_jobs:d791295c/);
});

test("Yuqilin resolved Wiki preserves the existing source identity and original link", () => {
  const source = registry.sources.find(item => item.sourceUrl.includes("U0FIsi9nMh2dAqtBlZ4cOtI6nIg"));
  assert.equal(sourcePollKey(source), "330c33260e3bb5f6281d2a5330a7f844");
  assert.equal(source.sheetId, "a058df");
  assert.equal(source.sheetName, "8月");
  assert.equal(source.defaultBoard, "玉麒麟切片矩阵");
  assert.equal(source.kind, "author-roster");
  assert.match(source.aliases[0].sourceUrl, /C1uqwXn0Xiu7Kzk6cpCcEG6nn8f/);
  assert.match(source.aliases[0].resolutionEvidence, /wiki \+node-get/);
});

test("catalog preserves the seven prior authorized source URLs and only permitted HTTPS hosts", () => {
  for (const token of ["KPLSwjTkCilmaKkrpz2cEzOcnBc", "FbWFw55aqibiMFkig84cKbvhnNe", "L4hZsqBkNhog6Yt6vP1ckhvlnzh",
    "QCWnsFzInhMpcetueKUcIktrnac", "CUHPs5THQhDD4gtvDHCcoJirnze?sheet=f49886", "CUHPs5THQhDD4gtvDHCcoJirnze?sheet=1v2rfi", "YR58sxWa0hyIW6tqGPCcoxhGnYd"]) {
    assert.ok(registry.sources.some((source) => source.sourceUrl.includes(token)));
  }
  for (const source of allEntries) {
    const url = new URL(source.sourceUrl);
    assert.equal(url.protocol, "https:");
    assert.match(url.hostname, /(^|\.)(feishu\.cn|larkoffice\.com)$/);
  }
  assert.equal(new Set(registry.sources.map((source) => source.sourceUrl)).size, registry.sources.length);
});

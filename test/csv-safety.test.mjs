import test from "node:test";
import assert from "node:assert/strict";
import { csvEscape, csvTextEscape } from "../lib/utils.mjs";

test("review CSV text cells cannot become spreadsheet formulas", () => {
  for (const value of [
    '=HYPERLINK("https://evil.example", "点击")',
    "+1+1",
    "-2+3",
    "@SUM(A1:A2)",
    "\t=WEBSERVICE(\"https://evil.example\")",
    "\uFEFF@HYPERLINK(\"https://evil.example\")",
  ]) {
    const escaped = csvTextEscape(value);
    const unquoted = escaped.startsWith('"') ? escaped.slice(1, -1).replaceAll('""', '"') : escaped;
    assert.ok(unquoted.startsWith("'"), `${JSON.stringify(value)} must be forced to literal text`);
  }
  assert.equal(csvTextEscape("正常作者"), "正常作者");
  assert.equal(csvTextEscape("2026-09-08"), "2026-09-08");
});

test("numeric CSV cells keep their original values", () => {
  assert.equal(csvEscape(-12), "-12");
  assert.equal(csvEscape(0), "0");
  assert.equal(csvEscape(42), "42");
});

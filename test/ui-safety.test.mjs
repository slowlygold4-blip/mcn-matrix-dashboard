import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { authorEvidenceHtml, httpLinkOrTextHtml, humanizeWarning, humanizedWarningHtml, reviewStatus, safeHttpUrl, warningText } from "../public/ui-safety.js";

test("author import dialog states the deployed platform evidence boundary", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /B站支持 BV 号、官方视频链接或 b23 短链匿名反查发布者/);
  assert.match(html, /小红书仍须提供账号主页或账号 ID/);
  assert.doesNotMatch(html, /仅抖音支持用作品 ID、作品链接或分享链接匿名反查作者/);
});

test("queue warning text is escaped after it is humanized", () => {
  const html = humanizedWarningHtml('<svg onload="globalThis.compromised=true">未通过</svg>');
  assert.equal(html, "&lt;svg onload=&quot;globalThis.compromised=true&quot;&gt;未通过&lt;/svg&gt;");
  assert.doesNotMatch(html, /<svg/i);
});

test("structured audit warnings show their reason instead of object coercion", () => {
  assert.equal(humanizeWarning({ locator: "MS4wLjABAAAApublicIdentity", reason: "该监控目标已存在" }), "该监控目标已存在");
  assert.equal(humanizeWarning({ locator: "MS4wLjABAAAApublicIdentity" }), "结构化审查记录已保留");
  assert.equal(warningText({ reason: "作品列表接口未通过" }), "作品列表接口未通过");
  assert.notEqual(humanizeWarning({ reason: "核验完成" }), "[object Object]");
});

test("retry classification uses raw string or structured reasons before display copy is humanized", () => {
  assert.deepEqual(reviewStatus("warning", ["HTTP 403"]), { key: "retry", label: "自动重试" });
  assert.deepEqual(reviewStatus("warning", [{ reason: "作品列表接口未通过" }]), { key: "retry", label: "自动重试" });
  assert.deepEqual(reviewStatus("warning", ["仅覆盖最新公开作品窗口"]), { key: "limited", label: "范围受限" });
});

test("queue evidence renders links only for safe HTTP(S) destinations", () => {
  const html = authorEvidenceHtml({
    videoIds: ["7679097628281376036", "javascript:alert(1)", '"><img src=x onerror=alert(1)>'],
    shareUrls: ["https://v.douyin.com/AbCdEfG/", "http://www.douyin.com/video/7679270829082823972", "data:text/html,<script>alert(1)</script>"],
  });
  assert.match(html, /href="https:\/\/www\.douyin\.com\/video\/7679097628281376036"/);
  assert.match(html, /href="https:\/\/v\.douyin\.com\/AbCdEfG\/"/);
  assert.match(html, /href="http:\/\/www\.douyin\.com\/video\/7679270829082823972"/);
  assert.doesNotMatch(html, /href="(?:javascript|data):/i);
  assert.doesNotMatch(html, /<img|<script/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/plain,unsafe"), null);
  assert.equal(safeHttpUrl("/relative/path"), null);
});

test("external report links fall back to escaped plain text for unsafe protocols", () => {
  const safe = httpLinkOrTextHtml("https://www.douyin.com/video/7679097628281376036", "正常作品");
  assert.match(safe, /^<a href="https:\/\/www\.douyin\.com\/video\/7679097628281376036"/);
  assert.match(safe, /target="_blank" rel="noopener noreferrer"/);

  const unsafe = httpLinkOrTextHtml("javascript:alert(1)", '<img src=x onerror="alert(1)">');
  assert.equal(unsafe, "<span>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</span>");
  assert.doesNotMatch(unsafe, /<a|href=|<img/i);
});

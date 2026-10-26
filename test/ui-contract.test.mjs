import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

test("public UI keeps generated invite link input accessible", async () => {
  const html = await readFile(resolve(root, "public/index.html"), "utf8");
  assert.match(html, /id="inviteShareLink"[^>]*(?:aria-label|title)="生成的公开邀请链接"/);
});

test("public UI exposes all primary navigation destinations", async () => {
  const html = await readFile(resolve(root, "public/index.html"), "utf8");
  for (const hash of ["#overview", "#boards", "#topics", "#targets", "#updates", "#reports", "#audit"]) {
    assert.match(html, new RegExp(`href="${hash.replace("#", "\\#")}"`));
  }
});

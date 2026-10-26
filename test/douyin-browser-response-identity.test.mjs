import test from "node:test";
import assert from "node:assert/strict";
import { isExpectedDouyinWorksResponseUrl } from "../lib/douyin-browser-response-identity.mjs";

const SEC = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const OTHER = "MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba";
const ENDPOINT = "https://www.douyin.com/aweme/v1/web/aweme/post/";
const url = `${ENDPOINT}?sec_user_id=${SEC}&count=30&max_cursor=0&a_bogus=[REDACTED]

test("works response is bound to the exact requested sec_user_id independently of query ordering", () => {
  assert.equal(isExpectedDouyinWorksResponseUrl(url, SEC), true);
  assert.equal(isExpectedDouyinWorksResponseUrl(`${ENDPOINT}?count=30&sec_user_id=${SEC}&max_cursor=3`, SEC), true);
  assert.equal(isExpectedDouyinWorksResponseUrl(url.replace(".com/", ".com:443/"), SEC), true);
  assert.equal(isExpectedDouyinWorksResponseUrl(`${ENDPOINT}?sec_user_id=${encodeURIComponent(SEC)}`, SEC), true);
});

test("wrong origin, protocol, userinfo, nondefault port, path and fragment are never works evidence", () => {
  for (const rejected of [
    url.replace("www.douyin.com", "evil.example"), url.replace("www.douyin.com", "www.douyin.com.evil.example"),
    url.replace("www.douyin.com", "douyin.com"), url.replace("https:", "http:"),
    url.replace("https://", "https://user:secret@"), url.replace(".com/", ".com:444/"),
    url.replace("https://", "https://@"),
    url.replace("/aweme/v1/", "/other/aweme/v1/"), url.replace("post/", "post"),
    url.replace("post/", "post/%2F"), `${url}#fragment`, ` ${url}`, `${url}\n`,
    url.replace("https://", "https:\\\\"), "not-a-url", null,
  ]) assert.equal(isExpectedDouyinWorksResponseUrl(rejected, SEC), false, String(rejected));
});

test("missing, wrong, malformed, duplicate and encoded-duplicate account parameters fail closed", () => {
  for (const query of ["", `sec_uid=${SEC}`, `SEC_USER_ID=${SEC}`, `sec_user_id=${OTHER}`,
    `sec_user_id=${SEC.toLowerCase()}`, "sec_user_id=", `sec_user_id=${SEC}%20`,
    `sec_user_id=${SEC}&sec_user_id=${SEC}`, `sec_user_id=${SEC}&sec_user_id=${OTHER}`,
    `sec_user_id=${OTHER}&sec_user_id=${SEC}`, `sec_user_id=${SEC}&%73ec_user_id=${SEC}`,
  ]) assert.equal(isExpectedDouyinWorksResponseUrl(`${ENDPOINT}?${query}`, SEC), false, query);
  for (const expected of [null, "", "wrong", SEC + " ", SEC + "\n"]) {
    assert.equal(isExpectedDouyinWorksResponseUrl(url, expected), false);
  }
  assert.equal(isExpectedDouyinWorksResponseUrl(`${ENDPOINT}?sec_user_id=${SEC}%0A`, SEC + "\n"), false);
});

test("identity gate is a boolean-only pure function and does not expose signed request details", () => {
  assert.equal(typeof isExpectedDouyinWorksResponseUrl(url, SEC), "boolean");
  assert.equal(JSON.stringify(isExpectedDouyinWorksResponseUrl(url, OTHER)), "false");
  assert.equal(url.includes("TEST_PRIVATE_SIGNATURE"), true);
});

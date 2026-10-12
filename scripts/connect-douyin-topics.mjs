#!/usr/bin/env node
/** One-time, user-driven login bootstrap for the isolated topic browser. */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL("../data", import.meta.url));
const STATE_PATH = resolve(process.env.DOUYIN_TOPIC_BROWSER_STATE || `${DATA_DIR}/douyin-topic-browser-state.json`);
const SEARCH_PATH = "/aweme/v1/web/general/search/single/";
const label = String(process.argv[2] || "一条小团团ovo").replace(/^#+/, "").trim();

function clean(value, max = 240) { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }

async function probe(page) {
  return page.evaluate(async (keyword) => {
    const url = new URL("/aweme/v1/web/general/search/single/", location.origin);
    const params = {
      device_platform: "webapp", aid: "6383", channel: "channel_pc_web", pc_client_type: "1",
      version_code: "170400", version_name: "17.4.0", cookie_enabled: "true", platform: "PC",
      search_channel: "aweme_general", enable_history: "1", keyword: `#${keyword}`,
      search_source: "tab_search", query_correct_type: "1", is_filter_search: "0", offset: "0",
      count: "15", need_filter_settings: "1", list_type: "multi", search_id: "",
    };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    return { httpStatus: response.status, statusCode: Number(payload?.status_code ?? -1), hasJson: Boolean(payload), statusMessage: payload?.status_msg || "" };
  }, label);
}

async function main() {
  const executablePath = process.env.DOUYIN_CHROME_PATH || DEFAULT_CHROME;
  const browser = await chromium.launch({ executablePath, headless: false });
  const context = await browser.newContext({ locale: "zh-CN", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36" });
  const page = await context.newPage();
  await page.goto(`https://www.douyin.com/search/%23${encodeURIComponent(label)}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  console.log(`已打开抖音登录窗口。请在窗口内完成登录（扫码/验证码由你本人操作），不要把账号、密码或验证码发给我。`);
  console.log(`登录后不要关闭窗口；程序会用“#${label}”做一次真实搜索探针。`);
  const deadline = Date.now() + 10 * 60_000;
  let lastMessage = "";
  try {
    while (Date.now() < deadline) {
      const result = await probe(page).catch((error) => ({ httpStatus: 0, statusCode: -1, hasJson: false, statusMessage: clean(error?.message ?? error) }));
      if (result.httpStatus === 200 && result.hasJson && result.statusCode === 0) {
        const state = await context.storageState();
        await mkdir(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
        await writeFile(STATE_PATH, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
        await chmod(STATE_PATH, 0o600);
        console.log(`登录态已保存到应用专用会话（${STATE_PATH}），仅当前用户可读。`);
        return;
      }
      const message = result.statusCode === 2483 ? "尚未登录或登录态未生效" : result.statusMessage || "等待抖音返回可用搜索响应";
      if (message !== lastMessage) { console.log(message); lastMessage = message; }
      await page.waitForTimeout(2_000);
    }
    throw new Error("10 分钟内未完成登录探针；没有保存会话文件");
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => { console.error(`连接抖音话题会话失败：${clean(error?.message ?? error, 500)}`); process.exitCode = 1; });

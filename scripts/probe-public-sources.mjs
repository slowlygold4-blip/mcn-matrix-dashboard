#!/usr/bin/env node

/** Read-only smoke probes for the three supported public source adapters. */
import process from "node:process";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";

const fixtures = [
  {
    platform: "douyin",
    target: { locator: process.env.DOUYIN_PROBE_SEC_UID || "MS4wLjABAAAAYSOcrkBBqaB3slbNIj7wqaOLcGlJrjx7vl6XhruDUEw" },
  },
  {
    platform: "bilibili",
    target: { locator: `https://space.bilibili.com/${process.env.BILIBILI_PROBE_UID || "1809444890"}` },
  },
  {
    platform: "xiaohongshu",
    target: { locator: `https://www.xiaohongshu.com/user/profile/${process.env.XHS_PROBE_USER_ID || "619e0b66000000001000e923"}` },
  },
];

export async function probeSources(provider = new PublicWebProvider({}), cases = fixtures) {
  const results = [];
  for (const item of cases) {
    const started = Date.now();
    try {
      const result = item.platform === "douyin"
        ? await provider.testConnection()
        : await provider.testConnectionForPlatform(item.platform, item.target);
      results.push({
        platform: item.platform,
        ok: true,
        durationMs: Date.now() - started,
        mode: result.mode || null,
        nickname: result.nickname || result.data?.profile?.user?.nickname || null,
        profileEndpoint: result.profileEndpoint ?? null,
        postsEndpoint: result.postsEndpoint ?? null,
        runtimeAI: result.runtimeAI ?? false,
        paidAPI: result.paidAPI ?? false,
      });
    } catch (error) {
      results.push({ platform: item.platform, ok: false, durationMs: Date.now() - started, error: error.message });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    browserCollection: false,
    runtimeAI: false,
    paidAPI: false,
    results,
    overall: results.length === cases.length && results.every((item) => item.ok && item.runtimeAI === false && item.paidAPI === false),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await probeSources();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (process.argv.includes("--strict") && !result.overall) process.exitCode = 1;
}

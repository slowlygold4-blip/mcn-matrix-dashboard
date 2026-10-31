import { collectorOwnershipClient } from './collector-ownership.mjs';

/** Product policy: these historical local-browser commands are retired. */
export const DOUYIN_BROWSER_RETIRED = Object.freeze({
  ok: false,
  errorCode: 'DOUYIN_BROWSER_RETIRED',
  message: '本产品已停用本机抖音浏览器采集；请使用 HTTP 或已授权的数据来源。',
  runtimeAI: false,
});

export function retiredDouyinBrowserError() {
  return Object.assign(new Error(DOUYIN_BROWSER_RETIRED.message), {
    code: DOUYIN_BROWSER_RETIRED.errorCode,
  });
}

// Do not read stdin, sessions, uploaded flags or environment opt-ins. Keeping a
// small rejection entry preserves a useful error for old callers/npm commands.
export async function reportRetiredDouyinBrowserCommand() {
  try {
    // An old parent may already own this child. Confirm a prelaunch rejection
    // so it can release the lane; never claim a browser launch/register/release.
    const ownership = collectorOwnershipClient();
    if (ownership) {
      await ownership.send('hello');
      await ownership.send('complete');
    }
  } catch {
    // No source data exists. Let the supervisor retain uncertainty if its
    // private handshake failed; do not expose IPC or environment information.
  } finally {
    process.stdout.write(JSON.stringify(DOUYIN_BROWSER_RETIRED) + '\n');
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}

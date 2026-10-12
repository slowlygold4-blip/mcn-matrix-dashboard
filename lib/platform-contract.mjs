// Account-platform contract shared by collectors and future adapters.
// Keep this list deliberately small: an unimplemented platform must never
// silently fall through to the Douyin collector and contaminate its metrics.
export const SUPPORTED_ACCOUNT_PLATFORMS = Object.freeze(["douyin", "bilibili", "xiaohongshu"]);
export const PLANNED_ACCOUNT_PLATFORMS = Object.freeze(["kuaishou"]);

export function isSupportedAccountPlatform(platform) {
  return SUPPORTED_ACCOUNT_PLATFORMS.includes(String(platform ?? "").trim().toLowerCase());
}

export function platformCapabilityError(platform) {
  const value = String(platform ?? "").trim().toLowerCase() || "未知平台";
  const label = value === "kuaishou" ? "快手" : value;
  return new Error(`${label}账号适配器尚未接入；已保留为待接入平台，不会按抖音采集或写入抖音指标`);
}

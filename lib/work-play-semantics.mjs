/** Explain an observed source field without upgrading it into verified reach. */
export function describeWorkPlays(value, platform = null) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return { basis: "missing", actualCountVerified: false, mayBePlaceholder: null,
      note: "来源未提供有效播放字段，留空不补零；非点赞推算。" };
  }
  const mayBePlaceholder = platform === "douyin" && value === 0 ? true : null;
  return { basis: "source-reported-unverified", actualCountVerified: false, mayBePlaceholder,
    note: mayBePlaceholder
      ? "抖音公开来源返回0，可能是占位值，不能视为实际播放为0；非点赞推算。"
      : "来源上报的播放字段，未经独立核验为实际播放；非点赞推算。" };
}

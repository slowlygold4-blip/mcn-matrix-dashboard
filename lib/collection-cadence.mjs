import { businessDateKey, parseTimeOfDay } from "./utils.mjs";

const HOUR_MS = 60 * 60 * 1000;
const INTERVAL_MS = 8 * HOUR_MS;
const BEIJING_OFFSET_MS = 8 * HOUR_MS;

// An absolute, fixed-duration grid is independent of the host timezone and
// midnight. We catch up only the current slot, never fabricate missed slots.
export function beijingCollectionSlot({ now = new Date(), anchorTime = "10:00" } = {}) {
  const instant = new Date(now).getTime();
  if (!Number.isFinite(instant)) throw new TypeError("采集时隙需要有效时间");
  const time = parseTimeOfDay(anchorTime, "10:00");
  const [hour, minute] = time.split(":").map(Number);
  const anchor = Date.UTC(2000, 0, 1, hour, minute) - BEIJING_OFFSET_MS;
  const startMs = anchor + Math.floor((instant - anchor) / INTERVAL_MS) * INTERVAL_MS;
  const startsAt = new Date(startMs).toISOString();
  const endsAt = new Date(startMs + INTERVAL_MS).toISOString();
  const localTime = new Date(startMs + BEIJING_OFFSET_MS).toISOString().slice(11, 16);
  const slotTimes = [0, 8, 16].map((delta) => `${String((hour + delta) % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`).sort();
  return {
    key: `${businessDateKey(startsAt)}T${localTime}+08:00`,
    startsAt,
    endsAt,
    asOf: new Date(instant).toISOString(),
    intervalHours: 8,
    timeZone: "Asia/Shanghai",
    slotTimes,
  };
}

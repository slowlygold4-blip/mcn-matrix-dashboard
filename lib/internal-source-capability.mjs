import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

export const SOURCE_POLLER_CAPABILITY_HEADER = "x-mcn-source-poller-capability";
export const SOURCE_POLLER_CAPABILITY_FILENAME = ".source-poller-capability";

const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/;

export function isLoopbackAddress(value) {
  let address = String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  address = address.split("%")[0];
  if (address === "::1") return true;
  if (address.startsWith("::ffff:")) address = address.slice(7);
  return isIP(address) === 4 && address.split(".")[0] === "127";
}

export function normalizeLoopbackHttpOrigin(value) {
  let url;
  try { url = new URL(String(value ?? "")); }
  catch { throw new Error("SOURCE_POLL_BASE_URL 必须是本机 loopback HTTP 根地址"); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || url.username || url.password
    || (hostname !== "localhost" && !isLoopbackAddress(hostname))
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SOURCE_POLL_BASE_URL 必须是本机 loopback HTTP 根地址");
  }
  return url.origin;
}

export function sourcePollerCapabilityPath(dataDir) {
  return join(dataDir, "source-poll", SOURCE_POLLER_CAPABILITY_FILENAME);
}

function validatedCapability(value) {
  const capability = String(value ?? "").trim();
  if (!CAPABILITY_PATTERN.test(capability)) {
    throw new Error("内部来源读取凭证缺失或损坏；拒绝接收未经证明的多维表数据");
  }
  return capability;
}

export async function ensureSourcePollerCapability(dataDir) {
  const directory = join(dataDir, "source-poll");
  const path = sourcePollerCapabilityPath(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const existing = validatedCapability(await readFile(path, "utf8"));
    await chmod(path, 0o600);
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const capability = randomBytes(32).toString("hex");
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${capability}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
    return capability;
  } catch (error) {
    // A concurrently starting local service may have created the capability
    // after our first read. Never overwrite it; adopt only a valid 0600 file.
    if (error?.code !== "EEXIST") throw error;
    const existing = validatedCapability(await readFile(path, "utf8"));
    await chmod(path, 0o600);
    return existing;
  }
}

export async function readSourcePollerCapability(dataDir) {
  return validatedCapability(await readFile(sourcePollerCapabilityPath(dataDir), "utf8"));
}

export function capabilityMatches(expected, submitted) {
  const left = String(expected ?? "").trim();
  const right = typeof submitted === "string" ? submitted.trim() : "";
  if (!CAPABILITY_PATTERN.test(left) || !CAPABILITY_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const CHANNEL = "mcn-browser-ownership-v1";
const NONCE_ENV = "MCN_BROWSER_OWNERSHIP_NONCE";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code, name = "Error") => Object.assign(new Error(`浏览器采集未完成（${code}）；未保留进程错误原文`), { code, name });
const SAFE_CODES = new Set(["BROWSER_LANE_LOCKED", "BROWSER_LANE_BUSY", "BROWSER_PLATFORM_UNSUPPORTED", "BROWSER_PROTOCOL_INVALID",
  "BROWSER_OWNERSHIP_CHANGED", "BROWSER_CLEANUP_UNCERTAIN", "BROWSER_OWNERSHIP_UNKNOWN", "BROWSER_COLLECTOR_EXIT",
  "BROWSER_OUTPUT_LIMIT", "BROWSER_SPAWN_FAILED", "BROWSER_COLLECTOR_TIMEOUT"]);
const SAFE_BRANCHES = new Set(["message-authentication-or-sequence", "protocol-state-invalid", "invalid-shutdown-followup",
  "register-identity-mismatch", "release-identity-no-longer-matches", "released-group-still-present", "protocol-handler-failure",
  "registered-leader-exited-before-group", "registered-identity-no-longer-matches", "registered-group-signal-unconfirmed",
  "collector-close-unconfirmed", "registered-group-exit-unconfirmed", "hello-not-observed", "launch-without-registered-owner",
  "protocol-completion-unconfirmed", "successful-exit-without-release"]);
export function safeOwnershipBranch(value) { return SAFE_BRANCHES.has(value) ? value : null; }
export function safeOwnershipFailure(error) {
  if (!SAFE_CODES.has(error?.code)) return null;
  const branch = safeOwnershipBranch(error?.ownershipBranch);
  return Object.assign(failure(error.code), branch ? { ownershipBranch: branch } : {});
}
export function sameRegisteredBrowserIdentity(current, owner) {
  return Boolean(current && !current.absent && owner && current.pid === owner.pid
    && current.group === owner.group && owner.group === owner.pid && current.started === owner.started);
}
const groupExists = pid => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
function identity(pid) {
  return new Promise(resolve => execFile("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart="],
    { timeout: 300, maxBuffer: 2048 }, (error, stdout) => {
      if (error) return resolve(error.code === 1 ? { absent: true } : null);
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(stdout);
      resolve(match ? { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4] } : null);
    }));
}

/** Child-side protocol. Only metadata goes over the private IPC channel. */
export function collectorOwnershipClient() {
  const nonce = process.env[NONCE_ENV];
  if (!nonce) return null; // Standalone invocation retains explicit local cleanup.
  if (!process.send || !process.connected) throw failure("BROWSER_PROTOCOL_UNAVAILABLE");
  let sequence = 0, executionDeadlineNs = null;
  return Object.freeze({
    remainingExecutionMs() {
      if (executionDeadlineNs === null) throw failure("BROWSER_PROTOCOL_INVALID");
      return Math.max(0, Number(executionDeadlineNs - process.hrtime.bigint()) / 1_000_000);
    },
    async send(kind, pid = null) {
    const request = ++sequence;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(failure("BROWSER_PROTOCOL_TIMEOUT")), 1500);
      const handler = message => {
        if (message?.channel !== CHANNEL || message.nonce !== nonce || message.request !== request || message.kind !== "ack") return;
        if (message.ok !== true) return done(failure("BROWSER_PROTOCOL_REJECTED"));
        if (kind === "hello") {
          if (executionDeadlineNs !== null || typeof message.executionDeadlineNs !== "string"
            || !/^[1-9]\d{0,19}$/.test(message.executionDeadlineNs)) return done(failure("BROWSER_PROTOCOL_INVALID"));
          const deadline = BigInt(message.executionDeadlineNs), now = process.hrtime.bigint();
          if (deadline <= now || deadline - now > 850_000_000_000n) return done(failure("BROWSER_PROTOCOL_INVALID"));
          executionDeadlineNs = deadline;
        }
        done(null);
      };
      function done(error) { clearTimeout(timer); process.off("message", handler); error ? reject(error) : resolve(); }
      process.on("message", handler);
      process.send({ channel: CHANNEL, nonce, request, kind, pid }, error => { if (error) done(failure("BROWSER_PROTOCOL_UNAVAILABLE")); });
    });
  } });
}

/** One process-wide browser lane. A cleanup uncertainty cannot be reset by a new Provider. */
export function createOwnedCollectorExecutor() {
  let busy = false, locked = false, lockReason = null;
  let lastLock = null, lastRecovery = null, recoveryProof = null;
  const state = () => ({ busy, locked, reason: lockReason });
  const diagnostics = () => ({ version: 1, ...state(), lastLock: lastLock ? { ...lastLock } : null,
    lastRecovery: lastRecovery ? { ...lastRecovery } : null });
  const laneFailure = code => Object.assign(failure(code), locked && lastLock ? { ownershipBranch: lastLock.branch } : {});
  const recoverConfirmedGroup = () => {
    // No PID signalling or inferred ownership: only a previously registered
    // private group, after its collector closed, may become eligible again.
    if (!locked || busy || lockReason !== "BROWSER_CLEANUP_UNCERTAIN" || !recoveryProof
      || groupExists(recoveryProof.registeredGroupId)) return;
    lastRecovery = { ...recoveryProof, reason: "registered-group-confirmed-absent", recoveredAt: new Date().toISOString() };
    locked = false; lockReason = null; recoveryProof = null;
  };
  function exec(file, args, options, callback) {
    // Complete before returning null so the provider's stdin guard does not
    // replace a precise lane refusal with a generic missing-input error.
    const failBeforeSpawn = code => { callback(laneFailure(code), "", ""); return null; };
    recoverConfirmedGroup();
    if (locked) return failBeforeSpawn("BROWSER_LANE_LOCKED");
    if (busy) return failBeforeSpawn("BROWSER_LANE_BUSY");
    if (!["darwin", "linux"].includes(process.platform)) return failBeforeSpawn("BROWSER_PLATFORM_UNSUPPORTED");
    const { signal, timeout = 150_000, maxBuffer = 24 * 1024 * 1024,
      cleanupTimeoutMs = 3000, terminationGraceMs = 350, ...spawnOptions } = options;
    if (signal?.aborted) { callback(failure("ABORT_ERR", "AbortError"), "", ""); return null; }
    busy = true;
    const nonce = randomUUID(), cleanupBudget = Math.min(cleanupTimeoutMs, Math.max(300, timeout / 2));
    const grace = Math.min(terminationGraceMs, cleanupBudget / 5);
    // Shared OS monotonic clock: launch/import/hello time is not refunded.
    const executionDeadlineNs = process.hrtime.bigint() + BigInt(Math.floor(Math.max(1, timeout - cleanupBudget) * 1_000_000));
    let child;
    try {
      child = spawn(file, args, { ...spawnOptions, env: { ...(options.env ?? process.env), [NONCE_ENV]: nonce },
        detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    } catch { busy = false; return failBeforeSpawn("BROWSER_SPAWN_FAILED"); }
    const decoder = new StringDecoder("utf8");
    let stdout = "", bytes = 0, errorBytes = 0, stopped = false, finished = false, closed = false;
    let hello = false, launching = false, protocolComplete = false, owner = null, released = false, protocolBad = false, lastRequest = 0, shutdownCompleteSeen = false;
    let exitCode = null, exitSignal = null, processing = Promise.resolve(), timer;
    const lock = (code, branch) => {
      // Keep the first explanatory branch; stronger identity/protocol failures
      // can replace a cleanup-only lock, never the reverse.
      if (!locked || (lockReason === "BROWSER_CLEANUP_UNCERTAIN" && code !== lockReason)) {
        locked = true; lockReason = code; recoveryProof = null;
        lastLock = { reason: code, branch, lockedAt: new Date().toISOString(), collectorPid: child.pid,
          registeredGroupId: owner?.group ?? null, collectorClosed: false, recoveryEligible: false };
      }
    };
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (child.connected) { try { child.disconnect(); } catch {} }
      if (locked && lastLock) {
        const eligible = lockReason === "BROWSER_CLEANUP_UNCERTAIN" && !protocolBad && closed && owner;
        lastLock = { ...lastLock, collectorClosed: closed, recoveryEligible: Boolean(eligible) };
        if (eligible) recoveryProof = { collectorPid: child.pid, collectorClosed: true,
          registeredGroupId: owner.group, registeredLeaderStarted: owner.started };
      }
      busy = false;
      if (error && locked && lastLock && SAFE_CODES.has(error.code)) error.ownershipBranch = lastLock.branch;
      callback(error, error ? "" : stdout, "");
    };
    const reply = (message, ok) => { if (child.connected) child.send({ channel: CHANNEL, nonce, request: message.request, kind: "ack", ok,
      ...(ok && message.kind === "hello" ? { executionDeadlineNs: String(executionDeadlineNs) } : {}) }, () => {}); };
    child.on("message", message => {
      processing = processing.then(async () => {
        if (finished) return;
        let valid = message?.channel === CHANNEL && message.nonce === nonce && Number.isSafeInteger(message.request) && message.request === lastRequest + 1;
        if (stopped) {
          // The child may finish its known cleanup or send catch-path complete
          // after a rejected release. No new launch/owner or invalid IPC is
          // tolerated, and no shutdown follow-up can turn failure into success.
          const cleanupFollowup = valid && (message.kind === "released" && owner && message.pid === owner.pid && !released
            || message.kind === "complete" && hello && !shutdownCompleteSeen && ((!launching && !owner) || owner));
          if (cleanupFollowup) { lastRequest = message.request; if (message.kind === "complete") shutdownCompleteSeen = true; }
          else { protocolBad = true; lock("BROWSER_PROTOCOL_INVALID", "invalid-shutdown-followup"); }
          reply(message ?? {}, false); return;
        }
        let branch = valid ? "protocol-state-invalid" : "message-authentication-or-sequence";
        if (valid && message.kind === "hello" && !hello && !launching) hello = true;
        else if (valid && message.kind === "launch" && hello && !launching && !stopped && !protocolComplete) launching = true;
        else if (valid && message.kind === "register" && launching && !owner && !stopped && Number.isSafeInteger(message.pid) && message.pid > 1 && message.pid !== child.pid) {
          const proof = await identity(message.pid);
          valid = Boolean(!stopped && proof && !proof.absent && proof.parent === child.pid && proof.pid === proof.group && child.exitCode === null && child.signalCode === null);
          branch = "register-identity-mismatch";
          if (valid) owner = proof;
        } else if (valid && message.kind === "released" && owner && message.pid === owner.pid && !released) {
          if (groupExists(owner.group)) {
            const current = await identity(owner.pid);
            if (!current?.absent && !sameRegisteredBrowserIdentity(current, owner)) {
              protocolBad = true; lock("BROWSER_OWNERSHIP_CHANGED", "release-identity-no-longer-matches");
              reply(message, false); void stop(failure("BROWSER_OWNERSHIP_CHANGED")); return;
            }
          }
          // Playwright can reap the leader before the rest of its private group
          // finishes exiting. Stay below the client's 1.5s IPC ACK deadline.
          const waitUntil = process.hrtime.bigint() + 1_000_000_000n;
          while (!stopped && groupExists(owner.group) && process.hrtime.bigint() < waitUntil
            && process.hrtime.bigint() < executionDeadlineNs) await sleep(25);
          if (stopped) { lastRequest = message.request; reply(message, false); return; }
          valid = !groupExists(owner.group);
          if (valid) released = true;
          else {
            lastRequest = message.request;
            lock("BROWSER_CLEANUP_UNCERTAIN", "released-group-still-present");
            reply(message, false); void stop(failure("BROWSER_CLEANUP_UNCERTAIN")); return;
          }
        } else if (valid && message.kind === "complete" && !protocolComplete && hello && ((!launching && !owner) || (owner && released))) protocolComplete = true;
        else valid = false;
        if (valid) lastRequest = message.request;
        reply(message ?? {}, valid);
        if (!valid) { protocolBad = true; lock("BROWSER_PROTOCOL_INVALID", branch); void stop(failure("BROWSER_PROTOCOL_INVALID")); }
      }).catch(() => { protocolBad = true; lock("BROWSER_PROTOCOL_INVALID", "protocol-handler-failure"); void stop(failure("BROWSER_PROTOCOL_INVALID")); });
    });
    async function killRegisteredGroup() {
      if (!owner || released || !groupExists(owner.group)) return;
      const current = await identity(owner.pid);
      if (current?.absent) {
        // Leader absence is not permission to kill a group. Its known tail may
        // finish naturally; keep it locked until the whole group is gone.
        lock("BROWSER_CLEANUP_UNCERTAIN", "registered-leader-exited-before-group"); return;
      }
      if (!sameRegisteredBrowserIdentity(current, owner)) {
        protocolBad = true; lock("BROWSER_OWNERSHIP_CHANGED", "registered-identity-no-longer-matches"); return;
      }
      // Registration established this private group while its leader was a
      // direct child. Once observed absent/released, it is never signalled again.
      try { process.kill(-owner.group, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") lock("BROWSER_CLEANUP_UNCERTAIN", "registered-group-signal-unconfirmed"); }
    }
    async function stop(reason = null) {
      if (stopped) return;
      stopped = true; clearTimeout(timer);
      const deadlineNs = process.hrtime.bigint() + BigInt(Math.floor(cleanupBudget * 1_000_000));
      await processing;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await sleep(grace);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await sleep(grace);
      await killRegisteredGroup();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      while (process.hrtime.bigint() < deadlineNs && (!closed || (owner && !released && groupExists(owner.group)))) await sleep(25);
      if (!closed || (owner && !released && groupExists(owner.group))) lock("BROWSER_CLEANUP_UNCERTAIN", !closed ? "collector-close-unconfirmed" : "registered-group-exit-unconfirmed");
      if (!hello || (launching && !owner) || (!reason && !protocolComplete)) lock("BROWSER_OWNERSHIP_UNKNOWN",
        !hello ? "hello-not-observed" : launching && !owner ? "launch-without-registered-owner" : "protocol-completion-unconfirmed");
      if (locked) return finish(failure(lockReason));
      if (reason) return finish(reason);
      if (exitCode !== 0 || exitSignal) return finish(failure("BROWSER_COLLECTOR_EXIT"));
      if (!owner || !released) { lock("BROWSER_OWNERSHIP_UNKNOWN", "successful-exit-without-release"); return finish(failure(lockReason)); }
      finish(null);
    }
    const onAbort = () => { void stop(failure("ABORT_ERR", "AbortError")); };
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > maxBuffer) void stop(failure("BROWSER_OUTPUT_LIMIT")); else stdout += decoder.write(chunk); });
    child.stderr.on("data", chunk => { errorBytes += chunk.length; if (errorBytes > maxBuffer) void stop(failure("BROWSER_OUTPUT_LIMIT")); });
    child.stdin.on("error", () => {});
    child.once("error", () => { if (!child.pid) finish(failure("BROWSER_SPAWN_FAILED")); else void stop(failure("BROWSER_COLLECTOR_EXIT")); });
    child.once("exit", (code, kind) => { exitCode = code; exitSignal = kind; void stop(); });
    child.once("close", () => { stdout += decoder.end(); closed = true; });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => { void stop(failure("BROWSER_COLLECTOR_TIMEOUT")); }, Math.max(1, Number(executionDeadlineNs - process.hrtime.bigint()) / 1_000_000));
    return child;
  }
  return { exec, state, diagnostics };
}

export const ownedCollectorExecutor = createOwnedCollectorExecutor();

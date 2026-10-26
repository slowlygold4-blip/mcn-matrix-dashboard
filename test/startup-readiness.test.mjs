import assert from "node:assert/strict";
import test from "node:test";
import { startupApiGate } from "../lib/startup-readiness.mjs";

test("startup readiness exposes only a non-ready health result until migration completes", () => {
  assert.deepEqual(startupApiGate({ status: "starting", message: "正在迁移" }, "/api/health", "GET"), {
    statusCode: 503,
    body: { ok: false, status: "starting", version: "1.3.0", runtimeAI: false, message: "正在迁移" },
  });
  const blocked = startupApiGate({ status: "starting" }, "/api/reports/day", "GET");
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.body.code, "SERVICE_STARTING");
  assert.equal(JSON.stringify(blocked.body).includes("target"), false, "startup responses must not expose report or target data");
  assert.equal(startupApiGate({ status: "ready" }, "/api/reports/day", "GET"), null);
  assert.equal(startupApiGate({ status: "ready" }, "/api/health", "GET").statusCode, 200);
});

test("failed startup keeps every business API closed", () => {
  const health = startupApiGate({ status: "failed", message: "备份失败" }, "/api/health", "GET");
  assert.equal(health.statusCode, 503);
  assert.equal(health.body.status, "failed");
  const business = startupApiGate({ status: "failed", message: "备份失败" }, "/api/bootstrap", "GET");
  assert.equal(business.statusCode, 503);
  assert.equal(business.body.code, "SERVICE_STARTUP_FAILED");
});

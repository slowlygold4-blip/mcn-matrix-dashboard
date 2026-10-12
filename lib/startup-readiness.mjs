const STARTUP_STATUSES = new Set(["starting", "ready", "failed"]);

function normalizedState(value) {
  const status = STARTUP_STATUSES.has(String(value?.status)) ? String(value.status) : "starting";
  return {
    status,
    message: String(value?.message ?? "").trim().slice(0, 300),
  };
}

export function startupApiGate(value, pathname, method = "GET") {
  const state = normalizedState(value);
  if (method === "GET" && pathname === "/api/health") {
    return {
      statusCode: state.status === "ready" ? 200 : 503,
      body: {
        ok: state.status === "ready",
        status: state.status,
        version: "1.3.0",
        runtimeAI: false,
        ...(state.message ? { message: state.message } : {}),
      },
    };
  }
  if (state.status === "ready") return null;
  return {
    statusCode: 503,
    body: {
      ok: false,
      status: state.status,
      code: state.status === "failed" ? "SERVICE_STARTUP_FAILED" : "SERVICE_STARTING",
      error: state.message || (state.status === "failed" ? "服务初始化失败" : "服务正在完成启动备份与严格身份迁移，请稍后重试"),
    },
  };
}

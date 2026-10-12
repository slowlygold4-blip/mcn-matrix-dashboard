import test from "node:test";
import assert from "node:assert/strict";
import { AccessControl, requestProtocol } from "../lib/access-control.mjs";

const access = new AccessControl({}, { port: 4188 });

function request(headers = {}) {
  return { socket: { encrypted: false, remoteAddress: "127.0.0.1" }, headers: { host: "public.example", ...headers } };
}

test("join rate limits trusted tunnel visitors independently", () => {
  const previous = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "cloudflare";
  try {
    const limiter = new AccessControl({}, { port: 4188 });
    const visitor = (ip) => request({ "cf-ray": "fixture-ray", "cf-connecting-ip": ip });
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.rateLimitJoin(visitor("203.0.113.10"));
    assert.throws(() => limiter.rateLimitJoin(visitor("203.0.113.10")), (error) => error.status === 429);
    assert.doesNotThrow(() => limiter.rateLimitJoin(visitor("203.0.113.11")));
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.rateLimitJoin(visitor("203.0.113.10, 203.0.113.11"));
    assert.throws(() => limiter.rateLimitJoin(visitor("203.0.113.12, 203.0.113.13")), (error) => error.status === 429);
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
});

test("trusted Cloudflare HTTPS forwarding satisfies same-origin checks", () => {
  const previous = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "cloudflare";
  try {
    const forwarded = request({
      origin: "https://public.example",
      "sec-fetch-site": "same-origin",
      "cf-ray": "test-ray",
      "cf-connecting-ip": "203.0.113.10",
      "x-forwarded-proto": "https",
    });
    assert.equal(requestProtocol(forwarded), "https");
    assert.doesNotThrow(() => access.assertSameOrigin(forwarded));
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
});

test("untrusted forwarded headers cannot bypass same-origin checks", () => {
  const previous = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "cloudflare";
  try {
    const forged = request({ origin: "https://public.example", "x-forwarded-proto": "https" });
    assert.equal(requestProtocol(forged), "http");
    assert.throws(() => access.assertSameOrigin(forged), (error) => error?.code === "origin_mismatch");
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
});

test("Cloudflare scheme is not trusted from a non-loopback peer", () => {
  const previous = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "cloudflare";
  try {
    const forged = {
      socket: { encrypted: false, remoteAddress: "203.0.113.10" },
      headers: {
        host: "public.example",
        "cf-ray": "forged",
        "cf-connecting-ip": "203.0.113.10",
        "x-forwarded-proto": "https",
      },
    };
    assert.equal(requestProtocol(forged), "http");
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
});

test("a local-owner session cannot cross the public tunnel", () => {
  const database = {
    getSession: () => ({
      user: { id: 1, role: "admin", authSource: "local-owner", displayName: "本机管理员" },
      csrfToken: "csrf",
      absoluteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  };
  const control = new AccessControl(database, { port: 4188 });
  const publicRequest = {
    socket: { encrypted: false, remoteAddress: "127.0.0.1" },
    headers: {
      host: "public.example",
      cookie: "douyin_monitor_session=stale-owner-token",
      "cf-ray": "test-ray",
      "cf-connecting-ip": "203.0.113.10",
      "x-forwarded-proto": "https",
    },
  };
  assert.throws(() => control.authenticate(publicRequest, { setHeader() {} }), (error) => error?.status === 401 && error?.code === "authentication_required");
});

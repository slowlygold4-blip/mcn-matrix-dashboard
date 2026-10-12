const PROXY_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
];
const LOOPBACK_BYPASS = "localhost,127.0.0.1,::1";

/** Validate only an explicit, credential-free local HTTP proxy address. */
export function validatedIdentityProxyUrl(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = typeof value === "string"
    ? /^http:\/\/(127\.0\.0\.1|localhost):([1-9]\d{0,4})\/?$/.exec(value)
    : null;
  if (!match || Number(match[2]) > 65_535) {
    const error = new Error("原作品身份核验代理配置无效：仅允许无凭据的本机 HTTP 地址和有效端口");
    error.code = "INVALID_IDENTITY_PROXY_CONFIG";
    throw error;
  }
  return `http://${match[1]}:${match[2]}`;
}

/** Return a child-only environment; never mutate inherited process settings. */
export function identityProxyEnvironment(environment = process.env) {
  const proxyUrl = validatedIdentityProxyUrl(environment.DOUYIN_IDENTITY_PROXY_URL);
  if (!proxyUrl) return undefined;
  return {
    ...environment,
    ...Object.fromEntries(PROXY_KEYS.map((key) => [key, proxyUrl])),
    NO_PROXY: LOOPBACK_BYPASS,
    no_proxy: LOOPBACK_BYPASS,
  };
}

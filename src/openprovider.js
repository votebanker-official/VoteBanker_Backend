/**
 * Openprovider REST client with bearer-token caching.
 * Credentials stay in process.env; never log tokens or passwords.
 */

const DEFAULT_BASE_URL = "https://api.openprovider.eu/v1";
const DEFAULT_TOKEN_TTL_MS = 55 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

function readConfig(env = process.env) {
  const username = String(env.OPENPROVIDER_USERNAME || "").trim();
  const password = String(env.OPENPROVIDER_PASSWORD || "");
  const baseUrl = String(env.OPENPROVIDER_BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const ip = String(env.OPENPROVIDER_IP || "0.0.0.0").trim() || "0.0.0.0";
  const timeoutMs = Number(env.OPENPROVIDER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  if (!username || !password) {
    return { error: "openprovider_not_configured" };
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    return { error: "openprovider_invalid_base_url" };
  }

  return { username, password, baseUrl, ip, timeoutMs };
}

function tokenExpiryMs(token, now = Date.now()) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) {
      return now + DEFAULT_TOKEN_TTL_MS;
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload && typeof payload.exp === "number") {
      // Refresh a minute before the real expiry when possible.
      return Math.max(now + 5_000, payload.exp * 1000 - 60_000);
    }
  } catch {
    // Fall through to the default TTL.
  }
  return now + DEFAULT_TOKEN_TTL_MS;
}

function createOpenproviderClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const nowFn = options.now || Date.now;

  let cachedToken = null;
  let tokenExpiresAt = 0;
  let loginInFlight = null;

  function configOrThrow() {
    const config = readConfig(env);
    if (config.error) {
      const error = new Error(config.error);
      error.code = config.error;
      throw error;
    }
    return config;
  }

  async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error && error.name === "AbortError") {
        const timeout = new Error("openprovider_timeout");
        timeout.code = "openprovider_timeout";
        throw timeout;
      }
      const network = new Error("openprovider_unreachable");
      network.code = "openprovider_unreachable";
      throw network;
    } finally {
      clearTimeout(timer);
    }
  }

  async function login({ force = false } = {}) {
    const config = configOrThrow();
    const now = nowFn();
    if (!force && cachedToken && now < tokenExpiresAt) {
      return cachedToken;
    }

    if (loginInFlight && !force) {
      return loginInFlight;
    }

    loginInFlight = (async () => {
      const response = await fetchWithTimeout(
        `${config.baseUrl}/auth/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            username: config.username,
            password: config.password,
            ip: config.ip,
          }),
        },
        config.timeoutMs
      );

      let body;
      try {
        body = await response.json();
      } catch {
        const error = new Error("openprovider_auth_failed");
        error.code = "openprovider_auth_failed";
        throw error;
      }

      const token = body && body.data && body.data.token;
      if (!response.ok || body.code !== 0 || !token) {
        const error = new Error("openprovider_auth_failed");
        error.code = "openprovider_auth_failed";
        throw error;
      }

      cachedToken = String(token);
      tokenExpiresAt = tokenExpiryMs(cachedToken, nowFn());
      return cachedToken;
    })();

    try {
      return await loginInFlight;
    } finally {
      loginInFlight = null;
    }
  }

  function clearToken() {
    cachedToken = null;
    tokenExpiresAt = 0;
  }

  async function request(path, { method = "GET", body, retryOnAuth = true } = {}) {
    const config = configOrThrow();
    const token = await login();
    const response = await fetchWithTimeout(
      `${config.baseUrl}${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      config.timeoutMs
    );

    let payload;
    try {
      payload = await response.json();
    } catch {
      const error = new Error("openprovider_bad_response");
      error.code = "openprovider_bad_response";
      throw error;
    }

    if (response.status === 401 && retryOnAuth) {
      clearToken();
      await login({ force: true });
      return request(path, { method, body, retryOnAuth: false });
    }

    return { response, payload };
  }

  async function checkDomains(domains) {
    const { response, payload } = await request("/domains/check", {
      method: "POST",
      body: {
        domains,
        with_price: true,
      },
    });

    if (!response.ok || !payload || payload.code !== 0 || !payload.data) {
      const upstreamCode = payload && payload.code;
      // 10005 = calling IP blocked by Openprovider whitelist/blacklist.
      const code =
        upstreamCode === 10005
          ? "openprovider_access_denied"
          : "openprovider_check_failed";
      const error = new Error(code);
      error.code = code;
      error.upstreamCode = upstreamCode;
      throw error;
    }

    const results = payload.data.results;
    if (!Array.isArray(results)) {
      const error = new Error("openprovider_bad_response");
      error.code = "openprovider_bad_response";
      throw error;
    }

    return results;
  }

  return {
    readConfig: () => readConfig(env),
    login,
    clearToken,
    request,
    checkDomains,
    // Test helpers
    _getCachedTokenState: () => ({ token: cachedToken, expiresAt: tokenExpiresAt }),
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  createOpenproviderClient,
  readConfig,
  tokenExpiryMs,
};

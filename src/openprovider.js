/**
 * Openprovider REST client with bearer-token caching.
 * Credentials stay in process.env; never log tokens or passwords.
 */

const DEFAULT_BASE_URL = "https://api.openprovider.eu/v1";
const DEFAULT_TOKEN_TTL_MS = 55 * 60 * 1000;
// Per-request timeout. Full-catalog searches issue many parallel checks.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TLD_CACHE_MS = 12 * 60 * 60 * 1000;

function readConfig(env = process.env) {
  const username = String(env.OPENPROVIDER_USERNAME || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  const password = String(env.OPENPROVIDER_PASSWORD || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  const baseUrl = String(env.OPENPROVIDER_BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  // Always 0.0.0.0 for login. Setting a home/office IP here breaks Railway:
  // the token becomes bound to that IP while requests leave from Railway's IP.
  const ip = "0.0.0.0";
  const timeoutMs = Number(env.OPENPROVIDER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  if (!username || !password) {
    return { error: "openprovider_not_configured" };
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    return { error: "openprovider_invalid_base_url" };
  }

  return { username, password, baseUrl, ip, timeoutMs };
}

async function detectEgressIp(fetchImpl = fetch, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("https://api.ipify.org?format=json", {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    const ip = body && typeof body.ip === "string" ? body.ip.trim() : "";
    return ip || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mapUpstreamFailure(payload, fallback = "openprovider_check_failed") {
  const upstreamCode = payload && payload.code;
  if (upstreamCode === 10005) {
    return "openprovider_access_denied";
  }
  return fallback;
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
        const code = mapUpstreamFailure(body, "openprovider_auth_failed");
        const error = new Error(code);
        error.code = code;
        error.upstreamCode = body && body.code;
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

  async function checkDomains(domains, { withPrice = true } = {}) {
    const { response, payload } = await request("/domains/check", {
      method: "POST",
      body: {
        domains,
        with_price: Boolean(withPrice),
      },
    });

    if (!response.ok || !payload || payload.code !== 0 || !payload.data) {
      const code = mapUpstreamFailure(payload, "openprovider_check_failed");
      const error = new Error(code);
      error.code = code;
      error.upstreamCode = payload && payload.code;
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

  let tldCache = null;
  let tldCacheExpiresAt = 0;

  async function listActiveTldNames({ force = false } = {}) {
    const now = nowFn();
    if (!force && tldCache && now < tldCacheExpiresAt) {
      return tldCache;
    }

    const names = [];
    let offset = 0;
    for (let page = 0; page < 50; page += 1) {
      const { response, payload } = await request(
        `/tlds?limit=500&offset=${offset}`,
        { method: "GET" }
      );
      if (!response.ok || !payload || payload.code !== 0 || !payload.data) {
        const error = new Error("openprovider_tld_list_failed");
        error.code = "openprovider_tld_list_failed";
        throw error;
      }
      const results = Array.isArray(payload.data.results) ? payload.data.results : [];
      const total = Number(payload.data.total);
      for (const entry of results) {
        const name = entry && entry.name != null ? String(entry.name).trim().toLowerCase() : "";
        if (name) {
          names.push(name);
        }
      }
      if (!results.length || results.length < 500 || (Number.isFinite(total) && names.length >= total)) {
        break;
      }
      offset += results.length;
    }

    const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b));
    tldCache = unique;
    tldCacheExpiresAt = now + DEFAULT_TLD_CACHE_MS;
    return unique;
  }

  return {
    readConfig: () => readConfig(env),
    login,
    clearToken,
    request,
    checkDomains,
    listActiveTldNames,
    // Test helpers
    _getCachedTokenState: () => ({ token: cachedToken, expiresAt: tokenExpiresAt }),
    _setTldCacheForTests: (names, expiresAt = Date.now() + DEFAULT_TLD_CACHE_MS) => {
      tldCache = names;
      tldCacheExpiresAt = expiresAt;
    },
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  createOpenproviderClient,
  detectEgressIp,
  mapUpstreamFailure,
  readConfig,
  tokenExpiryMs,
};

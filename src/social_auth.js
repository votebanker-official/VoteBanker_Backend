const crypto = require("crypto");

const PROVIDERS = new Set(["facebook", "instagram"]);
const TICKET_TTL_MS = 2 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

function isProvider(value) {
  return PROVIDERS.has(value);
}

function appCredentials(provider, env = process.env) {
  if (provider === "facebook") {
    return { id: env.META_APP_ID || "", secret: env.META_APP_SECRET || "" };
  }
  if (provider === "instagram") {
    return {
      id: env.INSTAGRAM_APP_ID || env.META_APP_ID || "",
      secret: env.INSTAGRAM_APP_SECRET || env.META_APP_SECRET || "",
    };
  }
  return { id: "", secret: "" };
}

function providerConfigured(provider, env = process.env) {
  const { id, secret } = appCredentials(provider, env);
  return Boolean(id && secret);
}

function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readState(token, secret, now = Date.now()) {
  if (typeof token !== "string" || !secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < now || !isProvider(payload.provider)) {
    return null;
  }
  if (typeof payload.returnTo !== "string") return null;
  return payload;
}

function allowedOrigins(env = process.env) {
  const origins = new Set();
  for (const raw of [env.FRONTEND_URL, ...(env.CORS_ORIGINS || "").split(",")]) {
    const value = String(raw || "").trim();
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Ignore a malformed origin rather than allowing it.
    }
  }
  return origins;
}

function safeReturnTo(input, env = process.env) {
  let url;
  try {
    url = new URL(String(input || ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url.origin);
  const allowed = allowedOrigins(env);
  if (!local && !allowed.has(url.origin)) return null;
  return `${url.origin}/`;
}

function callbackUrl(req, env = process.env) {
  const configured = String(env.PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  if (configured) return `${configured}/api/auth/oauth/callback`;
  return `${req.protocol}://${req.get("host")}/api/auth/oauth/callback`;
}

function authorizeUrl(provider, { clientId, redirectUri, state }) {
  if (provider === "facebook") {
    const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "public_profile,email");
    return url.toString();
  }
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "instagram_business_basic");
  url.searchParams.set("enable_fb_login", "0");
  return url.toString();
}

function createTicketStore(now = () => Date.now()) {
  const tickets = new Map();
  return {
    issue(session) {
      const ticket = crypto.randomBytes(32).toString("hex");
      tickets.set(ticket, { session, exp: now() + TICKET_TTL_MS });
      return ticket;
    },
    take(ticket) {
      const row = tickets.get(String(ticket || ""));
      if (row) tickets.delete(ticket);
      if (!row || row.exp < now()) return null;
      return row.session;
    },
  };
}

function cleanAuthCode(code) {
  return String(code || "").replace(/#_$/, "").trim();
}

async function fetchJson(url, options, fetchImpl = global.fetch) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const error = new Error("provider_rejected");
    error.code = "provider_rejected";
    throw error;
  }
  return body;
}

async function exchangeFacebookCode({ code, redirectUri, clientId, clientSecret, fetchImpl }) {
  const tokenUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
  tokenUrl.searchParams.set("client_id", clientId);
  tokenUrl.searchParams.set("client_secret", clientSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", cleanAuthCode(code));
  const token = await fetchJson(tokenUrl, { method: "GET" }, fetchImpl);
  if (!token.access_token) {
    const error = new Error("provider_rejected");
    error.code = "provider_rejected";
    throw error;
  }
  const profileUrl = new URL("https://graph.facebook.com/v21.0/me");
  profileUrl.searchParams.set("fields", "id,name,email");
  profileUrl.searchParams.set("access_token", token.access_token);
  const profile = await fetchJson(profileUrl, { method: "GET" }, fetchImpl);
  if (!profile.id) {
    const error = new Error("provider_rejected");
    error.code = "provider_rejected";
    throw error;
  }
  return {
    provider: "facebook",
    providerUserId: String(profile.id),
    name: profile.name || "",
    email: profile.email || "",
  };
}

async function exchangeInstagramCode({ code, redirectUri, clientId, clientSecret, fetchImpl }) {
  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", redirectUri);
  form.set("code", cleanAuthCode(code));
  const token = await fetchJson(
    "https://api.instagram.com/oauth/access_token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    fetchImpl
  );
  const row = Array.isArray(token.data) ? token.data[0] : token;
  const accessToken = row && row.access_token;
  const userId = row && (row.user_id || row.userId);
  if (!accessToken || !userId) {
    const error = new Error("provider_rejected");
    error.code = "provider_rejected";
    throw error;
  }
  let name = "";
  try {
    const profileUrl = new URL("https://graph.instagram.com/v21.0/me");
    profileUrl.searchParams.set("fields", "user_id,username,name");
    profileUrl.searchParams.set("access_token", accessToken);
    const profile = await fetchJson(profileUrl, { method: "GET" }, fetchImpl);
    name = profile.username || profile.name || "";
  } catch {
    name = "";
  }
  return {
    provider: "instagram",
    providerUserId: String(userId),
    name,
    email: "",
  };
}

module.exports = {
  STATE_TTL_MS,
  isProvider,
  appCredentials,
  providerConfigured,
  signState,
  readState,
  safeReturnTo,
  callbackUrl,
  authorizeUrl,
  createTicketStore,
  exchangeFacebookCode,
  exchangeInstagramCode,
};

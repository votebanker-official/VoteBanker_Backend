const crypto = require("crypto");

const {
  STATE_TTL_MS,
  appCredentials,
  callbackUrl,
  isConnectProvider,
  providerConfigured,
  safeReturnTo,
  signState,
} = require("./social_auth");

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeConnectReturn(input, env = process.env) {
  const originOnly = safeReturnTo(input, env);
  if (!originOnly) return null;
  let url;
  try {
    url = new URL(String(input || ""));
  } catch {
    return null;
  }
  const path = url.pathname === "/social" ? "/social" : "/";
  return `${new URL(originOnly).origin}${path}`;
}

function tokenKey(env = process.env) {
  const raw = env.SOCIAL_TOKEN_KEY || env.SUPABASE_SECRET_KEY || "";
  if (!raw) return null;
  return crypto.createHash("sha256").update(`votebanker-social-tokens:${raw}`).digest();
}

function encryptToken(plain, env = process.env) {
  const value = String(plain || "");
  if (!value) return "";
  const key = tokenKey(env);
  if (!key) throw coded("token_key_missing");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

function decryptToken(packed, env = process.env) {
  const value = String(packed || "");
  if (!value) return "";
  const key = tokenKey(env);
  if (!key) throw coded("token_key_missing");
  const buf = Buffer.from(value, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function connectionConfigured(provider, env = process.env) {
  if (provider === "whatsapp") {
    return providerConfigured("facebook", env) && Boolean(String(env.WHATSAPP_CONFIG_ID || "").trim());
  }
  if (provider === "x") {
    return Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET);
  }
  if (provider === "youtube" || provider === "email") {
    return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  }
  return providerConfigured(provider, env);
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function connectAuthorizeUrl(provider, { clientId, redirectUri, state, env = process.env, codeChallenge, configId }) {
  if (provider === "facebook") {
    const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set(
      "scope",
      "pages_show_list,pages_read_engagement,business_management"
    );
    return url.toString();
  }
  if (provider === "instagram") {
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "instagram_business_basic");
    url.searchParams.set("enable_fb_login", "0");
    return url.toString();
  }
  if (provider === "whatsapp") {
    const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("config_id", configId || env.WHATSAPP_CONFIG_ID || "");
    url.searchParams.set("override_default_response_type", "true");
    url.searchParams.set(
      "extras",
      JSON.stringify({ setup: {}, featureType: "", sessionInfoVersion: "3" })
    );
    return url.toString();
  }
  if (provider === "x") {
    const url = new URL("https://twitter.com/i/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "tweet.read users.read offline.access");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set(
    "scope",
    provider === "youtube"
      ? "https://www.googleapis.com/auth/youtube.readonly"
      : "openid email profile"
  );
  return url.toString();
}

function publicConnection(row) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    provider: row.provider,
    status: row.status || "connected",
    accountId: row.account_id || "",
    accountName: row.account_name || "",
    accountUsername: row.account_username || "",
    detail: metadata.detail || "",
    phoneNumberId: metadata.phoneNumberId || "",
    wabaId: metadata.wabaId || "",
    pageId: metadata.pageId || "",
  };
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
  if (!response.ok) throw coded("provider_rejected");
  return body;
}

async function exchangeProvider(provider, args) {
  if (provider === "facebook") return exchangeFacebookPage(args);
  if (provider === "instagram") return exchangeInstagramAccount(args);
  if (provider === "whatsapp") return exchangeWhatsApp(args);
  if (provider === "x") return exchangeX(args);
  if (provider === "youtube") return exchangeYouTube(args);
  if (provider === "email") return exchangeGoogleEmail(args);
  throw coded("not_found");
}

async function exchangeFacebookPage({ code, redirectUri, clientId, clientSecret, fetchImpl }) {
  const tokenUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
  tokenUrl.searchParams.set("client_id", clientId);
  tokenUrl.searchParams.set("client_secret", clientSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", String(code || "").replace(/#_$/, "").trim());
  const token = await fetchJson(tokenUrl, { method: "GET" }, fetchImpl);
  if (!token.access_token) throw coded("provider_rejected");
  const pagesUrl = new URL("https://graph.facebook.com/v21.0/me/accounts");
  pagesUrl.searchParams.set("fields", "id,name,access_token");
  pagesUrl.searchParams.set("access_token", token.access_token);
  const pages = await fetchJson(pagesUrl, { method: "GET" }, fetchImpl);
  const page = Array.isArray(pages.data) ? pages.data[0] : null;
  if (!page || !page.id) throw coded("no_page");
  return {
    accountId: String(page.id),
    accountName: page.name || "Facebook Page",
    accountUsername: "",
    accessToken: page.access_token || token.access_token,
    refreshToken: "",
    expiresAt: null,
    scopes: "pages_show_list,pages_read_engagement",
    metadata: {
      pageId: String(page.id),
      detail: "Facebook Page. Personal profile publishing is not used.",
    },
  };
}

async function exchangeInstagramAccount({ code, redirectUri, clientId, clientSecret, fetchImpl }) {
  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", redirectUri);
  form.set("code", String(code || "").replace(/#_$/, "").trim());
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
  if (!accessToken || !userId) throw coded("provider_rejected");
  const profileUrl = new URL("https://graph.instagram.com/v21.0/me");
  profileUrl.searchParams.set("fields", "user_id,username,name,account_type");
  profileUrl.searchParams.set("access_token", accessToken);
  const profile = await fetchJson(profileUrl, { method: "GET" }, fetchImpl);
  if (String(profile.account_type || "").toUpperCase() === "PERSONAL") {
    throw coded("professional_required");
  }
  const username = profile.username || profile.name || "";
  if (!username) throw coded("provider_rejected");
  return {
    accountId: String(profile.user_id || userId),
    accountName: profile.name || username,
    accountUsername: profile.username || "",
    accessToken,
    refreshToken: "",
    expiresAt: null,
    scopes: "instagram_business_basic",
    metadata: { detail: "Professional Instagram account" },
  };
}

async function exchangeWhatsApp({ code, redirectUri, clientId, clientSecret, fetchImpl }) {
  const tokenUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
  tokenUrl.searchParams.set("client_id", clientId);
  tokenUrl.searchParams.set("client_secret", clientSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", String(code || "").replace(/#_$/, "").trim());
  const token = await fetchJson(tokenUrl, { method: "GET" }, fetchImpl);
  if (!token.access_token) throw coded("provider_rejected");
  const debugUrl = new URL("https://graph.facebook.com/v21.0/debug_token");
  debugUrl.searchParams.set("input_token", token.access_token);
  debugUrl.searchParams.set("access_token", `${clientId}|${clientSecret}`);
  const debug = await fetchJson(debugUrl, { method: "GET" }, fetchImpl);
  const granular = (debug.data && debug.data.granular_scopes) || [];
  const scope = granular.find(
    (item) =>
      item &&
      (item.scope === "whatsapp_business_management" || item.scope === "whatsapp_business_messaging") &&
      Array.isArray(item.target_ids) &&
      item.target_ids.length
  );
  const wabaId = scope && scope.target_ids[0];
  if (!wabaId) throw coded("whatsapp_incomplete");
  const phonesUrl = new URL(`https://graph.facebook.com/v21.0/${wabaId}/phone_numbers`);
  phonesUrl.searchParams.set("access_token", token.access_token);
  const phones = await fetchJson(phonesUrl, { method: "GET" }, fetchImpl);
  const phone = Array.isArray(phones.data) ? phones.data[0] : null;
  if (!phone || !phone.id) throw coded("whatsapp_incomplete");
  const display = phone.display_phone_number || phone.verified_name || "";
  return {
    accountId: String(phone.id),
    accountName: phone.verified_name || display || "WhatsApp Business",
    accountUsername: display,
    accessToken: token.access_token,
    refreshToken: "",
    expiresAt: null,
    scopes: "whatsapp_business_management",
    metadata: {
      phoneNumberId: String(phone.id),
      wabaId: String(wabaId),
      detail:
        "WhatsApp Business messaging. This does not publish WhatsApp Status.",
    },
  };
}

async function exchangeX({ code, redirectUri, clientId, clientSecret, codeVerifier, fetchImpl }) {
  const form = new URLSearchParams();
  form.set("code", String(code || "").trim());
  form.set("grant_type", "authorization_code");
  form.set("client_id", clientId);
  form.set("redirect_uri", redirectUri);
  form.set("code_verifier", codeVerifier || "");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const token = await fetchJson(
    "https://api.twitter.com/2/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: form.toString(),
    },
    fetchImpl
  );
  if (!token.access_token) throw coded("provider_rejected");
  const me = await fetchJson("https://api.twitter.com/2/users/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${token.access_token}` },
  }, fetchImpl);
  const user = me.data || {};
  if (!user.id) throw coded("provider_rejected");
  return {
    accountId: String(user.id),
    accountName: user.name || user.username || "X",
    accountUsername: user.username || "",
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
    scopes: token.scope || "tweet.read users.read",
    metadata: { detail: "X account" },
  };
}

async function googleToken({ code, redirectUri, clientId, clientSecret, fetchImpl }) {
  const form = new URLSearchParams();
  form.set("code", String(code || "").trim());
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  form.set("redirect_uri", redirectUri);
  form.set("grant_type", "authorization_code");
  const token = await fetchJson(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    fetchImpl
  );
  if (!token.access_token) throw coded("provider_rejected");
  return token;
}

async function exchangeYouTube(args) {
  const token = await googleToken(args);
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");
  const data = await fetchJson(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token.access_token}` },
  }, args.fetchImpl);
  const channel = Array.isArray(data.items) ? data.items[0] : null;
  if (!channel || !channel.id) throw coded("no_channel");
  const title = (channel.snippet && channel.snippet.title) || "YouTube channel";
  return {
    accountId: String(channel.id),
    accountName: title,
    accountUsername: (channel.snippet && channel.snippet.customUrl) || "",
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
    scopes: "youtube.readonly",
    metadata: { detail: "YouTube channel" },
  };
}

async function exchangeGoogleEmail(args) {
  const token = await googleToken(args);
  const profile = await fetchJson("https://www.googleapis.com/oauth2/v2/userinfo", {
    method: "GET",
    headers: { Authorization: `Bearer ${token.access_token}` },
  }, args.fetchImpl);
  if (!profile.email) throw coded("provider_rejected");
  return {
    accountId: String(profile.id || profile.email),
    accountName: profile.name || profile.email,
    accountUsername: profile.email,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
    scopes: "openid email profile",
    metadata: { detail: "Google account email. No email password is stored." },
  };
}

function startConnect({ provider, userId, returnTo, req, env = process.env }) {
  if (!isConnectProvider(provider)) throw coded("not_found");
  const back = safeConnectReturn(returnTo, env);
  if (!back) throw coded("invalid_return");
  if (!connectionConfigured(provider, env)) throw coded("not_configured");
  const creds =
    provider === "x"
      ? { id: env.X_CLIENT_ID, secret: env.X_CLIENT_SECRET }
      : provider === "youtube" || provider === "email"
        ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
        : appCredentials(provider === "whatsapp" ? "facebook" : provider, env);
  const pkce = provider === "x" ? pkcePair() : null;
  const state = signState(
    {
      purpose: "connect",
      provider,
      userId,
      returnTo: back,
      exp: Date.now() + STATE_TTL_MS,
      nonce: crypto.randomBytes(8).toString("hex"),
      codeVerifier: pkce ? pkce.verifier : "",
    },
    env.SUPABASE_SECRET_KEY || ""
  );
  return connectAuthorizeUrl(provider, {
    clientId: creds.id,
    redirectUri: callbackUrl(req, env),
    state,
    env,
    codeChallenge: pkce ? pkce.challenge : "",
    configId: env.WHATSAPP_CONFIG_ID,
  });
}

async function finishConnect({ state, code, redirectUri, env = process.env, fetchImpl, save }) {
  if (!state || state.purpose !== "connect") throw coded("social_expired");
  const creds =
    state.provider === "x"
      ? { id: env.X_CLIENT_ID, secret: env.X_CLIENT_SECRET }
      : state.provider === "youtube" || state.provider === "email"
        ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
        : appCredentials(state.provider === "whatsapp" ? "facebook" : state.provider, env);
  const account = await exchangeProvider(state.provider, {
    code,
    redirectUri,
    clientId: creds.id,
    clientSecret: creds.secret,
    codeVerifier: state.codeVerifier,
    fetchImpl,
  });
  const row = {
    profile_id: state.userId,
    provider: state.provider,
    account_id: account.accountId,
    account_name: account.accountName,
    account_username: account.accountUsername,
    access_token_enc: encryptToken(account.accessToken, env),
    refresh_token_enc: encryptToken(account.refreshToken, env),
    expires_at: account.expiresAt,
    scopes: account.scopes,
    metadata: account.metadata,
    status: "connected",
    updated_at: new Date().toISOString(),
  };
  if (save) await save(row);
  return publicConnection(row);
}

async function revokeBestEffort(provider, accessToken, env = process.env, fetchImpl = global.fetch) {
  if (!accessToken) return;
  try {
    if (provider === "facebook" || provider === "instagram" || provider === "whatsapp") {
      const url = new URL("https://graph.facebook.com/v21.0/me/permissions");
      url.searchParams.set("access_token", accessToken);
      await fetchImpl(url, { method: "DELETE" });
      return;
    }
    if (provider === "youtube" || provider === "email") {
      const url = new URL("https://oauth2.googleapis.com/revoke");
      url.searchParams.set("token", accessToken);
      await fetchImpl(url, { method: "POST" });
      return;
    }
    if (provider === "x") {
      const form = new URLSearchParams();
      form.set("token", accessToken);
      form.set("client_id", env.X_CLIENT_ID || "");
      await fetchImpl("https://api.twitter.com/2/oauth2/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    }
  } catch {
    // Disconnect still removes the local record if the provider revoke fails.
  }
}

module.exports = {
  safeConnectReturn,
  encryptToken,
  decryptToken,
  connectionConfigured,
  connectAuthorizeUrl,
  pkcePair,
  publicConnection,
  startConnect,
  finishConnect,
  exchangeProvider,
  revokeBestEffort,
  isConnectProvider,
};

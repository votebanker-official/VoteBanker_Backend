const test = require("node:test");
const assert = require("node:assert/strict");

const { signState, readState } = require("../src/social_auth");
const {
  connectionConfigured,
  connectAuthorizeUrl,
  encryptToken,
  decryptToken,
  exchangeProvider,
  finishConnect,
  startConnect,
} = require("../src/social_connections");

const env = {
  SUPABASE_SECRET_KEY: "test-secret",
  META_APP_ID: "meta-id",
  META_APP_SECRET: "meta-secret",
  INSTAGRAM_APP_ID: "ig-id",
  INSTAGRAM_APP_SECRET: "ig-secret",
  WHATSAPP_CONFIG_ID: "wa-config",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  X_CLIENT_ID: "x-id",
  X_CLIENT_SECRET: "x-secret",
  FRONTEND_URL: "http://localhost:8080",
  PUBLIC_API_URL: "https://api.example",
};

test("connect state requires a user id and stays separate from login", () => {
  const login = signState(
    { provider: "facebook", returnTo: "http://localhost:8080/", exp: Date.now() + 1000 },
    env.SUPABASE_SECRET_KEY
  );
  assert.equal(readState(login, env.SUPABASE_SECRET_KEY).purpose, "login");

  const missingUser = signState(
    {
      purpose: "connect",
      provider: "facebook",
      returnTo: "http://localhost:8080/",
      exp: Date.now() + 1000,
    },
    env.SUPABASE_SECRET_KEY
  );
  assert.equal(readState(missingUser, env.SUPABASE_SECRET_KEY), null);

  const connect = signState(
    {
      purpose: "connect",
      provider: "youtube",
      userId: "user-1",
      returnTo: "http://localhost:8080/social",
      exp: Date.now() + 1000,
    },
    env.SUPABASE_SECRET_KEY
  );
  const payload = readState(connect, env.SUPABASE_SECRET_KEY);
  assert.equal(payload.purpose, "connect");
  assert.equal(payload.userId, "user-1");
});

test("authorize urls never include secrets", () => {
  const facebook = connectAuthorizeUrl("facebook", {
    clientId: "meta-id",
    redirectUri: `${env.PUBLIC_API_URL}/api/auth/oauth/callback`,
    state: "signed",
  });
  assert.match(facebook, /pages_show_list/);
  assert.doesNotMatch(facebook, /secret/);

  const whatsapp = connectAuthorizeUrl("whatsapp", {
    clientId: "meta-id",
    redirectUri: `${env.PUBLIC_API_URL}/api/auth/oauth/callback`,
    state: "signed",
    configId: "wa-config",
  });
  assert.match(whatsapp, /config_id=wa-config/);
  assert.doesNotMatch(whatsapp, /secret/);

  const youtube = connectAuthorizeUrl("youtube", {
    clientId: "google-id",
    redirectUri: `${env.PUBLIC_API_URL}/api/auth/oauth/callback`,
    state: "signed",
  });
  assert.match(youtube, /youtube\.readonly/);
});

test("tokens encrypt and decrypt without leaking plaintext", () => {
  const cipher = encryptToken("access-token", env);
  assert.notEqual(cipher, "access-token");
  assert.doesNotMatch(cipher, /access-token/);
  assert.equal(decryptToken(cipher, env), "access-token");
});

test("providers stay unconfigured until credentials exist", () => {
  assert.equal(connectionConfigured("x", {}), false);
  assert.equal(connectionConfigured("youtube", {}), false);
  assert.equal(connectionConfigured("whatsapp", { META_APP_ID: "1", META_APP_SECRET: "2" }), false);
  assert.equal(connectionConfigured("whatsapp", env), true);
});

test("startConnect rejects missing configuration and unsafe returns", () => {
  assert.throws(
    () => startConnect({ provider: "x", userId: "u1", returnTo: "http://localhost:8080/social", env: {} }),
    (err) => err.code === "not_configured"
  );
  assert.throws(
    () => startConnect({
      provider: "facebook",
      userId: "u1",
      returnTo: "https://evil.example/social",
      env,
    }),
    (err) => err.code === "invalid_return"
  );
});

test("facebook without a page is not treated as connected", async () => {
  await assert.rejects(
    () =>
      exchangeProvider("facebook", {
        code: "code",
        redirectUri: "https://api.example/api/auth/oauth/callback",
        clientId: "meta-id",
        clientSecret: "meta-secret",
        fetchImpl: async (url) => {
          const href = String(url);
          if (href.includes("oauth/access_token")) {
            return { ok: true, text: async () => JSON.stringify({ access_token: "user-token" }) };
          }
          return { ok: true, text: async () => JSON.stringify({ data: [] }) };
        },
      }),
    (err) => err.code === "no_page"
  );
});

test("instagram personal accounts are rejected", async () => {
  await assert.rejects(
    () =>
      exchangeProvider("instagram", {
        code: "code",
        redirectUri: "https://api.example/api/auth/oauth/callback",
        clientId: "ig-id",
        clientSecret: "ig-secret",
        fetchImpl: async (url) => {
          const href = String(url);
          if (href.includes("api.instagram.com")) {
            return {
              ok: true,
              text: async () => JSON.stringify({ access_token: "ig", user_id: "1" }),
            };
          }
          return {
            ok: true,
            text: async () => JSON.stringify({ user_id: "1", username: "me", account_type: "PERSONAL" }),
          };
        },
      }),
    (err) => err.code === "professional_required"
  );
});

test("whatsapp without a WABA is incomplete", async () => {
  await assert.rejects(
    () =>
      exchangeProvider("whatsapp", {
        code: "code",
        redirectUri: "https://api.example/api/auth/oauth/callback",
        clientId: "meta-id",
        clientSecret: "meta-secret",
        fetchImpl: async () => ({
          ok: true,
          text: async () => JSON.stringify({ access_token: "wa", data: { granular_scopes: [] } }),
        }),
      }),
    (err) => err.code === "whatsapp_incomplete"
  );
});

test("finishConnect stores the public account and never returns the token", async () => {
  const state = {
    purpose: "connect",
    provider: "email",
    userId: "user-1",
  };
  const saved = [];
  const account = await finishConnect({
    state,
    code: "code",
    redirectUri: "https://api.example/api/auth/oauth/callback",
    env,
    save: async (row) => saved.push(row),
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com/token")) {
        return { ok: true, text: async () => JSON.stringify({ access_token: "secret-token" }) };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ id: "g1", email: "leader@example.com", name: "Leader" }),
      };
    },
  });
  assert.equal(account.accountUsername, "leader@example.com");
  assert.equal(account.status, "connected");
  assert.equal(account.accessToken, undefined);
  assert.doesNotMatch(saved[0].access_token_enc, /secret-token/);
});

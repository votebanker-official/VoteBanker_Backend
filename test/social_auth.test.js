const test = require("node:test");
const assert = require("node:assert/strict");

const {
  signState,
  readState,
  safeReturnTo,
  authorizeUrl,
  providerConfigured,
  createTicketStore,
  exchangeFacebookCode,
  exchangeInstagramCode,
} = require("../src/social_auth");

const secret = "test-secret";

test("state round-trips and rejects tampering", () => {
  const token = signState(
    { provider: "facebook", returnTo: "http://localhost:8080/", exp: Date.now() + 1000 },
    secret
  );
  const payload = readState(token, secret);
  assert.equal(payload.provider, "facebook");
  assert.equal(readState(`${token}x`, secret), null);
  assert.equal(readState(token, secret, Date.now() + 5000), null);
});

test("return targets stay on allowed origins", () => {
  const env = { CORS_ORIGINS: "https://votebanker-frontend.vercel.app", FRONTEND_URL: "" };
  assert.equal(
    safeReturnTo("https://votebanker-frontend.vercel.app/login?x=1", env),
    "https://votebanker-frontend.vercel.app/"
  );
  assert.equal(safeReturnTo("http://localhost:55945/otp", env), "http://localhost:55945/");
  assert.equal(safeReturnTo("https://evil.example/phish", env), null);
  assert.equal(safeReturnTo("javascript:alert(1)", env), null);
});

test("authorize urls carry the app id and not the secret", () => {
  const facebook = authorizeUrl("facebook", {
    clientId: "fb-app",
    redirectUri: "https://api.example/api/auth/oauth/callback",
    state: "signed",
  });
  assert.match(facebook, /client_id=fb-app/);
  assert.match(facebook, /facebook\.com/);
  assert.doesNotMatch(facebook, /secret/);

  const instagram = authorizeUrl("instagram", {
    clientId: "ig-app",
    redirectUri: "https://api.example/api/auth/oauth/callback",
    state: "signed",
  });
  assert.match(instagram, /instagram\.com\/oauth\/authorize/);
  assert.match(instagram, /client_id=ig-app/);
  assert.match(instagram, /enable_fb_login=0/);
});

test("provider configuration requires both id and secret", () => {
  assert.equal(providerConfigured("facebook", { META_APP_ID: "1", META_APP_SECRET: "" }), false);
  assert.equal(providerConfigured("facebook", { META_APP_ID: "1", META_APP_SECRET: "2" }), true);
  assert.equal(
    providerConfigured("instagram", { META_APP_ID: "1", META_APP_SECRET: "2" }),
    true
  );
});

test("tickets can be redeemed once", () => {
  let now = 1_000;
  const store = createTicketStore(() => now);
  const ticket = store.issue({ access_token: "a" });
  assert.deepEqual(store.take(ticket), { access_token: "a" });
  assert.equal(store.take(ticket), null);
  const expired = store.issue({ access_token: "b" });
  now += 3 * 60 * 1000;
  assert.equal(store.take(expired), null);
});

test("facebook code exchange keeps the provider user id", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("oauth/access_token")) {
      return { ok: true, async text() { return JSON.stringify({ access_token: "tok" }); } };
    }
    return {
      ok: true,
      async text() {
        return JSON.stringify({ id: "9988", name: "Leader", email: "leader@example.com" });
      },
    };
  };
  const profile = await exchangeFacebookCode({
    code: "abc",
    redirectUri: "https://api.example/cb",
    clientId: "id",
    clientSecret: "secret",
    fetchImpl,
  });
  assert.deepEqual(profile, {
    provider: "facebook",
    providerUserId: "9988",
    name: "Leader",
    email: "leader@example.com",
  });
  assert.equal(calls.length, 2);
});

test("instagram code exchange accepts the data array shape", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("graph.instagram.com")) {
      return { ok: true, async text() { return JSON.stringify({ username: "leader.ig" }); } };
    }
    return {
      ok: true,
      async text() {
        return JSON.stringify({ data: [{ access_token: "tok", user_id: "4455" }] });
      },
    };
  };
  const profile = await exchangeInstagramCode({
    code: "abc#_",
    redirectUri: "https://api.example/cb",
    clientId: "id",
    clientSecret: "secret",
    fetchImpl,
  });
  assert.equal(profile.provider, "instagram");
  assert.equal(profile.providerUserId, "4455");
  assert.equal(profile.name, "leader.ig");
});

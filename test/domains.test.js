const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const {
  validateDomainSearch,
  mapDomainResult,
  extractPrice,
  searchDomains,
  createDomainsRouter,
  normalizeName,
} = require("../src/domains");
const {
  createOpenproviderClient,
  tokenExpiryMs,
} = require("../src/openprovider");

const env = {
  OPENPROVIDER_USERNAME: "reseller@example.com",
  OPENPROVIDER_PASSWORD: "secret",
  OPENPROVIDER_BASE_URL: "https://api.openprovider.eu/v1",
  OPENPROVIDER_IP: "0.0.0.0",
};

test("valid domain-name input is normalized", () => {
  const parsed = validateDomainSearch({
    name: "  Vote-Banker  ",
    extensions: ["COM", ".in", "org"],
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.value.name, "vote-banker");
  assert.deepEqual(parsed.value.extensions, ["com", "in", "org"]);
});

test("pasted full domains keep only the label", () => {
  assert.equal(normalizeName("https://www.VoteBanker.com/path"), "votebanker");
  const parsed = validateDomainSearch({ name: "votebanker.co.in" });
  assert.equal(parsed.value.name, "votebanker");
  assert.deepEqual(parsed.value.extensions, ["com", "org", "net", "in", "io", "ai", "co"]);
});

test("invalid input is rejected", () => {
  assert.equal(validateDomainSearch({ name: "" }).error, "invalid_name");
  assert.equal(validateDomainSearch({ name: "a".repeat(64) }).error, "invalid_name");
  assert.equal(validateDomainSearch({ name: "-bad" }).error, "invalid_name");
  assert.equal(validateDomainSearch({ name: "bad-" }).error, "invalid_name");
  assert.equal(validateDomainSearch({ name: "has space" }).error, "invalid_name");
  assert.equal(validateDomainSearch({ name: "ok", extensions: ["evil"] }).error, "invalid_extensions");
  assert.equal(
    validateDomainSearch(
      { name: "ok", extensions: ["com", "in", "org", "net", "co.in", "io"] },
      { OPENPROVIDER_MAX_EXTENSIONS: 5 }
    ).error,
    "too_many_extensions"
  );
});

test("multiple extensions are accepted within the limit", () => {
  const parsed = validateDomainSearch({
    name: "votebanker",
    extensions: ["com", "org", "net", "in", "io", "ai", "co"],
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.value.extensions.length, 7);
});

test("price mapping prefers reseller currency and amount", () => {
  assert.deepEqual(
    extractPrice({
      price: {
        product: { currency: "USD", price: 8.57 },
        reseller: { currency: "EUR", price: 7.53 },
      },
    }),
    { amount: 7.53, currency: "EUR" }
  );
  assert.equal(extractPrice({}), null);
  assert.equal(extractPrice({ price: { reseller: { currency: "EUR" } } }), null);
});

test("status mapping never marks unknown results as available", () => {
  assert.deepEqual(
    mapDomainResult({ domain: "a.com", status: "free", price: { reseller: { currency: "USD", price: 12.5 } } }),
    {
      domain: "a.com",
      available: true,
      status: "free",
      price: { amount: 12.5, currency: "USD" },
      isPremium: false,
    }
  );
  assert.equal(mapDomainResult({ domain: "a.com", status: "in use" }).available, false);
  assert.equal(mapDomainResult({ domain: "a.com", status: "reserved" }).available, false);
  const unknown = mapDomainResult({ domain: "a.com", status: "weird" });
  assert.equal(unknown.available, false);
  assert.equal(unknown.error, "unknown_status");
  const premium = mapDomainResult({
    domain: "god.tools",
    status: "free",
    is_premium: true,
    price: { reseller: { currency: "EUR", price: 219.8 } },
  });
  assert.equal(premium.isPremium, true);
  assert.equal(premium.available, true);
});

function mockFetchSequence(handlers) {
  let index = 0;
  return async (url, options) => {
    const handler = handlers[index++];
    assert.ok(handler, `unexpected fetch #${index} to ${url}`);
    return handler(String(url), options || {});
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("Openprovider authentication failure surfaces safely", async () => {
  const fetchImpl = mockFetchSequence([
    async () => jsonResponse(401, { code: 1, desc: "denied", data: {} }),
  ]);
  const result = await searchDomains(
    { name: "votebanker", extensions: ["com"] },
    { env, fetchImpl }
  );
  assert.equal(result.status, 502);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "openprovider_auth_failed");
  assert.equal(result.body.token, undefined);
});

test("expired token is refreshed and the check is retried", async () => {
  const fetchImpl = mockFetchSequence([
    async () => jsonResponse(200, { code: 0, data: { token: "token-1" } }),
    async (_url, options) => {
      assert.match(options.headers.Authorization, /^Bearer token-1$/);
      return jsonResponse(401, { code: 1, desc: "expired" });
    },
    async () => jsonResponse(200, { code: 0, data: { token: "token-2" } }),
    async (_url, options) => {
      assert.match(options.headers.Authorization, /^Bearer token-2$/);
      return jsonResponse(200, {
        code: 0,
        data: {
          results: [{ domain: "votebanker.com", status: "free", price: { reseller: { currency: "USD", price: 12.5 } } }],
        },
      });
    },
  ]);

  const client = createOpenproviderClient({ env, fetchImpl });
  const result = await searchDomains(
    { name: "votebanker", extensions: ["com"] },
    { env, client }
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].available, true);
  assert.equal(result.body.results[0].price.amount, 12.5);
});

test("successful availability results include free and unavailable domains", async () => {
  const fetchImpl = mockFetchSequence([
    async () => jsonResponse(200, { code: 0, data: { token: "token" } }),
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.with_price, true);
      assert.deepEqual(body.domains, [
        { name: "votebanker", extension: "com" },
        { name: "votebanker", extension: "in" },
      ]);
      return jsonResponse(200, {
        code: 0,
        data: {
          results: [
            {
              domain: "votebanker.com",
              status: "free",
              price: { reseller: { currency: "USD", price: 12.5 } },
            },
            { domain: "votebanker.in", status: "in use" },
          ],
        },
      });
    },
  ]);

  const result = await searchDomains(
    { name: "votebanker", extensions: ["com", "in"] },
    { env, fetchImpl }
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.results[0].available, true);
  assert.equal(result.body.results[0].status, "free");
  assert.equal(result.body.results[1].available, false);
  assert.equal(result.body.results[1].status, "in use");
});

test("reserved domains and missing pricing are represented correctly", async () => {
  const fetchImpl = mockFetchSequence([
    async () => jsonResponse(200, { code: 0, data: { token: "token" } }),
    async () =>
      jsonResponse(200, {
        code: 0,
        data: {
          results: [
            { domain: "votebanker.org", status: "reserved" },
            { domain: "votebanker.net", status: "free" },
          ],
        },
      }),
  ]);

  const result = await searchDomains(
    { name: "votebanker", extensions: ["org", "net"] },
    { env, fetchImpl }
  );
  assert.equal(result.body.results[0].available, false);
  assert.equal(result.body.results[0].status, "reserved");
  assert.equal(result.body.results[0].price, null);
  assert.equal(result.body.results[1].available, true);
  assert.equal(result.body.results[1].price, null);
});

test("premium domains keep the premium flag and reseller price", async () => {
  const fetchImpl = mockFetchSequence([
    async () => jsonResponse(200, { code: 0, data: { token: "token" } }),
    async () =>
      jsonResponse(200, {
        code: 0,
        data: {
          results: [
            {
              domain: "vote.ai",
              status: "free",
              is_premium: true,
              price: {
                product: { currency: "USD", price: 250 },
                reseller: { currency: "EUR", price: 219.8 },
              },
            },
          ],
        },
      }),
  ]);

  const result = await searchDomains(
    { name: "vote", extensions: ["ai"] },
    { env, fetchImpl }
  );
  assert.equal(result.body.results[0].isPremium, true);
  assert.deepEqual(result.body.results[0].price, { amount: 219.8, currency: "EUR" });
});

test("upstream timeout and malformed responses fail safely", async () => {
  const timeoutFetch = async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  const timedOut = await searchDomains(
    { name: "votebanker", extensions: ["com"] },
    { env, fetchImpl: timeoutFetch }
  );
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.body.error, "openprovider_timeout");

  const malformed = await searchDomains(
    { name: "votebanker", extensions: ["com"] },
    {
      env,
      fetchImpl: mockFetchSequence([
        async () => jsonResponse(200, { code: 0, data: { token: "token" } }),
        async () => jsonResponse(200, { code: 0, data: { results: "nope" } }),
      ]),
    }
  );
  assert.equal(malformed.status, 502);
  assert.equal(malformed.body.error, "openprovider_bad_response");
});

test("Openprovider IP access denial is mapped clearly", async () => {
  const fetchImpl = mockFetchSequence([
    async () => jsonResponse(200, { code: 0, data: { token: "token" } }),
    async () => jsonResponse(500, { code: 10005, desc: "Access denied." }),
  ]);
  const result = await searchDomains(
    { name: "votebanker", extensions: ["com"] },
    { env, fetchImpl }
  );
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "openprovider_access_denied");
});

test("missing Openprovider credentials return a configuration error name", async () => {
  const result = await searchDomains(
    { name: "votebanker", extensions: ["com"] },
    { env: {} }
  );
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "openprovider_not_configured");
});

test("JWT exp is used for token cache lifetime", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url");
  const token = `${header}.${payload}.sig`;
  const expiresAt = tokenExpiryMs(token, 1_699_999_000_000);
  assert.equal(expiresAt, 1_700_000_000 * 1000 - 60_000);
});

test("POST /api/domains/search and health continue to respond", async () => {
  const app = express();
  app.use(express.json());
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "VOTE BANKER backend" });
  });
  app.use(
    "/api/domains",
    createDomainsRouter({
      env,
      fetchImpl: mockFetchSequence([
        async () => jsonResponse(200, { code: 0, data: { token: "token" } }),
        async () =>
          jsonResponse(200, {
            code: 0,
            data: {
              results: [{ domain: "votebanker.com", status: "free", price: { reseller: { currency: "USD", price: 9 } } }],
            },
          }),
      ]),
      rateLimitPerMinute: 1000,
    })
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "VOTE BANKER backend" });

    const search = await fetch(`http://127.0.0.1:${port}/api/domains/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "votebanker", extensions: ["com"] }),
    });
    assert.equal(search.status, 200);
    const body = await search.json();
    assert.equal(body.success, true);
    assert.equal(body.results[0].domain, "votebanker.com");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

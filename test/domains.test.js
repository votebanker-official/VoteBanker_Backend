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
  STANDARD_EXTENSIONS,
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
  assert.equal(parsed.value.useCatalog, false);
  assert.deepEqual(parsed.value.extensions, ["com", "in", "org"]);
});

test("omitted extensions request the full Openprovider catalog", () => {
  const parsed = validateDomainSearch({ name: "votebanker" });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.value.name, "votebanker");
  assert.equal(parsed.value.useCatalog, true);
  assert.equal(parsed.value.extensions, null);
});

test("allTlds flag requests the full catalog", () => {
  const parsed = validateDomainSearch({
    name: "votebanker",
    allTlds: true,
    extensions: ["com"],
  });
  assert.equal(parsed.value.useCatalog, true);
});

test("pasted full domains keep only the label", () => {
  assert.equal(normalizeName("https://www.VoteBanker.com/path"), "votebanker");
  const parsed = validateDomainSearch({ name: "votebanker.co.in" });
  assert.equal(parsed.value.name, "votebanker");
  assert.equal(parsed.value.useCatalog, true);
});

test("invalid input is rejected", () => {
  assert.equal(validateDomainSearch({ name: "" }).error, "invalid_name");
  assert.equal(validateDomainSearch({ name: "a".repeat(64) }).error, "invalid_name");
  assert.equal(validateDomainSearch({ name: "-bad" }).error, "invalid_name");
  assert.equal(validateDomainSearch({ name: "bad-" }).error, "invalid_name");
  assert.equal(validateDomainSearch({ name: "has space" }).error, "invalid_name");
  assert.equal(validateDomainSearch({ name: "ok", extensions: ["bad_ext"] }).error, "invalid_extensions");
  assert.equal(validateDomainSearch({ name: "ok", extensions: [] }).error, "invalid_extensions");
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
    extensions: ["com", "in", "org", "co", "ai", "io", "net", "online"],
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.value.extensions.length, 8);
});

test("price mapping prefers reseller currency and amount", () => {
  assert.deepEqual(
    extractPrice({
      price: {
        product: { currency: "USD", price: 8.57 },
        reseller: { currency: "EUR", price: 7.53 },
      },
    }),
    { amount: 7.53, currency: "EUR", source: "reseller" }
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
      price: { amount: 12.5, currency: "USD", source: "reseller" },
      supplierPrice: null,
      isPremium: false,
    }
  );
  assert.equal(mapDomainResult({ domain: "a.com", status: "in use" }).available, false);
  assert.equal(mapDomainResult({ domain: "a.com", status: "active" }).available, false);
  assert.equal(mapDomainResult({ domain: "a.com", status: "active" }).status, "in use");
  assert.equal(mapDomainResult({ domain: "a.com", status: "reserved" }).available, false);
  assert.deepEqual(
    mapDomainResult({
      domain: "a.com",
      status: "active",
      price: {
        product: { currency: "USD", price: 10.46 },
        reseller: { currency: "INR", price: 1043 },
      },
    }).price,
    { amount: 1043, currency: "INR", source: "reseller" }
  );
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

function loginOk() {
  return async () => jsonResponse(200, { code: 0, data: { token: "token" } });
}

/** Two-phase check: availability (with_price=false), then priced check for free domains. */
function twoPhaseChecks(availabilityResults, pricedResults) {
  return [
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.with_price, false);
      return jsonResponse(200, { code: 0, data: { results: availabilityResults } });
    },
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.with_price, true);
      return jsonResponse(200, {
        code: 0,
        data: { results: pricedResults !== undefined ? pricedResults : availabilityResults.filter((r) => r.status === "free") },
      });
    },
  ];
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
      const body = JSON.parse(options.body);
      assert.equal(body.with_price, false);
      return jsonResponse(200, {
        code: 0,
        data: {
          results: [{ domain: "votebanker.com", status: "free" }],
        },
      });
    },
    async (_url, options) => {
      assert.match(options.headers.Authorization, /^Bearer token-2$/);
      const body = JSON.parse(options.body);
      assert.equal(body.with_price, true);
      return jsonResponse(200, {
        code: 0,
        data: {
          results: [
            {
              domain: "votebanker.com",
              status: "free",
              price: { reseller: { currency: "USD", price: 12.5 } },
            },
          ],
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

test("successful availability results include only free domains with prices", async () => {
  const fetchImpl = mockFetchSequence([
    loginOk(),
    ...twoPhaseChecks(
      [
        {
          domain: "votebanker.com",
          status: "free",
        },
        { domain: "votebanker.in", status: "in use" },
      ],
      [
        {
          domain: "votebanker.com",
          status: "free",
          price: { reseller: { currency: "USD", price: 12.5 } },
        },
      ]
    ),
  ]);

  const result = await searchDomains(
    { name: "votebanker", extensions: ["com", "in"] },
    { env, fetchImpl }
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.checked, 2);
  assert.equal(result.body.results.length, 1);
  assert.equal(result.body.results[0].domain, "votebanker.com");
  assert.equal(result.body.results[0].available, true);
  assert.equal(result.body.results[0].status, "free");
  assert.equal(result.body.results[0].price.amount, 12.5);
});

test("reserved domains are omitted and available domains keep pricing null when missing", async () => {
  const fetchImpl = mockFetchSequence([
    loginOk(),
    ...twoPhaseChecks(
      [
        { domain: "votebanker.org", status: "reserved" },
        { domain: "votebanker.net", status: "free" },
      ],
      [{ domain: "votebanker.net", status: "free" }]
    ),
  ]);

  const result = await searchDomains(
    { name: "votebanker", extensions: ["org", "net"] },
    { env, fetchImpl }
  );
  assert.equal(result.body.results.length, 1);
  assert.equal(result.body.results[0].domain, "votebanker.net");
  assert.equal(result.body.results[0].available, true);
  assert.equal(result.body.results[0].price, null);
});

test("standard available TLDs are ordered before other available TLDs", async () => {
  const fetchImpl = mockFetchSequence([
    loginOk(),
    ...twoPhaseChecks(
      [
        { domain: "vote.online", status: "free" },
        { domain: "vote.ai", status: "free" },
        { domain: "vote.com", status: "free" },
        { domain: "vote.in", status: "active" },
      ],
      [
        { domain: "vote.online", status: "free", price: { reseller: { currency: "INR", price: 100 } } },
        { domain: "vote.ai", status: "free", price: { reseller: { currency: "INR", price: 200 } } },
        { domain: "vote.com", status: "free", price: { reseller: { currency: "INR", price: 300 } } },
      ]
    ),
  ]);

  const result = await searchDomains(
    { name: "vote", extensions: ["online", "ai", "com", "in"] },
    { env, fetchImpl }
  );
  assert.deepEqual(
    result.body.results.map((item) => item.domain),
    ["vote.com", "vote.ai", "vote.online"]
  );
});

test("full catalog search checks standard TLDs first then remaining Openprovider TLDs", async () => {
  const catalog = ["aaa", "com", "online", "xyz"];
  const client = createOpenproviderClient({ env, fetchImpl: async () => {
    throw new Error("unused");
  } });
  client._setTldCacheForTests(catalog);

  const checkedExtensions = [];
  client.checkDomains = async (domains, { withPrice } = {}) => {
    for (const item of domains) {
      if (!withPrice) {
        checkedExtensions.push(item.extension);
      }
    }
    return domains.map((item) => ({
      domain: `${item.name}.${item.extension}`,
      status: item.extension === "aaa" ? "active" : "free",
      ...(withPrice
        ? { price: { reseller: { currency: "INR", price: 10 } } }
        : {}),
    }));
  };

  const result = await searchDomains({ name: "vote", allTlds: true }, { env, client });
  assert.equal(result.status, 200);
  assert.deepEqual(checkedExtensions.slice(0, STANDARD_EXTENSIONS.length), STANDARD_EXTENSIONS);
  assert.ok(checkedExtensions.includes("online"));
  assert.ok(checkedExtensions.includes("xyz"));
  assert.ok(checkedExtensions.includes("aaa"));
  assert.deepEqual(
    result.body.results.map((item) => item.domain),
    ["vote.com", "vote.in", "vote.org", "vote.co", "vote.ai", "vote.io", "vote.net", "vote.online", "vote.xyz"]
  );
});

test("premium domains keep the premium flag and reseller price", async () => {
  const fetchImpl = mockFetchSequence([
    loginOk(),
    ...twoPhaseChecks(
      [
        {
          domain: "vote.ai",
          status: "free",
          is_premium: true,
        },
      ],
      [
        {
          domain: "vote.ai",
          status: "free",
          is_premium: true,
          price: {
            product: { currency: "USD", price: 250 },
            reseller: { currency: "EUR", price: 219.8 },
          },
        },
      ]
    ),
  ]);

  const result = await searchDomains(
    { name: "vote", extensions: ["ai"] },
    { env, fetchImpl }
  );
  assert.equal(result.body.results[0].isPremium, true);
  assert.deepEqual(result.body.results[0].price, {
    amount: 219.8,
    currency: "EUR",
    source: "reseller",
  });
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
        loginOk(),
        async () => jsonResponse(200, { code: 0, data: { results: "nope" } }),
      ]),
    }
  );
  assert.equal(malformed.status, 502);
  assert.equal(malformed.body.error, "openprovider_bad_response");
});

test("Openprovider IP access denial is mapped clearly", async () => {
  const fetchImpl = mockFetchSequence([
    loginOk(),
    async () => jsonResponse(500, { code: 10005, desc: "Access denied." }),
    async (url) => {
      assert.match(String(url), /ipify/);
      return jsonResponse(200, { ip: "203.0.113.10" });
    },
  ]);
  const result = await searchDomains(
    { name: "votebanker", extensions: ["com"] },
    { env, fetchImpl }
  );
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "openprovider_access_denied");
  assert.equal(result.body.serverIp, "203.0.113.10");
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
        loginOk(),
        ...twoPhaseChecks(
          [{ domain: "votebanker.com", status: "free" }],
          [
            {
              domain: "votebanker.com",
              status: "free",
              price: { reseller: { currency: "USD", price: 9 } },
            },
          ]
        ),
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

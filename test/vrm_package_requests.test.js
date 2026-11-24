const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

test("package request uses the signed-in profile and server-side package price", async () => {
  const clients = require("../src/lib/clients");
  const previousPublic = clients.getSupabasePublic;
  const previousAdmin = clients.getSupabaseAdmin;
  let inserted;

  clients.getSupabasePublic = () => ({
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: "11111111-1111-4111-8111-111111111111",
            phone: "+919800000001",
            user_metadata: { full_name: "Untrusted Name" },
          },
        },
        error: null,
      }),
    },
  });
  clients.getSupabaseAdmin = () => ({
    from(table) {
      if (table === "profiles") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: async () => ({
            data: { full_name: "Ravi Leader", phone: "+919800000002" },
            error: null,
          }),
        };
      }
      assert.equal(table, "vrm_package_requests");
      return {
        insert(row) {
          inserted = row;
          return this;
        },
        select() {
          return this;
        },
        single: async () => ({
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            package_code: inserted.package_code,
            voter_count: inserted.voter_count,
            amount_inr: inserted.amount_inr,
            status: inserted.status,
            created_at: "2026-11-24T00:00:00.000Z",
          },
          error: null,
        }),
      };
    },
  });

  const routePath = require.resolve("../src/routes/vrm");
  const requestServicePath = require.resolve("../src/vrm/package_requests");
  delete require.cache[routePath];
  delete require.cache[requestServicePath];
  const { createVrmRouter } = require("../src/routes/vrm");
  const app = express();
  app.use(express.json());
  app.use("/api/vrm", createVrmRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    for (const [packageCode, voterCount, amountInr] of [
      ["voters_100", 100, 100],
      ["voters_1000", 1000, 999],
      ["voters_10000", 10000, 9999],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/vrm/package-requests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          packageCode,
          amountInr: 1,
          userName: "Forged Name",
          phone: "0000000000",
        }),
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).success, true);
      assert.equal(inserted.user_name, "Ravi Leader");
      assert.equal(inserted.user_phone, "+919800000002");
      assert.equal(inserted.voter_count, voterCount);
      assert.equal(inserted.amount_inr, amountInr);
      assert.equal(inserted.status, "requested");
    }

    const invalid = await fetch(`http://127.0.0.1:${port}/api/vrm/package-requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ packageCode: "__proto__", amountInr: 1 }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(inserted.package_code, "voters_10000");
  } finally {
    clients.getSupabasePublic = previousPublic;
    clients.getSupabaseAdmin = previousAdmin;
    delete require.cache[routePath];
    delete require.cache[requestServicePath];
    await new Promise((resolve) => server.close(resolve));
  }
});

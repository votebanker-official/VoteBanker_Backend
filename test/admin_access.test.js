const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { createAdminRouter } = require("../src/routes/admin");
const { createMemoryRepository } = require("../src/admin/repository");
const { buildProfileUpdate } = require("../src/routes/profile");

const adminId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";
const otherAdminId = "33333333-3333-4333-8333-333333333333";

function seed() {
  return createMemoryRepository({
    profiles: [
      {
        id: adminId,
        full_name: "Asha Admin",
        phone: "+919800000001",
        contact_email: "asha@example.com",
        app_role: "admin",
        account_status: "active",
        created_at: "2026-11-01T00:00:00.000Z",
      },
      {
        id: otherAdminId,
        full_name: "Backup Admin",
        phone: "+919800000003",
        app_role: "admin",
        account_status: "active",
        created_at: "2026-11-02T00:00:00.000Z",
      },
      {
        id: clientId,
        full_name: "Ravi Leader",
        phone: "+919800000002",
        contact_email: "ravi@example.com",
        public_contact: "+919800000002",
        designation: "MLA",
        app_role: "client",
        account_status: "active",
        created_at: "2026-11-10T00:00:00.000Z",
        last_login_at: "2026-11-18T00:00:00.000Z",
      },
    ],
    orders: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        profile_id: clientId,
        product_name: "Poster",
        campaign_line: "Ravi 2026",
        quantity: 2,
        status: "requested",
        contact_name: "Ravi Leader",
        created_at: "2026-11-12T00:00:00.000Z",
      },
    ],
    websites: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        user_id: clientId,
        website_name: "Ravi Leader",
        status: "published",
        payment_verified: true,
        created_at: "2026-11-11T00:00:00.000Z",
        updated_at: "2026-11-11T00:00:00.000Z",
      },
    ],
  });
}

function appFor(userId) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin",
    createAdminRouter({
      repo: seed(),
      authenticate: async () => (userId ? { id: userId, phone: "" } : null),
    }),
  );
  return app;
}

async function request(app, method, path, payload) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await response.text();
    const type = response.headers.get("content-type") || "";
    const json = type.includes("application/json") && text ? JSON.parse(text) : null;
    return { status: response.status, body: json, text };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("admin routes reject missing and non-admin sessions", async () => {
  const anonymous = await request(appFor(null), "GET", "/api/admin/overview");
  assert.equal(anonymous.status, 401);
  const client = await request(appFor(clientId), "GET", "/api/admin/clients");
  assert.equal(client.status, 403);
  assert.equal(client.body.error, "forbidden");
});

test("admin overview and client profile use stored records", async () => {
  const overview = await request(appFor(adminId), "GET", "/api/admin/overview?range=month");
  assert.equal(overview.status, 200);
  assert.equal(overview.body.cards.totalClients, 1);
  assert.equal(overview.body.cards.activeClients, 1);
  assert.equal(overview.body.cards.totalPurchases, 2);
  assert.equal(overview.body.cards.successfulPayments, 1);
  assert.equal(overview.body.cards.pendingPayments, 1);
  assert.equal(overview.body.cards.totalRevenue, 0);
  assert.equal(overview.body.recentRegistrations[0].fullName, "Ravi Leader");

  const profile = await request(appFor(adminId), "GET", `/api/admin/clients/${clientId}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.profile.phone, "+919800000002");
  assert.equal(profile.body.engagement.purchases, 1);
  assert.ok(profile.body.activity.some((item) => item.type === "registration"));
  assert.ok(profile.body.purchases.some((item) => item.product === "Poster"));
  assert.ok(profile.body.purchases.some((item) => item.paymentStatus === "successful"));
});

test("client search, purchase filters, and csv stay on real rows", async () => {
  const found = await request(appFor(adminId), "GET", "/api/admin/clients?q=ravi@example.com");
  assert.equal(found.body.total, 1);
  const missing = await request(appFor(adminId), "GET", "/api/admin/clients?q=nobody");
  assert.equal(missing.body.total, 0);
  const purchases = await request(appFor(adminId), "GET", "/api/admin/purchases?paymentStatus=pending");
  assert.equal(purchases.body.total, 1);
  assert.equal(purchases.body.rows[0].product, "Poster");
  const csv = await request(appFor(adminId), "GET", "/api/admin/purchases.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Poster/);
  assert.doesNotMatch(csv.text, /campaign_photo|cvv|password/i);
});

test("the last active admin cannot be removed", async () => {
  const repo = createMemoryRepository({
    profiles: [
      {
        id: adminId,
        full_name: "Only Admin",
        app_role: "admin",
        account_status: "active",
        created_at: "2026-11-01T00:00:00.000Z",
      },
    ],
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin",
    createAdminRouter({
      repo,
      authenticate: async () => ({ id: adminId, phone: "" }),
    }),
  );
  const denied = await request(app, "PATCH", `/api/admin/users/${adminId}`, { app_role: "client" });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error, "last_admin");
  const audit = await request(app, "GET", "/api/admin/audit");
  assert.equal(audit.body.rows[0].outcome, "rejected");
});

test("an admin can change another admin and profile updates cannot self-promote", async () => {
  const changed = await request(appFor(adminId), "PATCH", `/api/admin/users/${otherAdminId}`, {
    account_status: "inactive",
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.status, "inactive");
  const update = buildProfileUpdate({ app_role: "admin", full_name: "Ravi" }, { id: clientId, phone: "+919800000002" });
  assert.equal(update.update.app_role, undefined);
  assert.equal(update.update.full_name, "Ravi");
});

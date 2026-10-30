#!/usr/bin/env node
/** Exercise team-member CRUD against the configured database. Prints counts only. */
const http = require("node:http");
const express = require("express");
const { Client } = require("pg");
const { loadEnv } = require("../src/env");
const { createTeamMembersRouter } = require("../src/team_members");

loadEnv();

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  let userId;
  try {
    const found = await client.query("select id from auth.users limit 1");
    userId = found.rows[0] && found.rows[0].id;
  } finally {
    await client.end();
  }
  if (!userId) {
    console.log("no_auth_users");
    return;
  }

  const app = express();
  app.use(express.json());
  app.use(
    "/api/team-members",
    createTeamMembersRouter({
      supabaseUrl: process.env.SUPABASE_URL,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
      secretKey: process.env.SUPABASE_SECRET_KEY,
      fetchImpl: async (url, options) => {
        if (String(url).includes("/auth/v1/user")) {
          return { ok: true, json: async () => ({ id: userId }) };
        }
        return fetch(url, options);
      },
    }),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/team-members`;
  const headers = { "Content-Type": "application/json", Authorization: "Bearer verify" };
  const marker = `verify-${Date.now()}`;
  const mobile = `9${String(Date.now()).slice(-9)}`;
  try {
    const created = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fullName: marker,
        mobile,
        email: "verify@example.com",
        designation: "Check",
        location: "Lab",
        role: "Member",
        permissions: ["View dashboard"],
      }),
    });
    const createdBody = await created.json();
    if (!created.ok) throw new Error(`create_${created.status}_${createdBody.error || "failed"}`);
    const listed = await fetch(base, { headers });
    const listedBody = await listed.json();
    const found = (listedBody.members || []).some((row) => row.id === createdBody.member.id);
    if (!found || listedBody.stats.total < 1 || listedBody.stats.pending < 1) {
      throw new Error("list_missing_created_row");
    }
    const updated = await fetch(`${base}/${createdBody.member.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        fullName: marker,
        mobile,
        email: "verify@example.com",
        designation: "Check",
        location: "Lab",
        role: "Member",
        permissions: ["View dashboard"],
        status: "active",
      }),
    });
    const updatedBody = await updated.json();
    if (!updated.ok || updatedBody.stats.active < 1) throw new Error("status_not_updated");
    const removed = await fetch(`${base}/${createdBody.member.id}`, { method: "DELETE", headers });
    if (!removed.ok) throw new Error("delete_failed");
    console.log("database_crud: ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  const message = String(err && err.message ? err.message : err);
  console.error(message.includes("postgres://") ? "verify_failed" : message);
  process.exit(1);
});

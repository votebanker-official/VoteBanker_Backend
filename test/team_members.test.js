const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const {
  createTeamMembersRouter,
  createMemoryStore,
  validateMemberInput,
  statsFor,
} = require("../src/team_members");

test("team member validation rejects a bad phone and unknown role", () => {
  assert.equal(
    validateMemberInput({ fullName: "Asha", mobile: "abc", role: "Coordinator" }).error,
    "invalid_phone",
  );
  assert.equal(
    validateMemberInput({ fullName: "Asha", mobile: "9876543210", role: "Spy" }).error,
    "invalid_role",
  );
  const parsed = validateMemberInput({
    fullName: "Asha Rao",
    mobile: "9876543210",
    email: "asha@example.com",
    designation: "Booth lead",
    location: "Bengaluru",
    role: "Field Lead",
    permissions: ["Manage voters"],
    status: "active",
  }, { creating: true });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.value.status, "pending");
});

test("team member CRUD updates counts from stored records", async () => {
  const memory = createMemoryStore();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/team-members",
    createTeamMembersRouter({
      memoryStore: memory,
      supabaseUrl: "http://supabase.test",
      publishableKey: "pub",
      secretKey: "secret",
      fetchImpl: async (url) => {
        if (String(url).includes("/auth/v1/user")) {
          return { ok: true, json: async () => ({ id: "user-a" }) };
        }
        return { ok: false, status: 404, text: async () => "" };
      },
    }),
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/team-members`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer token",
  };

  try {
    const empty = await fetch(base, { headers });
    const emptyBody = await empty.json();
    assert.deepEqual(emptyBody.stats, statsFor([]));

    const created = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fullName: "Meera Nair",
        mobile: "9876543210",
        email: "meera@example.com",
        designation: "Coordinator",
        location: "Kochi",
        role: "Coordinator",
        permissions: ["View dashboard", "Manage voters"],
      }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201);
    assert.equal(createdBody.member.status, "pending");
    assert.equal(createdBody.stats.total, 1);
    assert.equal(createdBody.stats.pending, 1);
    assert.equal(createdBody.stats.active, 0);

    const updated = await fetch(`${base}/${createdBody.member.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        fullName: "Meera Nair",
        mobile: "9876543210",
        email: "meera@example.com",
        designation: "Coordinator",
        location: "Kochi",
        role: "Coordinator",
        permissions: ["View dashboard"],
        status: "active",
      }),
    });
    const updatedBody = await updated.json();
    assert.equal(updatedBody.stats.active, 1);
    assert.equal(updatedBody.stats.pending, 0);

    const searched = await fetch(`${base}?q=kochi`, { headers });
    const searchedBody = await searched.json();
    assert.equal(searchedBody.members.length, 1);
    assert.equal(searchedBody.stats.total, 1);

    const removed = await fetch(`${base}/${createdBody.member.id}`, { method: "DELETE", headers });
    const removedBody = await removed.json();
    assert.equal(removedBody.stats.total, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

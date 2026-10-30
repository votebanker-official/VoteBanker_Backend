const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const {
  createVolunteersRouter,
  createMemoryStore,
  validateVolunteerInput,
  validateApplicationInput,
} = require("../src/volunteers");

test("volunteer validation rejects bad phone and email", () => {
  assert.equal(validateVolunteerInput({ fullName: "A", mobile: "abc", role: "General Volunteer" }).error, "invalid_phone");
  assert.equal(
    validateVolunteerInput({
      fullName: "Asha",
      mobile: "+919876543210",
      email: "bad",
      role: "General Volunteer",
    }).error,
    "invalid_email",
  );
  assert.equal(
    validateVolunteerInput({
      fullName: "Asha",
      role: "General Volunteer",
      status: "active",
    }, { requireStatus: true }).error,
    undefined,
  );
});

test("application validation requires a known role", () => {
  assert.equal(
    validateApplicationInput({
      fullName: "Ravi",
      mobile: "+919111111111",
      role: "Spy",
    }).error,
    "invalid_role",
  );
});

test("volunteer CRUD, tasks, and application approval work with memory store", async () => {
  const memory = createMemoryStore();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/volunteers",
    createVolunteersRouter({
      memoryStore: memory,
      supabaseUrl: "http://supabase.test",
      publishableKey: "pub",
      secretKey: "secret",
      fetchImpl: async (url) => {
        if (String(url).includes("/auth/v1/user")) {
          return {
            ok: true,
            json: async () => ({ id: "user-a" }),
          };
        }
        return { ok: false, status: 404, text: async () => "" };
      },
    }),
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/volunteers`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer token",
  };

  const createRes = await fetch(`${base}/volunteers`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fullName: "Asha Rao",
      mobile: "+919876543210",
      email: "asha@example.com",
      role: "Field Volunteer",
      status: "active",
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.success, true);
  assert.equal(created.volunteer.fullName, "Asha Rao");
  assert.match(created.volunteer.volunteerCode, /^VOL-/);

  const statsRes = await fetch(`${base}/stats`, { headers });
  const statsBody = await statsRes.json();
  assert.equal(statsBody.stats.totalVolunteers, 1);
  assert.equal(statsBody.stats.activeVolunteers, 1);
  assert.equal(statsBody.stats.unassignedVolunteers, 1);

  const appRes = await fetch(`${base}/applications`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fullName: "Asha Rao",
      mobile: "+919876543210",
      role: "Field Volunteer",
    }),
  });
  assert.equal(appRes.status, 201);
  const application = (await appRes.json()).application;

  const reviewRes = await fetch(`${base}/applications/${application.id}/review`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(reviewRes.status, 200);
  const reviewed = await reviewRes.json();
  assert.equal(reviewed.application.status, "approved");
  assert.equal(reviewed.volunteer.id, created.volunteer.id);

  const taskRes = await fetch(`${base}/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Booth visit",
      volunteerId: created.volunteer.id,
      priority: "high",
      status: "pending",
    }),
  });
  assert.equal(taskRes.status, 201);

  const overviewRes = await fetch(`${base}/overview`, { headers });
  const overview = await overviewRes.json();
  assert.equal(overview.success, true);
  assert.ok(overview.teams.length >= 4);
  assert.equal(overview.stats.totalVolunteers, 1);

  const team = overview.teams[0];
  const patchRes = await fetch(`${base}/volunteers/${created.volunteer.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      location: "Ward 01",
      teamId: team.id,
      skills: "Communication, Data Entry",
    }),
  });
  assert.equal(patchRes.status, 200);
  const listedRes = await fetch(
    `${base}/volunteers?location=${encodeURIComponent("Ward 01")}&q=${encodeURIComponent(team.name)}`,
    { headers },
  );
  assert.equal(listedRes.status, 200);
  const listed = await listedRes.json();
  assert.equal(listed.total, 1);
  assert.equal(listed.volunteers[0].location, "Ward 01");
  assert.equal(listed.volunteers[0].teamName, team.name);
  assert.ok(listed.locations.includes("Ward 01"));

  await new Promise((resolve) => server.close(resolve));
});

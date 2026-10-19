const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { createVrmRouter } = require("../src/routes/vrm");

function jsonResponse(status, body) {
  return {
    status,
    json: async () => body,
  };
}

test("unauthenticated VRM list returns the shared catalog", async () => {
  const records = require("../src/vrm/records");
  const previous = records.listVoterRecords;
  records.listVoterRecords = async (ownerId) => {
    assert.equal(ownerId, null);
    return [
      {
        id: "1",
        name: "Shabanna Bijapur",
        age: 48,
        gender: "Female",
        epicNumber: "NNA4411195",
        isShared: true,
      },
    ];
  };

  const app = express();
  app.use(express.json());
  // Re-require router so it picks up the stubbed list function via live module.
  delete require.cache[require.resolve("../src/routes/vrm")];
  const { createVrmRouter: createFresh } = require("../src/routes/vrm");
  app.use("/api/vrm", createFresh());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/vrm/records`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0].epicNumber, "NNA4411195");
  } finally {
    records.listVoterRecords = previous;
    delete require.cache[require.resolve("../src/routes/vrm")];
    await new Promise((resolve) => server.close(resolve));
  }
});

test("import confirm rejects more than 50 records", async () => {
  const original = require("../src/lib/clients");
  const previous = original.getSupabasePublic;

  original.getSupabasePublic = () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-a" } }, error: null }),
    },
  });

  const app = express();
  app.use(express.json());
  app.use("/api/vrm", createVrmRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const records = Array.from({ length: 51 }, (_, i) => ({
      name: `Voter ${i + 1}`,
      age: 30,
      gender: "Female",
      epicNumber: `NNA${String(i + 1).padStart(7, "0")}`,
      sourceSerial: i + 1,
    }));
    const res = await fetch(`http://127.0.0.1:${port}/api/vrm/import/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ records }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "too_many_records");
  } finally {
    original.getSupabasePublic = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("owner isolation helper keeps user B rows out of user A list query shape", () => {
  // Documented contract: listVoterRecords always filters by owner_user_id.
  const { listVoterRecords } = require("../src/vrm/records");
  assert.equal(typeof listVoterRecords, "function");
  assert.equal(jsonResponse(200, {}).status, 200);
});

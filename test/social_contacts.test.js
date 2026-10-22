const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const {
  buildContactPatch,
  groupSocialContacts,
  updateVoterContacts,
} = require("../src/vrm/records");

function memorySupabase(row) {
  const state = row ? { ...row } : null;
  let pendingUpdate = null;
  const api = {
    from() {
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        update(patch) {
          pendingUpdate = patch;
          return chain;
        },
        maybeSingle: async () => {
          if (!state) return { data: null, error: null };
          if (pendingUpdate) {
            Object.assign(state, pendingUpdate);
            pendingUpdate = null;
          }
          return { data: { ...state }, error: null };
        },
      };
      return chain;
    },
  };
  return { api, get state() { return state; } };
}

const baseRow = {
  id: "rec-1",
  owner_user_id: "user-a",
  name: "Shabanna Bijapur",
  age: 48,
  gender: "Female",
  epic_number: "NNA4411195",
  source_serial: 1,
  import_batch_id: "batch",
  needs_review: false,
  review_notes: null,
  is_shared: false,
  whatsapp_contact: "+919876543210",
  instagram_contact: "shabanna",
  facebook_contact: "shabanna.fb",
  created_at: "2026-10-19T00:00:00.000Z",
};

test("partial contact update keeps fields that were not sent", async () => {
  const db = memorySupabase(baseRow);
  const updated = await updateVoterContacts(
    "user-a",
    "rec-1",
    { instagramContact: "shabanna.new" },
    { supabase: db.api }
  );
  assert.equal(updated.instagramContact, "shabanna.new");
  assert.equal(updated.whatsappContact, "+919876543210");
  assert.equal(updated.facebookContact, "shabanna.fb");
  assert.equal(updated.name, "Shabanna Bijapur");
  assert.equal(updated.epicNumber, "NNA4411195");
  assert.equal(updated.age, 48);
});

test("clearing one contact removes only that value", async () => {
  const db = memorySupabase(baseRow);
  const updated = await updateVoterContacts(
    "user-a",
    "rec-1",
    { whatsappContact: "   " },
    { supabase: db.api }
  );
  assert.equal(updated.whatsappContact, null);
  assert.equal(updated.instagramContact, "shabanna");
  assert.equal(updated.facebookContact, "shabanna.fb");
});

test("invalid whatsapp is rejected before any write", async () => {
  const db = memorySupabase(baseRow);
  await assert.rejects(
    () => updateVoterContacts("user-a", "rec-1", { whatsappContact: "not-a-number" }, { supabase: db.api }),
    (error) => error.code === "invalid_contact"
  );
  assert.equal(db.state.whatsapp_contact, "+919876543210");
});

test("another user cannot edit a private voter record", async () => {
  const db = memorySupabase(baseRow);
  await assert.rejects(
    () => updateVoterContacts("user-b", "rec-1", { facebookContact: "other" }, { supabase: db.api }),
    (error) => error.code === "forbidden"
  );
  assert.equal(db.state.facebook_contact, "shabanna.fb");
});

test("contact patch accepts a profile URL and rejects an unrelated site", () => {
  const ok = buildContactPatch({
    instagramContact: "https://www.instagram.com/leader",
    facebookContact: "https://facebook.com/leader",
  });
  assert.equal(ok.error, null);
  assert.equal(ok.patch.instagram_contact, "https://www.instagram.com/leader");

  const bad = buildContactPatch({ instagramContact: "https://evil.example/leader" });
  assert.equal(bad.error.code, "invalid_contact");
});

test("social contacts group by platform and skip empty values", () => {
  const grouped = groupSocialContacts([
    {
      id: "1",
      name: "Shabanna Bijapur",
      epicNumber: "NNA4411195",
      whatsappContact: "+919876543210",
      instagramContact: "shabanna",
      facebookContact: null,
    },
    {
      id: "1",
      name: "Shabanna Bijapur",
      epicNumber: "NNA4411195",
      whatsappContact: "+919876543210",
      instagramContact: null,
      facebookContact: null,
    },
    {
      id: "2",
      name: "Akshay",
      epicNumber: "NNA4656914",
      whatsappContact: null,
      instagramContact: null,
      facebookContact: "https://facebook.com/akshay",
    },
  ]);

  assert.equal(grouped.counts.whatsapp, 1);
  assert.equal(grouped.counts.instagram, 1);
  assert.equal(grouped.counts.facebook, 1);
  assert.equal(grouped.whatsapp[0].epicNumber, "NNA4411195");
  assert.equal(grouped.instagram[0].instagramContact, "shabanna");
  assert.equal(grouped.facebook[0].name, "Akshay");
  assert.equal(grouped.whatsapp.some((row) => !row.whatsappContact), false);
});

test("social contact search matches a name or the saved value", () => {
  const records = [
    {
      id: "1",
      name: "Shabanna Bijapur",
      epicNumber: "NNA4411195",
      whatsappContact: "+919876543210",
      instagramContact: "shabanna",
      facebookContact: "shabanna.fb",
    },
  ];
  const byName = groupSocialContacts(records, "bijapur");
  assert.equal(byName.counts.whatsapp, 1);
  assert.equal(byName.counts.instagram, 1);
  const byInstagram = groupSocialContacts(records, "shabanna");
  assert.equal(byInstagram.counts.instagram, 1);
  const missed = groupSocialContacts(records, "no-such-voter");
  assert.equal(missed.counts.whatsapp, 0);
  assert.equal(missed.counts.instagram, 0);
  assert.equal(missed.counts.facebook, 0);
});

test("GET /api/social-media/contacts uses the token user and ignores a client owner id", async () => {
  const records = require("../src/vrm/records");
  const previous = records.listVoterRecords;
  records.listVoterRecords = async (ownerId) => {
    assert.equal(ownerId, "user-a");
    return [
      {
        id: "1",
        name: "Shabanna Bijapur",
        epicNumber: "NNA4411195",
        whatsappContact: "+919876543210",
        instagramContact: null,
        facebookContact: null,
      },
    ];
  };

  const clients = require("../src/lib/clients");
  const previousAuth = clients.getSupabasePublic;
  clients.getSupabasePublic = () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-a" } }, error: null }),
    },
  });

  delete require.cache[require.resolve("../src/routes/social_media")];
  delete require.cache[require.resolve("../src/routes/vrm")];
  const { createSocialMediaRouter } = require("../src/routes/social_media");

  const app = express();
  app.use("/api/social-media", createSocialMediaRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/social-media/contacts`);
    assert.equal(denied.status, 401);

    const res = await fetch(
      `http://127.0.0.1:${port}/api/social-media/contacts?ownerId=user-b&q=shabanna`,
      { headers: { Authorization: "Bearer token" } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.counts.whatsapp, 1);
    assert.equal(body.counts.instagram, 0);
    assert.equal(body.whatsapp[0].whatsappContact, "+919876543210");
    assert.equal(body.whatsapp[0].age, undefined);
  } finally {
    records.listVoterRecords = previous;
    clients.getSupabasePublic = previousAuth;
    delete require.cache[require.resolve("../src/routes/social_media")];
    delete require.cache[require.resolve("../src/routes/vrm")];
    await new Promise((resolve) => server.close(resolve));
  }
});

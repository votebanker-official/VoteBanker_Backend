const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const {
  createCampaignMediaRouter,
  createMemoryMediaStore,
  sniffImage,
  publicMediaUrl,
  MAX_PHOTOS,
  BUCKET,
} = require("../src/routes/campaign_media");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const SUPABASE = "https://example.supabase.co";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP"),
]);

test("image sniff accepts jpg, png, and webp only", () => {
  assert.equal(sniffImage(JPEG), "image/jpeg");
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(WEBP), "image/webp");
  assert.equal(sniffImage(Buffer.from("GIF89a")), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  assert.equal(
    publicMediaUrl(`${SUPABASE}/`, "user/logo.jpg"),
    `${SUPABASE}/storage/v1/object/public/${BUCKET}/user/logo.jpg`,
  );
});

test("campaign media uploads, lists, replaces, and deletes per user", async () => {
  const store = createMemoryMediaStore();
  const app = express();
  app.use(
    "/api/campaign-media",
    createCampaignMediaRouter({
      store,
      supabaseUrl: SUPABASE,
      getUser: async (req) => {
        const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        if (token === "a") return { id: USER_A };
        if (token === "b") return { id: USER_B };
        return null;
      },
    }),
  );
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.code || "server_error" });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/campaign-media`;

  async function send(path, { method = "GET", token = "a", type, body } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(type ? { "Content-Type": type } : {}),
      },
      body,
    });
    const json = await response.json();
    return { status: response.status, json };
  }

  try {
    assert.equal((await send("", { token: "" })).status, 401);

    const empty = await send("");
    assert.equal(empty.status, 200);
    assert.equal(empty.json.userId, USER_A);
    assert.equal(empty.json.logo, null);
    assert.deepEqual(empty.json.photos, []);

    assert.equal((await send("/logo", { method: "POST", type: "image/png", body: JPEG })).status, 400);
    assert.equal((await send("/logo", { method: "POST", type: "image/gif", body: JPEG })).status, 400);

    const logo = await send("/logo", { method: "POST", type: "image/png", body: PNG });
    assert.equal(logo.status, 201);
    assert.equal(logo.json.logo.userId, USER_A);
    assert.match(logo.json.logo.url, new RegExp(`${USER_A}/logo\\.png$`));
    assert.equal(store.files.has(`${USER_A}/logo.png`), true);

    const replaced = await send("/logo", { method: "POST", type: "image/jpeg", body: JPEG });
    assert.equal(replaced.status, 201);
    assert.match(replaced.json.logo.url, /logo\.jpg$/);
    assert.equal(store.files.has(`${USER_A}/logo.png`), false);
    assert.equal(store.files.has(`${USER_A}/logo.jpg`), true);

    const listed = await send("");
    assert.equal(listed.json.logo.id, replaced.json.logo.id);
    assert.equal(listed.json.photos.length, 0);

    const photo = await send("/photos", { method: "POST", type: "image/webp", body: WEBP });
    assert.equal(photo.status, 201);
    assert.equal(photo.json.photo.userId, USER_A);
    assert.match(photo.json.photo.url, /\/photos\/.+\.webp$/);

    const other = await send(`/photos/${photo.json.photo.id}`, { method: "DELETE", token: "b" });
    assert.equal(other.status, 404);
    assert.equal((await send("")).json.photos.length, 1);

    const removed = await send(`/photos/${photo.json.photo.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(removed.json.deleted, true);
    assert.equal(store.files.has(`${USER_A}/photos/${photo.json.photo.id}.webp`), false);
    assert.equal((await send("")).json.photos.length, 0);

    for (let index = 0; index < MAX_PHOTOS; index += 1) {
      const saved = await send("/photos", { method: "POST", type: "image/jpeg", body: JPEG });
      assert.equal(saved.status, 201, `photo ${index + 1} should save`);
    }
    const extra = await send("/photos", { method: "POST", type: "image/jpeg", body: JPEG });
    assert.equal(extra.status, 400);
    assert.equal(extra.json.error, "too_many_photos");
    assert.equal((await send("")).json.photos.length, MAX_PHOTOS);

    const cleared = await send("/logo", { method: "DELETE" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.logo, null);
    assert.equal((await send("")).json.logo, null);
    assert.equal(store.files.has(`${USER_A}/logo.jpg`), false);

    const hidden = await send("", { token: "b" });
    assert.equal(hidden.json.logo, null);
    assert.equal(hidden.json.photos.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

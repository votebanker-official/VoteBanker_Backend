const crypto = require("node:crypto");
const express = require("express");

const { getSupabaseAdmin, getSupabasePublic } = require("../lib/clients");

const BUCKET = "campaign-media";
const MAX_PHOTOS = 10;
const MAX_BYTES = 5 * 1024 * 1024;

function sniffImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) {
    return null;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function extensionFor(type) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/jpeg") return "jpg";
  return null;
}

function publicMediaUrl(supabaseUrl, storagePath) {
  if (!storagePath) return "";
  const base = String(supabaseUrl || "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${BUCKET}/${storagePath}`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function asStorageError(error) {
  if (error && error.code === "storage_not_ready") return error;
  const message = String((error && (error.message || error.code)) || error || "");
  const wrapped = new Error(message || "storage_failed");
  const missingTable =
    error &&
    (error.code === "42P01" ||
      error.code === "PGRST205" ||
      error.code === "PGRST204" ||
      (/campaign_media/i.test(message) && /does not exist|schema cache|Could not find/i.test(message)));
  const missingBucket = /bucket not found/i.test(message);
  wrapped.code = missingTable || missingBucket ? "storage_not_ready" : "storage_failed";
  return wrapped;
}

function createMemoryMediaStore() {
  const rows = [];
  const files = new Map();
  return {
    rows,
    files,
    async list(userId) {
      return rows.filter((row) => row.user_id === userId);
    },
    async insert(row) {
      rows.push({ ...row });
      return { ...row };
    },
    async removeRow(userId, id) {
      const index = rows.findIndex((row) => row.user_id === userId && row.id === id);
      if (index < 0) return null;
      const [row] = rows.splice(index, 1);
      return row;
    },
    async upload(path, bytes, contentType) {
      files.set(path, { bytes: Buffer.from(bytes), contentType });
    },
    async removeFiles(paths) {
      for (const path of paths) files.delete(path);
    },
  };
}

function createSupabaseMediaStore() {
  function admin() {
    try {
      return getSupabaseAdmin();
    } catch (err) {
      const wrapped = new Error("storage_not_ready");
      wrapped.code = "storage_not_ready";
      throw wrapped;
    }
  }

  return {
    async list(userId) {
      const { data, error } = await admin()
        .from("campaign_media")
        .select("id, user_id, kind, storage_path, public_url, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
      if (error) throw asStorageError(error);
      return data || [];
    },
    async insert(row) {
      const { data, error } = await admin()
        .from("campaign_media")
        .insert(row)
        .select("id, user_id, kind, storage_path, public_url, created_at")
        .single();
      if (error) throw asStorageError(error);
      return data;
    },
    async removeRow(userId, id) {
      const { data, error } = await admin()
        .from("campaign_media")
        .delete()
        .eq("user_id", userId)
        .eq("id", id)
        .select("id, user_id, kind, storage_path, public_url, created_at")
        .maybeSingle();
      if (error) throw asStorageError(error);
      return data;
    },
    async upload(path, bytes, contentType) {
      const { error } = await admin().storage.from(BUCKET).upload(path, bytes, {
        contentType,
        upsert: true,
      });
      if (error) throw asStorageError(error);
    },
    async removeFiles(paths) {
      const clean = paths.filter(Boolean);
      if (clean.length === 0) return;
      const { error } = await admin().storage.from(BUCKET).remove(clean);
      if (error) throw asStorageError(error);
    },
  };
}

async function defaultGetUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  if (process.env.OTP_PROVIDER === "demo" && token.startsWith("demo-")) {
    return { id: token.slice("demo-".length) };
  }
  const { data, error } = await getSupabasePublic().auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

function imageBody(req, res, next) {
  return express.raw({
    type: ["image/jpeg", "image/png", "image/webp"],
    limit: MAX_BYTES,
  })(req, res, (err) => {
    if (err && (err.type === "entity.too.large" || err.status === 413)) {
      return res.status(413).json({ error: "file_too_large" });
    }
    return next(err);
  });
}

function declaredType(req) {
  return String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
}

function readImage(req) {
  const bytes = req.body;
  const sniffed = sniffImage(Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(0));
  const declared = declaredType(req);
  if (!sniffed || sniffed !== declared) return null;
  return { bytes, type: sniffed, ext: extensionFor(sniffed) };
}

function toApi(row) {
  return {
    id: row.id,
    userId: row.user_id,
    url: row.public_url,
    kind: row.kind,
  };
}

function collection(userId, rows) {
  const logos = rows.filter((row) => row.kind === "logo");
  return {
    userId,
    logo: logos.length ? toApi(logos[logos.length - 1]) : null,
    photos: rows.filter((row) => row.kind === "photo").map(toApi),
  };
}

async function sendFailure(res, next, err) {
  const wrapped = asStorageError(err);
  if (wrapped.code === "storage_not_ready") {
    return res.status(503).json({ error: "storage_not_ready" });
  }
  return next(wrapped);
}

function createCampaignMediaRouter(options = {}) {
  const router = express.Router();
  const store = options.store || createSupabaseMediaStore();
  const getUser = options.getUser || defaultGetUser;
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL || "";

  async function requireUser(req, res) {
    try {
      const user = await getUser(req);
      if (!user || !isUuid(user.id)) {
        res.status(401).json({ error: "unauthorized" });
        return null;
      }
      return user.id;
    } catch (err) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
  }

  router.get("/", async (req, res, next) => {
    const userId = await requireUser(req, res);
    if (!userId) return undefined;
    try {
      const rows = await store.list(userId);
      return res.json(collection(userId, rows));
    } catch (err) {
      return sendFailure(res, next, err);
    }
  });

  router.post("/logo", imageBody, async (req, res, next) => {
    const userId = await requireUser(req, res);
    if (!userId) return undefined;
    if (!supabaseUrl) return res.status(503).json({ error: "storage_not_ready" });
    const image = readImage(req);
    if (!image) return res.status(400).json({ error: "invalid_photo" });

    const path = `${userId}/logo.${image.ext}`;
    const row = {
      id: crypto.randomUUID(),
      user_id: userId,
      kind: "logo",
      storage_path: path,
      public_url: publicMediaUrl(supabaseUrl, path),
      created_at: new Date().toISOString(),
    };
    try {
      await store.upload(path, image.bytes, image.type);
      const previous = (await store.list(userId)).filter((item) => item.kind === "logo");
      for (const item of previous) {
        await store.removeRow(userId, item.id);
      }
      let inserted;
      try {
        inserted = await store.insert(row);
      } catch (err) {
        for (const item of previous) {
          try {
            await store.insert(item);
          } catch (_) {
            // Keep the original logo row if the replacement row cannot be saved.
          }
        }
        throw err;
      }
      const stale = previous
        .map((item) => item.storage_path)
        .filter((itemPath) => itemPath && itemPath !== path);
      await store.removeFiles(stale);
      return res.status(201).json({ logo: toApi(inserted) });
    } catch (err) {
      return sendFailure(res, next, err);
    }
  });

  router.delete("/logo", async (req, res, next) => {
    const userId = await requireUser(req, res);
    if (!userId) return undefined;
    try {
      const previous = (await store.list(userId)).filter((item) => item.kind === "logo");
      for (const item of previous) {
        await store.removeRow(userId, item.id);
      }
      await store.removeFiles(previous.map((item) => item.storage_path));
      return res.json({ logo: null, userId });
    } catch (err) {
      return sendFailure(res, next, err);
    }
  });

  router.post("/photos", imageBody, async (req, res, next) => {
    const userId = await requireUser(req, res);
    if (!userId) return undefined;
    if (!supabaseUrl) return res.status(503).json({ error: "storage_not_ready" });
    const image = readImage(req);
    if (!image) return res.status(400).json({ error: "invalid_photo" });

    const id = crypto.randomUUID();
    const path = `${userId}/photos/${id}.${image.ext}`;
    const row = {
      id,
      user_id: userId,
      kind: "photo",
      storage_path: path,
      public_url: publicMediaUrl(supabaseUrl, path),
      created_at: new Date().toISOString(),
    };
    try {
      const existing = (await store.list(userId)).filter((item) => item.kind === "photo");
      if (existing.length >= MAX_PHOTOS) {
        return res.status(400).json({ error: "too_many_photos" });
      }
      await store.upload(path, image.bytes, image.type);
      let inserted;
      try {
        inserted = await store.insert(row);
      } catch (err) {
        await store.removeFiles([path]);
        throw err;
      }
      const photos = (await store.list(userId)).filter((item) => item.kind === "photo");
      if (photos.length > MAX_PHOTOS) {
        await store.removeRow(userId, id);
        await store.removeFiles([path]);
        return res.status(400).json({ error: "too_many_photos" });
      }
      return res.status(201).json({ photo: toApi(inserted) });
    } catch (err) {
      return sendFailure(res, next, err);
    }
  });

  router.delete("/photos/:id", async (req, res, next) => {
    const userId = await requireUser(req, res);
    if (!userId) return undefined;
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "not_found" });
    try {
      const match = (await store.list(userId)).find(
        (row) => row.id === req.params.id && row.kind === "photo",
      );
      if (!match) return res.status(404).json({ error: "not_found" });
      const removed = await store.removeRow(userId, match.id);
      if (!removed) return res.status(404).json({ error: "not_found" });
      await store.removeFiles([removed.storage_path]);
      return res.json({ deleted: true, id: removed.id, userId });
    } catch (err) {
      return sendFailure(res, next, err);
    }
  });

  return router;
}

module.exports = {
  createCampaignMediaRouter,
  createMemoryMediaStore,
  sniffImage,
  publicMediaUrl,
  MAX_PHOTOS,
  MAX_BYTES,
  BUCKET,
};

const express = require("express");

const colors = ["White", "Black", "Navy", "Saffron", "Green", "Red"];

const catalog = [
  product("t-shirt", "T-shirt", "Printed with the line you supply.", "apparel", ["S", "M", "L", "XL", "XXL"], 1),
  product("scarf", "Scarf", "A scarf printed with the line you supply.", "apparel", ["One size"], 2),
  product("flag", "Flag", "A flag printed with the line you supply.", "rally", ["Small", "Medium", "Large"], 3),
  product("badge", "Badge", "A badge printed with the line you supply.", "rally", ["Standard"], 4),
  product("cap", "Cap", "A cap printed with the line you supply.", "apparel", ["Free size"], 5),
  product("mug", "Mug", "A mug printed with the line you supply.", "gift", ["330 ml"], 6),
  product("poster", "Poster", "A poster printed with the line you supply.", "print", ["A4", "A3", "A2"], 7),
  product("sticker", "Sticker", "Stickers printed with the line you supply.", "print", ["Small", "Sheet"], 8),
  product("bag", "Bag", "A bag printed with the line you supply.", "gift", ["Standard"], 9),
  product("pen", "Pen", "A pen printed with the line you supply.", "gift", ["Standard"], 10),
  product("keychain", "Keychain", "A keychain printed with the line you supply.", "gift", ["Standard"], 11),
  product("gift-box", "Gift box", "A gift box printed with the line you supply.", "gift", ["Standard"], 12),
];

function product(slug, name, description, kind, sizes, sortOrder) {
  return {
    slug,
    name,
    description,
    kind,
    sizes,
    colors,
    sort_order: sortOrder,
    active: true,
  };
}

function validateOrder(body) {
  const source = body && typeof body === "object" ? body : {};
  const item = catalog.find((entry) => entry.slug === source.product_slug);
  if (!item) {
    return { error: "unknown_product" };
  }

  const campaignLine = String(source.campaign_line || "").trim();
  if (!campaignLine || campaignLine.length > 80) {
    return { error: "invalid_line" };
  }

  const quantity = Number(source.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
    return { error: "invalid_quantity" };
  }

  const contactName = String(source.contact_name || "").trim();
  if (!contactName || contactName.length > 80) {
    return { error: "invalid_name" };
  }

  const size = String(source.size || item.sizes[0] || "").trim();
  if (item.sizes.length > 0 && !item.sizes.includes(size)) {
    return { error: "invalid_size" };
  }

  const color = String(source.color || "").trim();
  if (color && !item.colors.includes(color)) {
    return { error: "invalid_color" };
  }

  const contactPhone = String(source.contact_phone || "").trim();
  if (contactPhone && !/^\+?[0-9][0-9\s-]{6,18}$/.test(contactPhone)) {
    return { error: "invalid_phone" };
  }

  return {
    value: {
      product_slug: item.slug,
      product_name: item.name,
      campaign_line: campaignLine,
      size,
      color,
      quantity,
      contact_name: contactName,
      contact_phone: contactPhone,
      notes: String(source.notes || "").trim().slice(0, 400),
      status: "requested",
    },
  };
}

function createMerchandiseRouter(options = {}) {
  const router = express.Router();
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL || "";
  const secretKey = options.secretKey || process.env.SUPABASE_SECRET_KEY || "";
  const publishableKey = options.publishableKey || process.env.SUPABASE_PUBLISHABLE_KEY || "";
  const fetchImpl = options.fetchImpl || fetch;

  router.get("/products", async (_req, res) => {
    const stored = await readProducts(fetchImpl, supabaseUrl, secretKey);
    res.json({
      products: stored.products,
      storageReady: stored.storageReady,
    });
  });

  router.get("/orders", async (req, res) => {
    const userId = await userIdFromAuth(fetchImpl, supabaseUrl, publishableKey, req.headers.authorization);
    if (!userId) {
      res.json({ orders: [] });
      return;
    }
    const result = await readOrders(fetchImpl, supabaseUrl, secretKey, userId);
    if (!result.ok) {
      res.status(503).json({ error: "merchandise_not_ready" });
      return;
    }
    res.json({ orders: result.orders });
  });

  router.post("/orders", async (req, res) => {
    const parsed = validateOrder(req.body);
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    if (!supabaseUrl || !secretKey) {
      res.status(503).json({ error: "merchandise_not_ready" });
      return;
    }

    const userId = await userIdFromAuth(fetchImpl, supabaseUrl, publishableKey, req.headers.authorization);
    const row = { ...parsed.value };
    if (userId) {
      row.profile_id = userId;
    }

    const saved = await insertOrder(fetchImpl, supabaseUrl, secretKey, row);
    if (saved.missingProfile && userId) {
      delete row.profile_id;
      const retry = await insertOrder(fetchImpl, supabaseUrl, secretKey, row);
      if (!retry.ok) {
        res.status(retry.notReady ? 503 : 502).json({ error: retry.notReady ? "merchandise_not_ready" : "save_failed" });
        return;
      }
      res.status(201).json({ order: retry.order });
      return;
    }

    if (!saved.ok) {
      res.status(saved.notReady ? 503 : 502).json({ error: saved.notReady ? "merchandise_not_ready" : "save_failed" });
      return;
    }
    res.status(201).json({ order: saved.order });
  });

  return router;
}

async function readProducts(fetchImpl, supabaseUrl, secretKey) {
  if (!supabaseUrl || !secretKey) {
    return { products: catalog, storageReady: false };
  }

  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    "/rest/v1/merchandise_products?select=slug,name,description,kind,sizes,colors,sort_order,active&active=eq.true&order=sort_order.asc",
  );
  if (!response.ok) {
    return { products: catalog, storageReady: false };
  }

  const rows = Array.isArray(response.body) ? response.body : [];
  if (rows.length === 0) {
    await seedProducts(fetchImpl, supabaseUrl, secretKey);
    return { products: catalog, storageReady: true };
  }
  return { products: rows, storageReady: true };
}

async function seedProducts(fetchImpl, supabaseUrl, secretKey) {
  await supabaseFetch(fetchImpl, supabaseUrl, secretKey, "/rest/v1/merchandise_products?on_conflict=slug", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: catalog,
  });
}

async function readOrders(fetchImpl, supabaseUrl, secretKey, userId) {
  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/merchandise_orders?select=id,product_name,campaign_line,size,color,quantity,status,created_at&profile_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`,
  );
  if (!response.ok) {
    return { ok: false, orders: [] };
  }
  return { ok: true, orders: Array.isArray(response.body) ? response.body : [] };
}

async function insertOrder(fetchImpl, supabaseUrl, secretKey, row) {
  const response = await supabaseFetch(fetchImpl, supabaseUrl, secretKey, "/rest/v1/merchandise_orders", {
    method: "POST",
    prefer: "return=representation",
    body: row,
  });
  if (response.ok) {
    const order = Array.isArray(response.body) ? response.body[0] : response.body;
    return { ok: true, order };
  }
  const code = response.body && response.body.code;
  return {
    ok: false,
    notReady: response.status === 404 || code === "PGRST205" || code === "42P01",
    missingProfile: code === "23503",
  };
}

async function userIdFromAuth(fetchImpl, supabaseUrl, publishableKey, header) {
  if (!supabaseUrl || !publishableKey || !header || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    return null;
  }
  try {
    const response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return typeof body.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}

async function supabaseFetch(fetchImpl, supabaseUrl, secretKey, path, options = {}) {
  try {
    const response = await fetchImpl(`${supabaseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        ...(options.prefer ? { Prefer: options.prefer } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

module.exports = {
  catalog,
  validateOrder,
  createMerchandiseRouter,
};

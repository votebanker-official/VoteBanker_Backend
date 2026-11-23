const express = require("express");
const { trackRequest } = require("./admin/activity");
const { PRESET_QUANTITIES, isOrderQuantity, normalizeSlabs, quoteMerchandise } = require("./merchandise_pricing");

const configuredUnitPrices = {
  "t-shirt": 19900,
  scarf: 5000,
  flag: 10000,
  badge: 6000,
  cap: 12000,
  mug: 8000,
  poster: 15000,
  sticker: 2000,
  keychain: 4000,
  pen: 1000,
  bag: 15000,
  "gift-box": 5000,
};

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

function validateOrder(body, options = {}) {
  const source = body && typeof body === "object" ? body : {};
  const item = catalog.find((entry) => entry.slug === source.product_slug);
  if (!item) {
    return { error: "unknown_product" };
  }

  const campaignLine = String(source.campaign_line || "").trim();
  if (campaignLine.length > 80) {
    return { error: "invalid_line" };
  }

  const quantity = Number(source.quantity);
  if (!isOrderQuantity(quantity)) {
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

  const contactEmail = String(source.contact_email || "").trim();
  if (contactEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) || contactEmail.length > 160)) {
    return { error: "invalid_email" };
  }

  // Optional print photo as base64 (or data-URL). Cap keeps order rows reasonable.
  let campaignPhoto = String(source.campaign_photo || "").trim();
  if (campaignPhoto) {
    const marker = "base64,";
    const markerAt = campaignPhoto.indexOf(marker);
    if (markerAt >= 0) {
      campaignPhoto = campaignPhoto.slice(markerAt + marker.length);
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(campaignPhoto) || campaignPhoto.length > 900000) {
      return { error: "invalid_photo" };
    }
    campaignPhoto = campaignPhoto.replace(/\s+/g, "");
  }

  const priced = quoteMerchandise(options.priceSlabs, quantity);
  const value = {
    product_slug: item.slug,
    product_name: item.name,
    campaign_line: campaignLine,
    campaign_photo: campaignPhoto,
    size,
    color,
    quantity,
    contact_name: contactName,
    contact_phone: contactPhone,
    contact_email: contactEmail,
    notes: String(source.notes || "").trim().slice(0, 400),
    status: "pending",
  };
  if (!priced.error) {
    value.unit_price_paise = priced.unit_price_paise;
    value.line_total_paise = priced.line_total_paise;
  }
  return { value };
}

function fillOrderContact(value, profile) {
  const source = profile && typeof profile === "object" ? profile : {};
  const profileName = String(source.full_name || "").trim();
  const profileEmail = String(source.contact_email || "").trim();
  const profilePhone = String(source.public_contact || source.phone || "").trim();
  const currentName = String(value.contact_name || "").trim();
  if (!currentName || currentName.toLowerCase() === "leader") {
    if (profileName) value.contact_name = profileName.slice(0, 80);
  }
  if (!String(value.contact_email || "").trim() && profileEmail) {
    value.contact_email = profileEmail.slice(0, 160);
  }
  if (!String(value.contact_phone || "").trim() && profilePhone) {
    value.contact_phone = profilePhone.slice(0, 20);
  }
  if (!String(value.contact_name || "").trim()) {
    return { error: "invalid_name" };
  }
  return { value };
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

  router.post("/quote", async (req, res) => {
    const stored = await readProducts(fetchImpl, supabaseUrl, secretKey);
    const source = req.body && typeof req.body === "object" ? req.body : {};
    const item = stored.products.find((entry) => entry.slug === source.product_slug);
    if (!item || item.available === false) {
      res.status(400).json({ error: "unknown_product" });
      return;
    }
    const quantity = Number(source.quantity);
    const priced = quoteMerchandise(item.price_slabs, quantity);
    if (priced.error) {
      res.status(priced.error === "invalid_quantity" ? 400 : 409).json({ error: priced.error });
      return;
    }
    res.json({
      product_slug: item.slug,
      product_name: item.name,
      quantity,
      unit_price_paise: priced.unit_price_paise,
      line_total_paise: priced.line_total_paise,
      currency: priced.currency,
    });
  });

  router.post("/orders", async (req, res) => {
    const stored = await readProducts(fetchImpl, supabaseUrl, secretKey);
    const source = req.body && typeof req.body === "object" ? req.body : {};
    const item = stored.products.find((entry) => entry.slug === source.product_slug);
    const parsed = validateOrder(req.body, { priceSlabs: item && item.price_slabs });
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    if (!supabaseUrl || !secretKey) {
      res.status(503).json({ error: "merchandise_not_ready" });
      return;
    }

    const userId = await userIdFromAuth(fetchImpl, supabaseUrl, publishableKey, req.headers.authorization);
    if (!userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const profile = await profileContact(fetchImpl, supabaseUrl, secretKey, userId);
    const filled = fillOrderContact(parsed.value, profile);
    if (filled.error) {
      res.status(400).json({ error: filled.error });
      return;
    }
    const row = { ...filled.value, profile_id: userId };

    let saved = await insertOrder(fetchImpl, supabaseUrl, secretKey, row);
    if (saved.unknownColumn && Object.prototype.hasOwnProperty.call(row, "contact_email")) {
      delete row.contact_email;
      saved = await insertOrder(fetchImpl, supabaseUrl, secretKey, row);
    }
    if (saved.unknownColumn) {
      delete row.unit_price_paise;
      delete row.line_total_paise;
      saved = await insertOrder(fetchImpl, supabaseUrl, secretKey, row);
      if (saved.ok && parsed.value.unit_price_paise != null) {
        saved.order = {
          ...saved.order,
          unit_price_paise: parsed.value.unit_price_paise,
          line_total_paise: parsed.value.line_total_paise,
        };
      }
    }
    if (saved.missingProfile && userId) {
      delete row.profile_id;
      const retry = await insertOrder(fetchImpl, supabaseUrl, secretKey, row);
      if (!retry.ok) {
        res.status(retry.notReady ? 503 : 502).json({ error: retry.notReady ? "merchandise_not_ready" : "save_failed" });
        return;
      }
      res.status(201).json({ order: retry.order });
      await trackRequest(req, {
        eventType: "purchase",
        description: `Requested ${retry.order.product_name || "merchandise"}`,
        resourceType: "merchandise_order",
        resourceId: retry.order && retry.order.id,
        status: "requested",
        dedupeKey: retry.order && retry.order.id ? `purchase:${retry.order.id}` : undefined,
      });
      return;
    }

    if (!saved.ok) {
      res.status(saved.notReady ? 503 : 502).json({ error: saved.notReady ? "merchandise_not_ready" : "save_failed" });
      return;
    }
    res.status(201).json({ order: saved.order });
    await trackRequest(req, {
      eventType: "purchase",
      description: `Requested ${saved.order.product_name || "merchandise"}`,
      resourceType: "merchandise_order",
      resourceId: saved.order && saved.order.id,
      status: "requested",
      dedupeKey: saved.order && saved.order.id ? `purchase:${saved.order.id}` : undefined,
    });
  });

  return router;
}

function publishProduct(item) {
  return {
    slug: item.slug,
    name: item.name,
    description: item.description || "",
    kind: item.kind,
    sizes: Array.isArray(item.sizes) ? item.sizes : [],
    colors: Array.isArray(item.colors) ? item.colors : colors,
    sort_order: item.sort_order,
    active: item.active !== false,
    available: item.active !== false && item.available !== false,
    minimum_order_quantity: 50,
    price_slabs: priceSlabsFor(item.slug, item.price_slabs),
  };
}

function priceSlabsFor(slug, stored) {
  const rows = normalizeSlabs(stored);
  if (rows.length > 0) {
    return rows;
  }
  const unit = configuredUnitPrices[slug];
  if (!Number.isInteger(unit)) {
    return [];
  }
  return PRESET_QUANTITIES.map((minQuantity) => ({
    min_quantity: minQuantity,
    unit_price_paise: unit,
  }));
}

async function readProducts(fetchImpl, supabaseUrl, secretKey) {
  const fallback = catalog.map(publishProduct);
  if (!supabaseUrl || !secretKey) {
    return { products: fallback, storageReady: false };
  }

  const withSlabs = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    "/rest/v1/merchandise_products?select=slug,name,description,kind,sizes,colors,sort_order,active,price_slabs&active=eq.true&order=sort_order.asc",
  );
  const response = withSlabs.ok
    ? withSlabs
    : await supabaseFetch(
        fetchImpl,
        supabaseUrl,
        secretKey,
        "/rest/v1/merchandise_products?select=slug,name,description,kind,sizes,colors,sort_order,active&active=eq.true&order=sort_order.asc",
      );
  if (!response.ok) {
    return { products: fallback, storageReady: false };
  }

  const rows = Array.isArray(response.body) ? response.body : [];
  if (rows.length === 0) {
    await seedProducts(fetchImpl, supabaseUrl, secretKey);
    return { products: fallback, storageReady: true };
  }
  return { products: rows.map(publishProduct), storageReady: true };
}

async function seedProducts(fetchImpl, supabaseUrl, secretKey) {
  await supabaseFetch(fetchImpl, supabaseUrl, secretKey, "/rest/v1/merchandise_products?on_conflict=slug", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: catalog,
  });
}

async function profileContact(fetchImpl, supabaseUrl, secretKey, userId) {
  if (!supabaseUrl || !secretKey || !userId) return null;
  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/profiles?select=full_name,contact_email,phone,public_contact&id=eq.${encodeURIComponent(userId)}&limit=1`,
  );
  if (!response.ok || !Array.isArray(response.body)) return null;
  return response.body[0] || null;
}

async function readOrders(fetchImpl, supabaseUrl, secretKey, userId) {
  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/merchandise_orders?select=id,product_name,campaign_line,campaign_photo,size,color,quantity,unit_price_paise,line_total_paise,status,created_at&profile_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`,
  );
  if (!response.ok) {
    const plain = await supabaseFetch(
      fetchImpl,
      supabaseUrl,
      secretKey,
      `/rest/v1/merchandise_orders?select=id,product_name,campaign_line,campaign_photo,size,color,quantity,status,created_at&profile_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`,
    );
    if (!plain.ok) {
      return { ok: false, orders: [] };
    }
    return { ok: true, orders: Array.isArray(plain.body) ? plain.body : [] };
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
    unknownColumn: code === "42703" || code === "PGRST204",
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
  fillOrderContact,
  quoteMerchandise,
  priceSlabsFor,
  createMerchandiseRouter,
};

const express = require("express");

const { authenticate } = require("../admin/access");
const { getSupabaseAdmin } = require("../lib/clients");

const OFFERS = {
  instagram: { serviceName: "Instagram", priceInr: 799, platforms: ["instagram"] },
  facebook: { serviceName: "Facebook", priceInr: 799, platforms: ["facebook"] },
  whatsapp: { serviceName: "WhatsApp", priceInr: 999, platforms: ["whatsapp"] },
  bundle: {
    serviceName: "Get all 3 Blue Tik",
    priceInr: 1999,
    platforms: ["instagram", "facebook", "whatsapp"],
  },
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeMobile(input) {
  const cleaned = String(input || "").replace(/[\s\-()]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(cleaned)) return cleaned;
  if (/^\d{10}$/.test(cleaned)) return `+91${cleaned}`;
  return "";
}

function isProfileUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}

function validateBlueTikBody(body) {
  const source = body && typeof body === "object" ? body : {};
  const offer = OFFERS[source.offerId];
  if (!offer) return { error: "invalid_offer" };
  const leaderName = String(source.leaderName || "").trim();
  const mobile = normalizeMobile(source.mobile);
  const email = String(source.email || "").trim();
  const urls = source.profileUrls && typeof source.profileUrls === "object" ? source.profileUrls : {};
  if (leaderName.length < 2 || leaderName.length > 120) return { error: "name_required" };
  if (!mobile) return { error: "mobile_invalid" };
  if (!EMAIL.test(email) || email.length > 160) return { error: "email_invalid" };
  const profileUrls = {};
  for (const platform of offer.platforms) {
    const value = String(urls[platform] || "").trim();
    if (!isProfileUrl(value) || value.length > 300) return { error: "url_invalid", platform };
    profileUrls[platform] = value;
  }
  return {
    row: {
      offer_id: source.offerId,
      service_name: offer.serviceName,
      price_inr: offer.priceInr,
      leader_name: leaderName,
      mobile,
      email,
      profile_urls: profileUrls,
      status: "pending",
    },
  };
}

function publicRequest(row) {
  const urls = row.profile_urls && typeof row.profile_urls === "object" ? row.profile_urls : {};
  return {
    id: row.id,
    userId: row.user_id,
    offerId: row.offer_id,
    serviceName: row.service_name,
    priceInr: row.price_inr,
    leaderName: row.leader_name,
    mobile: row.mobile,
    email: row.email,
    profileUrls: urls,
    status: row.status,
    createdAt: row.created_at,
  };
}

function schemaError(error) {
  const message = (error && error.message) || "";
  if (error && (error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(message))) {
    const err = new Error("admin_not_ready");
    err.code = "admin_not_ready";
    return err;
  }
  return error;
}

async function listBlueTikRequests(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const term = String(query.q || "").trim().replace(/[%_,]/g, "");
  let request = getSupabaseAdmin()
    .from("blue_tik_requests")
    .select("id, user_id, offer_id, service_name, price_inr, leader_name, mobile, email, profile_urls, status, created_at", { count: "exact" })
    .order("created_at", { ascending: false });
  if (term) {
    const pattern = `%${term}%`;
    request = request.or(`leader_name.ilike.${pattern},email.ilike.${pattern},mobile.ilike.${pattern},service_name.ilike.${pattern}`);
  }
  const from = (page - 1) * pageSize;
  const { data, error, count } = await request.range(from, from + pageSize - 1);
  if (error) throw schemaError(error);
  return {
    page,
    pageSize,
    total: count || 0,
    requests: (data || []).map(publicRequest),
  };
}

function createBlueTikRouter() {
  const router = express.Router();

  router.post("/requests", async (req, res, next) => {
    try {
      const user = await authenticate(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      const parsed = validateBlueTikBody(req.body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const { data, error } = await getSupabaseAdmin()
        .from("blue_tik_requests")
        .insert({ ...parsed.row, user_id: user.id })
        .select("id, user_id, offer_id, service_name, price_inr, leader_name, mobile, email, profile_urls, status, created_at")
        .single();
      if (error) throw schemaError(error);
      res.status(201).json({ request: publicRequest(data) });
    } catch (err) {
      if (err && err.code === "admin_not_ready") return res.status(503).json({ error: "admin_not_ready" });
      next(err);
    }
  });

  return router;
}

module.exports = { createBlueTikRouter, listBlueTikRequests, validateBlueTikBody, OFFERS };

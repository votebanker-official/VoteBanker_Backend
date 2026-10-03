const express = require("express");

const { getSupabaseAdmin, getSupabasePublic } = require("../lib/clients");

const router = express.Router();

const COLUMNS =
  "id, full_name, phone, selected_domain, language, designation, organization, country, " +
  "state_region, constituency, public_contact, website_template, social_channels, " +
  "vrm_requested, created_at, updated_at";

// request field -> [column, max length]. Only these can be written by a client.
const TEXT_FIELDS = {
  full_name: ["full_name", 120],
  selected_domain: ["selected_domain", 253],
  language: ["language", 10],
  designation: ["designation", 120],
  organization: ["organization", 160],
  country: ["country", 80],
  state_region: ["state_region", 80],
  constituency: ["constituency", 120],
  public_contact: ["public_contact", 160],
  website_template: ["website_template", 60],
};

// Validates the Supabase access token from the Authorization header.
async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "unauthorized" });

    const { data, error } = await getSupabasePublic().auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "unauthorized" });

    req.user = data.user;
    next();
  } catch (err) {
    next(err);
  }
}

router.get("/", requireUser, async (req, res, next) => {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("profiles")
      .select(COLUMNS)
      .eq("id", req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    next(err);
  }
});

router.put("/", requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    const phone = req.user.phone ? `+${String(req.user.phone).replace("+", "")}` : null;
    const update = { id: req.user.id, phone };

    for (const [field, [column, max]] of Object.entries(TEXT_FIELDS)) {
      if (typeof body[field] === "string") update[column] = body[field].trim().slice(0, max);
    }
    if (Array.isArray(body.social_channels)) {
      update.social_channels = body.social_channels
        .filter((c) => typeof c === "string")
        .map((c) => c.trim().slice(0, 40))
        .slice(0, 20);
    }
    if (typeof body.vrm_requested === "boolean") update.vrm_requested = body.vrm_requested;

    const { data, error } = await getSupabaseAdmin()
      .from("profiles")
      .upsert(update, { onConflict: "id" })
      .select(COLUMNS)
      .single();
    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

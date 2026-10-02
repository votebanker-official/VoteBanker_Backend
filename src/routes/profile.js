const express = require("express");

const { getSupabaseAdmin, getSupabasePublic } = require("../lib/clients");

const router = express.Router();

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
      .select("id, full_name, phone, selected_domain, language, created_at, updated_at")
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
    const update = { id: req.user.id, phone: req.user.phone ? `+${req.user.phone.replace("+", "")}` : null };

    if (typeof body.full_name === "string") update.full_name = body.full_name.trim().slice(0, 120);
    if (typeof body.selected_domain === "string") update.selected_domain = body.selected_domain.trim().slice(0, 253);
    if (typeof body.language === "string") update.language = body.language.trim().slice(0, 10);

    const { data, error } = await getSupabaseAdmin()
      .from("profiles")
      .upsert(update, { onConflict: "id" })
      .select()
      .single();
    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

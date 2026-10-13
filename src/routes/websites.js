const express = require("express");

const { getSupabaseAdmin, getSupabasePublic } = require("../lib/clients");

const router = express.Router();

const TEMPLATE_IDS = new Set([
  "professional",
  "official",
  "community",
  "modern",
  "traditional",
  "peopleFirst",
]);

const STATUSES = new Set([
  "draft",
  "pending_payment",
  "ready_to_publish",
  "published",
]);

function normalizeTemplateId(value) {
  const raw = String(value || "").trim();
  if (raw === "traditional" || raw === "work" || raw === "official") return "official";
  if (raw === "peopleFirst" || raw === "issue" || raw === "community") return "community";
  if (raw === "modern" || raw === "public" || raw === "professional") return "professional";
  return "professional";
}

function normalizeStatus(value) {
  const raw = String(value || "").trim();
  return STATUSES.has(raw) ? raw : "draft";
}

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

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sanitizeText(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function validateProfileData(profile) {
  const source = asObject(profile);
  const fullName = sanitizeText(source.fullName, 120);
  const designation = sanitizeText(source.designation, 120);
  const constituency = sanitizeText(source.constituency, 160);
  const shortIntro = sanitizeText(source.shortIntro, 600);
  const email = sanitizeText(source.email, 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "invalid_email", status: 400 };
  }
  return {
    value: {
      fullName,
      designation,
      profilePhoto: asObject(source.profilePhoto),
      coverPhoto: asObject(source.coverPhoto),
      constituency,
      district: sanitizeText(source.district, 120),
      state: sanitizeText(source.state, 120),
      party: sanitizeText(source.party, 160),
      shortIntro,
      biography: sanitizeText(source.biography, 5000),
      phone: sanitizeText(source.phone, 40),
      email,
      officeAddress: sanitizeText(source.officeAddress, 400),
      facebookUrl: sanitizeText(source.facebookUrl, 300),
      instagramUrl: sanitizeText(source.instagramUrl, 300),
      youtubeUrl: sanitizeText(source.youtubeUrl, 300),
      twitterUrl: sanitizeText(source.twitterUrl, 300),
      linkedinUrl: sanitizeText(source.linkedinUrl, 300),
    },
  };
}

function toApiWebsite(row) {
  if (!row) return null;
  return {
    id: row.id,
    templateId: normalizeTemplateId(row.template_id),
    websiteName: row.website_name || "",
    slug: row.slug || null,
    status: normalizeStatus(row.status),
    profileData: row.profile_data || {},
    templateContent: row.template_content || {},
    designSettings: row.design_settings || {},
    publishedUrl: row.published_url || null,
    publishedAt: row.published_at || null,
    paymentVerified: Boolean(row.payment_verified),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildUpsert(body, userId, existing) {
  const source = asObject(body);
  const templateId = normalizeTemplateId(source.templateId || existing?.template_id);
  if (!TEMPLATE_IDS.has(templateId) && !TEMPLATE_IDS.has(source.templateId)) {
    return { error: "invalid_template", status: 400 };
  }

  const profileCheck = validateProfileData(source.profileData);
  if (profileCheck.error) return profileCheck;

  const design = asObject(source.designSettings);
  const websiteName =
    sanitizeText(source.websiteName, 160) ||
    sanitizeText(design.websiteName, 160) ||
    sanitizeText(existing?.website_name, 160);

  let status = normalizeStatus(source.status || existing?.status || "draft");
  // Clients cannot mark a website published without the publish endpoint.
  if (status === "published" && !(existing && existing.payment_verified)) {
    status = existing?.status === "published" ? "published" : "draft";
  }

  return {
    value: {
      user_id: userId,
      template_id: templateId,
      website_name: websiteName,
      status,
      profile_data: profileCheck.value,
      template_content: asObject(source.templateContent),
      design_settings: {
        ...design,
        websiteName: websiteName || sanitizeText(design.websiteName, 160),
      },
      updated_at: new Date().toISOString(),
    },
  };
}

router.get("/me", requireUser, async (req, res, next) => {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("websites")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "not_found" });
    res.json({ website: toApiWebsite(data) });
  } catch (err) {
    next(err);
  }
});

router.put("/me", requireUser, async (req, res, next) => {
  try {
    const admin = getSupabaseAdmin();
    const { data: existing, error: readError } = await admin
      .from("websites")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();
    if (readError) throw readError;

    const built = buildUpsert(req.body, req.user.id, existing);
    if (built.error) return res.status(built.status).json({ error: built.error });

    const payload = existing
      ? { ...built.value, id: existing.id }
      : { ...built.value, created_at: new Date().toISOString() };

    const { data, error } = await admin
      .from("websites")
      .upsert(payload, { onConflict: "user_id" })
      .select("*")
      .single();
    if (error) throw error;

    // Keep profile.website_template in sync for onboarding.
    await admin
      .from("profiles")
      .upsert(
        {
          id: req.user.id,
          website_template: normalizeTemplateId(data.template_id),
        },
        { onConflict: "id" }
      );

    res.json({ website: toApiWebsite(data) });
  } catch (err) {
    next(err);
  }
});

router.post("/me/publish", requireUser, async (req, res, next) => {
  try {
    const admin = getSupabaseAdmin();
    const { data: existing, error: readError } = await admin
      .from("websites")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();
    if (readError) throw readError;
    if (!existing) return res.status(404).json({ error: "not_found" });

    const profile = asObject(existing.profile_data);
    const design = asObject(existing.design_settings);
    const websiteName =
      sanitizeText(req.body?.websiteName, 160) ||
      sanitizeText(existing.website_name, 160) ||
      sanitizeText(design.websiteName, 160);

    const missing = [];
    if (!sanitizeText(profile.fullName, 120)) missing.push("fullName");
    if (!sanitizeText(profile.designation, 120)) missing.push("designation");
    if (!sanitizeText(profile.constituency, 160)) missing.push("constituency");
    if (!sanitizeText(profile.shortIntro, 600)) missing.push("shortIntro");
    if (!websiteName) missing.push("websiteName");
    const photo = asObject(profile.profilePhoto);
    if (!photo.url && !photo.base64) missing.push("profilePhoto");
    if (missing.length) {
      return res.status(400).json({ error: "validation_failed", missing });
    }

    // Never trust a frontend-only payment success flag.
    if (!existing.payment_verified) {
      const { data: pending, error: pendingError } = await admin
        .from("websites")
        .update({
          status: "pending_payment",
          website_name: websiteName,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", req.user.id)
        .select("*")
        .single();
      if (pendingError) throw pendingError;
      return res.status(402).json({
        error: "payment_required",
        website: toApiWebsite(pending),
      });
    }

    const slugBase = websiteName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const publishedUrl = `https://${slugBase || "leader"}.votebanker.app`;

    const { data, error } = await admin
      .from("websites")
      .update({
        status: "published",
        website_name: websiteName,
        slug: slugBase || null,
        published_url: publishedUrl,
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", req.user.id)
      .select("*")
      .single();
    if (error) throw error;

    res.json({ website: toApiWebsite(data) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.normalizeTemplateId = normalizeTemplateId;
module.exports.buildUpsert = buildUpsert;

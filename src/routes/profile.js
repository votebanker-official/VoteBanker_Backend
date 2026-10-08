const express = require("express");

const { getSupabaseAdmin, getSupabasePublic } = require("../lib/clients");
const { validateLocationIds } = require("../locations");

const router = express.Router();

const PHOTO_BUCKET = "profile-photos";

const COLUMNS =
  "id, full_name, phone, selected_domain, language, designation, organization, country, " +
  "country_code, state_id, district_id, assembly_constituency_id, " +
  "state_region, constituency, public_contact, website_template, social_channels, " +
  "vrm_requested, booth_number, booth_name, profile_photo_path, created_at, updated_at";

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
  booth_number: ["booth_number", 40],
  booth_name: ["booth_name", 120],
};

const OPTIONAL_TEXT = new Set(["booth_number", "booth_name"]);

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

function buildProfileUpdate(body, user) {
  const source = body && typeof body === "object" ? body : {};
  const phone = user && user.phone ? `+${String(user.phone).replace("+", "")}` : null;
  const update = { id: user.id, phone };

  for (const [field, [column, max]] of Object.entries(TEXT_FIELDS)) {
    if (typeof source[field] !== "string") continue;
    const value = source[field].trim().slice(0, max);
    // A missing or blank booth value must not wipe a booth already saved.
    if (OPTIONAL_TEXT.has(field) && value.length === 0) continue;
    update[column] = value;
  }
  if (Array.isArray(source.social_channels)) {
    update.social_channels = source.social_channels
      .filter((c) => typeof c === "string")
      .map((c) => c.trim().slice(0, 40))
      .slice(0, 20);
  }
  if (typeof source.vrm_requested === "boolean") update.vrm_requested = source.vrm_requested;

  const location = validateLocationIds({
    countryCode: source.country_code,
    stateId: source.state_id,
    districtId: source.district_id,
    assemblyConstituencyId: source.assembly_constituency_id,
  });
  if (location.error) return { error: location.error, status: location.status };

  if (typeof source.country_code === "string" && source.country_code.trim()) {
    update.country_code = "IN";
    update.country = "India";
  }
  if (source.state_id != null && source.state_id !== "") update.state_id = Number(source.state_id);
  if (source.district_id != null && source.district_id !== "") {
    update.district_id = Number(source.district_id);
  }
  if (source.assembly_constituency_id != null && source.assembly_constituency_id !== "") {
    update.assembly_constituency_id = Number(source.assembly_constituency_id);
  }
  return { update };
}

function photoExtension(contentType) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/jpeg") return "jpg";
  return null;
}

function publicPhotoUrl(supabaseUrl, path) {
  if (!path) return null;
  const base = String(supabaseUrl || "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;
}

function withPhotoUrl(profile, supabaseUrl) {
  if (!profile) return profile;
  return {
    ...profile,
    profile_photo_url: publicPhotoUrl(supabaseUrl, profile.profile_photo_path),
  };
}

router.get("/", requireUser, async (req, res, next) => {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("profiles")
      .select(COLUMNS)
      .eq("id", req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json({ profile: withPhotoUrl(data, process.env.SUPABASE_URL) });
  } catch (err) {
    next(err);
  }
});

router.put("/", requireUser, async (req, res, next) => {
  try {
    const built = buildProfileUpdate(req.body, req.user);
    if (built.error) return res.status(built.status).json({ error: built.error });

    const { data, error } = await getSupabaseAdmin()
      .from("profiles")
      .upsert(built.update, { onConflict: "id" })
      .select(COLUMNS)
      .single();
    if (error) throw error;
    res.json({ profile: withPhotoUrl(data, process.env.SUPABASE_URL) });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/photo",
  requireUser,
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "2mb" }),
  async (req, res, next) => {
    try {
      const contentType = String(req.headers["content-type"] || "").split(";")[0].trim();
      const ext = photoExtension(contentType);
      const bytes = req.body;
      if (!ext || !Buffer.isBuffer(bytes) || bytes.length === 0) {
        return res.status(400).json({ error: "invalid_photo" });
      }

      const admin = getSupabaseAdmin();
      const path = `${req.user.id}/photo.${ext}`;
      const { error: uploadError } = await admin.storage.from(PHOTO_BUCKET).upload(path, bytes, {
        contentType,
        upsert: true,
      });
      if (uploadError) throw uploadError;

      const { data, error } = await admin
        .from("profiles")
        .upsert({ id: req.user.id, profile_photo_path: path }, { onConflict: "id" })
        .select(COLUMNS)
        .single();
      if (error) throw error;
      res.json({ profile: withPhotoUrl(data, process.env.SUPABASE_URL) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete("/photo", requireUser, async (req, res, next) => {
  try {
    const admin = getSupabaseAdmin();
    const { data: current, error: readError } = await admin
      .from("profiles")
      .select("profile_photo_path")
      .eq("id", req.user.id)
      .maybeSingle();
    if (readError) throw readError;

    if (current && current.profile_photo_path) {
      const { error: removeError } = await admin.storage
        .from(PHOTO_BUCKET)
        .remove([current.profile_photo_path]);
      if (removeError) throw removeError;
    }

    const { data, error } = await admin
      .from("profiles")
      .update({ profile_photo_path: null })
      .eq("id", req.user.id)
      .select(COLUMNS)
      .single();
    if (error) throw error;
    res.json({ profile: withPhotoUrl(data, process.env.SUPABASE_URL) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.buildProfileUpdate = buildProfileUpdate;
module.exports.publicPhotoUrl = publicPhotoUrl;
module.exports.photoExtension = photoExtension;

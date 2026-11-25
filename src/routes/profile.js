const express = require("express");

const { getSupabaseAdmin, getSupabasePublic } = require("../lib/clients");
const { validateLocationIds } = require("../locations");
const { trackActivity } = require("../admin/activity");

const router = express.Router();

const PHOTO_BUCKET = "profile-photos";
const demoProfiles = new Map();

async function demoAccount(phone) {
  const normalized = `+${String(phone || "").replace("+", "")}`;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    return demoProfiles.get(normalized) || null;
  }
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("demo_accounts")
      .select("phone, profile, last_route")
      .eq("phone", normalized)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  } catch (err) {
    console.error(`demo account load failed: ${err.code || err.message}`);
  }
  return demoProfiles.get(normalized) || null;
}

async function saveDemoAccount(phone, profile, lastRoute) {
  const normalized = `+${String(phone || "").replace("+", "")}`;
  demoProfiles.set(normalized, { profile, last_route: lastRoute });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    return;
  }
  try {
    const { error } = await getSupabaseAdmin()
      .from("demo_accounts")
      .upsert(
        { phone: normalized, profile, last_route: lastRoute },
        { onConflict: "phone" }
      );
    if (error) throw error;
  } catch (err) {
    console.error(`demo account save failed: ${err.code || err.message}`);
  }
}

const COLUMNS =
  "id, full_name, phone, selected_domain, language, designation, assembly_constituency, organization, country, " +
  "country_code, state_id, district_id, assembly_constituency_id, " +
  "state_region, constituency, public_contact, contact_email, website_template, social_channels, " +
  "vrm_requested, booth_number, booth_name, profile_photo_path, " +
  "onboarding_current_step, onboarding_completed_steps, onboarding_completed, onboarding_completed_at, " +
  "created_at, updated_at";
const PROFILE_COLUMNS = COLUMNS.replace(
  "created_at, updated_at",
  "additional_profile, created_at, updated_at",
);

// request field -> [column, max length]. Only these can be written by a client.
const TEXT_FIELDS = {
  full_name: ["full_name", 120],
  selected_domain: ["selected_domain", 253],
  language: ["language", 10],
  designation: ["designation", 120],
  assembly_constituency: ["assembly_constituency", 160],
  organization: ["organization", 160],
  contact_email: ["contact_email", 160],
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
    if (process.env.OTP_PROVIDER === "demo" && token.startsWith("demo-")) {
      req.user = {
        id: token.slice("demo-".length),
        phone: `+${token.slice("demo-".length)}`,
      };
      return next();
    }

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
  if (
    source.additional_profile &&
    typeof source.additional_profile === "object" &&
    !Array.isArray(source.additional_profile)
  ) {
    update.additional_profile = source.additional_profile;
  }

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

function reconcileDesignation(update, current) {
  if (!update.assembly_constituency || Object.hasOwn(update, "designation")) return;
  const previous = current && typeof current.designation === "string" ? current.designation.trim() : "";
  if (previous && previous === String(update.assembly_constituency).trim()) {
    update.designation = "";
  }
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
    if (process.env.OTP_PROVIDER === "demo") {
      const account = await demoAccount(req.user.phone);
      return res.json({
        profile: account && account.profile ? account.profile : null,
        last_route: account?.last_route || "/profile",
      });
    }
    const { data, error } = await getSupabaseAdmin()
      .from("profiles")
      .select(PROFILE_COLUMNS)
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
    if (process.env.OTP_PROVIDER === "demo") {
      const built = buildProfileUpdate(req.body, req.user);
      if (built.error) return res.status(built.status).json({ error: built.error });
      const account = await demoAccount(req.user.phone);
      const current = account?.profile || {};
      reconcileDesignation(built.update, current);
      const profile = { ...current, ...built.update, id: req.user.id };
      const lastRoute =
        typeof req.body.last_route === "string" && req.body.last_route.startsWith("/")
          ? req.body.last_route
          : account?.last_route || "/profile";
      await saveDemoAccount(req.user.phone, profile, lastRoute);
      await trackProfileChange(req);
      return res.json({ profile });
    }
    const built = buildProfileUpdate(req.body, req.user);
    if (built.error) return res.status(built.status).json({ error: built.error });
    if (built.update.assembly_constituency && !Object.hasOwn(built.update, "designation")) {
      const existing = await getSupabaseAdmin()
        .from("profiles")
        .select("designation")
        .eq("id", req.user.id)
        .maybeSingle();
      if (!existing.error) reconcileDesignation(built.update, existing.data);
    }

    const { data, error } = await getSupabaseAdmin()
      .from("profiles")
      .upsert(built.update, { onConflict: "id" })
      .select(PROFILE_COLUMNS)
      .single();
    if (error) throw error;
    await trackProfileChange(req);
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

const ONBOARDING_ROUTES = new Set([
  "/profile",
  "/profile/additional",
  "/domain",
  "/website",
  "/website/info",
  "/website/questions",
  "/website/sections",
  "/website/generating",
  "/website/preview",
  "/website/edit",
  "/website/purchase",
  "/website/publish",
  "/social",
  "/blue-tik",
  "/voter-lists",
  "/ready",
  "/dashboard",
]);

const ONBOARDING_COMPLETION_ROUTE = "/dashboard";

function normalizeOnboardingRoute(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return ONBOARDING_ROUTES.has(path) ? path : null;
}

function normalizeCompletedSteps(value) {
  if (!Array.isArray(value)) return [];
  const steps = [];
  const seen = new Set();
  for (const item of value) {
    const route = normalizeOnboardingRoute(item);
    if (!route || seen.has(route) || route === ONBOARDING_COMPLETION_ROUTE) continue;
    seen.add(route);
    steps.push(route);
  }
  return steps;
}

function normalizeProgress(profile) {
  const completedSteps = normalizeCompletedSteps(profile?.onboarding_completed_steps);
  const completed = profile?.onboarding_completed === true;
  const current = normalizeOnboardingRoute(profile?.onboarding_current_step);
  return {
    current_step: current || (completed ? ONBOARDING_COMPLETION_ROUTE : "/profile"),
    completed_steps: completedSteps,
    onboarding_completed: completed,
    onboarding_completed_at: profile?.onboarding_completed_at || null,
  };
}

async function loadProgress(req) {
  if (process.env.OTP_PROVIDER === "demo") {
    const account = await demoAccount(req.user.phone);
    return normalizeProgress(account?.profile || {});
  }
  const { data, error } = await getSupabaseAdmin()
    .from("profiles")
    .select(
      "full_name, onboarding_current_step, onboarding_completed_steps, onboarding_completed, onboarding_completed_at"
    )
    .eq("id", req.user.id)
    .maybeSingle();
  if (error) throw error;
  const progress = normalizeProgress(data || {});
  // Backward compatibility for existing registered users: if they already have a
  // leader profile but no onboarding progress recorded, resume after Leader Profile.
  if (
    !progress.onboarding_completed &&
    progress.current_step === "/profile" &&
    progress.completed_steps.length === 0 &&
    typeof data?.full_name === "string" &&
    data.full_name.trim().length > 0
  ) {
    progress.completed_steps = ["/profile"];
    progress.current_step = "/profile/additional";
  }
  return progress;
}

async function saveProgress(req, body) {
  const existing = await loadProgress(req);
  const completedSteps = new Set(existing.completed_steps);
  for (const step of normalizeCompletedSteps(body.completed_steps)) completedSteps.add(step);
  const completedStep = normalizeOnboardingRoute(body.completed_step);
  if (completedStep && completedStep !== ONBOARDING_COMPLETION_ROUTE) {
    completedSteps.add(completedStep);
  }

  const requestedCurrent = normalizeOnboardingRoute(body.current_step);
  const requestedComplete = body.onboarding_completed === true;
  const onboardingCompleted =
    requestedComplete ||
    existing.onboarding_completed ||
    requestedCurrent === ONBOARDING_COMPLETION_ROUTE;
  const currentStep = onboardingCompleted
    ? ONBOARDING_COMPLETION_ROUTE
    : requestedCurrent || existing.current_step || "/profile";

  const update = {
    onboarding_current_step: currentStep,
    onboarding_completed_steps: Array.from(completedSteps),
    onboarding_completed: onboardingCompleted,
    onboarding_completed_at:
      onboardingCompleted
        ? existing.onboarding_completed_at || new Date().toISOString()
        : null,
  };

  if (process.env.OTP_PROVIDER === "demo") {
    const account = await demoAccount(req.user.phone);
    const profile = { ...(account?.profile || {}), ...update, id: req.user.id };
    await saveDemoAccount(
      req.user.phone,
      profile,
      account?.last_route || currentStep
    );
    return normalizeProgress(profile);
  }

  const { data, error } = await getSupabaseAdmin()
    .from("profiles")
    .upsert({ id: req.user.id, ...update }, { onConflict: "id" })
    .select(
      "onboarding_current_step, onboarding_completed_steps, onboarding_completed, onboarding_completed_at"
    )
    .single();
  if (error) throw error;
  return normalizeProgress(data);
}

router.get("/progress", requireUser, async (req, res, next) => {
  try {
    const progress = await loadProgress(req);
    res.json({ progress });
  } catch (err) {
    next(err);
  }
});

router.put("/progress", requireUser, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const progress = await saveProgress(req, body);
    res.json({ progress });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.buildProfileUpdate = buildProfileUpdate;
module.exports.publicPhotoUrl = publicPhotoUrl;
module.exports.photoExtension = photoExtension;
module.exports.normalizeProgress = normalizeProgress;

async function trackProfileChange(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const meaningful = Object.keys(body).some((key) => key !== "last_route");
  if (!meaningful) return;
  await trackActivity({
    profileId: req.user.id,
    eventType: "profile_update",
    description: "Updated profile",
    resourceType: "profile",
    resourceId: req.user.id,
    status: "recorded",
    dedupeKey: `profile:${req.user.id}:${new Date().toISOString().slice(0, 16)}`,
  });
}

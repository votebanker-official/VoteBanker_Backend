const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");

const { noteLogin, trackActivity } = require("../admin/activity");
const { authenticate } = require("../admin/access");
const { verifyService, getSupabaseAdmin, getSupabasePublic, required } = require("../lib/clients");
const {
  STATE_TTL_MS,
  isProvider,
  appCredentials,
  providerConfigured,
  signState,
  readState,
  safeReturnTo,
  callbackUrl,
  authorizeUrl,
  createTicketStore,
  exchangeFacebookCode,
  exchangeInstagramCode,
  exchangeGoogleCode,
  googlePictureUrl,
  googleProfileFromIdToken,
} = require("../social_auth");

const router = express.Router();

const E164 = /^\+[1-9]\d{7,14}$/;
const CODE = /^\d{4,10}$/;

// Tight limits on OTP endpoints to protect SMS spend and brute force.
// Demo mode skips Twilio, so the limiter only gets in the way of local testing.
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
  skip: () => process.env.OTP_PROVIDER === "demo",
});

function normalizePhone(input) {
  if (typeof input !== "string") return null;
  const phone = input.replace(/[\s-]/g, "");
  return E164.test(phone) ? phone : null;
}

function demoPhoneNumbers() {
  return new Set(
    String(process.env.DEMO_PHONE_NUMBERS || "")
      .split(",")
      .map(normalizePhone)
      .filter(Boolean)
  );
}

function isDemoOtpEnabled() {
  return process.env.OTP_PROVIDER === "demo";
}

function demoOtpConfigured(phone) {
  return Boolean(process.env.DEMO_OTP) &&
    (demoPhoneNumbers().size === 0 || demoPhoneNumbers().has(phone));
}

function demoSessionFor(phone) {
  return {
    access_token: `demo-${phone.replace("+", "")}`,
    refresh_token: `demo-refresh-${phone.replace("+", "")}`,
    expires_at: null,
    user_id: `demo-${phone.replace("+", "")}`,
  };
}

async function ensureDemoAccount(phone) {
  const { getSupabaseAdmin } = require("../lib/clients");
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;
  try {
    const { error } = await getSupabaseAdmin()
      .from("demo_accounts")
      .upsert({ phone }, { onConflict: "phone", ignoreDuplicates: true });
    if (error) throw error;
  } catch (err) {
    // Demo login must still succeed when Supabase is unreachable.
    console.error(`demo account ensure failed: ${err.code || err.message}`);
  }
}

// Local demo Facebook / Google when Meta/Google keys are not configured.
function demoSocialSession(provider) {
  const id = provider === "facebook" ? "900000000001" : "900000000002";
  const label = provider === "facebook" ? "Facebook" : "Google";
  return {
    access_token: `demo-${id}`,
    refresh_token: `demo-refresh-${id}`,
    expires_at: null,
    user_id: `demo-${id}`,
    full_name: `${label} Demo Leader`,
    email: `${provider}.demo@votebanker.local`,
  };
}

// Supabase users are created with a phone-derived email + a password only the
// server can compute. This lets the server mint a normal Supabase session after
// Twilio has verified the phone number.
function credentialsFor(phone) {
  const digits = phone.replace("+", "");
  const password = crypto
    .createHmac("sha256", required("SUPABASE_SECRET_KEY"))
    .update(`votebanker-phone-login:${phone}`)
    .digest("hex");
  return { email: `${digits}@phone.votebanker.app`, password };
}

async function signInOrCreate(phone) {
  const { email, password } = credentialsFor(phone);
  const publicClient = getSupabasePublic();

  let { data, error } = await publicClient.auth.signInWithPassword({ email, password });
  if (!error && data.session) return data;

  const admin = getSupabaseAdmin();
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    phone,
    phone_confirm: true,
  });
  if (created.error && !/already|registered|exists/i.test(created.error.message)) {
    throw created.error;
  }

  ({ data, error } = await publicClient.auth.signInWithPassword({ email, password }));
  if (error) throw error;
  return data;
}

function credentialsForSocial(provider, providerUserId) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(providerUserId)) {
    const error = new Error("invalid_provider_user");
    error.code = "invalid_provider_user";
    throw error;
  }
  const password = crypto
    .createHmac("sha256", required("SUPABASE_SECRET_KEY"))
    .update(`votebanker-social:${provider}:${providerUserId}`)
    .digest("hex");
  return {
    email: `${provider}.${providerUserId}@social.votebanker.app`,
    password,
  };
}

async function signInOrCreateSocial(profile) {
  const { email, password } = credentialsForSocial(profile.provider, profile.providerUserId);
  const publicClient = getSupabasePublic();

  let { data, error } = await publicClient.auth.signInWithPassword({ email, password });
  if (!error && data.session) return data;

  const admin = getSupabaseAdmin();
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      auth_provider: profile.provider,
      provider_user_id: profile.providerUserId,
      name: profile.name || null,
      contact_email: profile.email || null,
      avatar_url: profile.picture || null,
    },
  });
  if (created.error && !/already|registered|exists/i.test(created.error.message)) {
    throw created.error;
  }

  ({ data, error } = await publicClient.auth.signInWithPassword({ email, password }));
  if (error) throw error;
  return data;
}

async function rememberSocialIdentity(user, profile) {
  if (!user || !user.id) return;
  const current =
    user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const metadata = {
    ...current,
    auth_provider: profile.provider,
    provider_user_id: profile.providerUserId,
    name: profile.name || current.name || null,
    contact_email: profile.email || current.contact_email || null,
  };
  if (profile.picture) metadata.avatar_url = profile.picture;
  const { error } = await getSupabaseAdmin().auth.admin.updateUserById(user.id, {
    user_metadata: metadata,
  });
  if (error) throw error;
}

function imageContentType(bytes, header) {
  const declared = String(header || "").split(";")[0].trim().toLowerCase();
  if (declared === "image/png" || declared === "image/jpeg" || declared === "image/webp") {
    return declared;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return "";
}

async function saveGooglePhoto(userId, pictureUrl) {
  const url = googlePictureUrl(pictureUrl);
  if (!userId || !url) return false;
  const admin = getSupabaseAdmin();
  const existing = await admin
    .from("profiles")
    .select("profile_photo_path")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data && String(existing.data.profile_photo_path || "").trim()) return false;
  const response = await fetch(url);
  if (!response.ok) return false;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) return false;
  const contentType = imageContentType(bytes, response.headers.get("content-type"));
  if (!contentType) return false;
  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const path = `${userId}/photo.${ext}`;
  const uploaded = await admin.storage.from("profile-photos").upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (uploaded.error) throw uploaded.error;
  const saved = await admin
    .from("profiles")
    .upsert({ id: userId, profile_photo_path: path }, { onConflict: "id" });
  if (saved.error) throw saved.error;
  return true;
}

async function saveSocialDisplayName(userId, name) {
  const fullName = String(name || "").trim().slice(0, 120);
  if (!userId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;
  const admin = getSupabaseAdmin();
  if (!fullName) {
    const created = await admin.from("profiles").upsert({ id: userId }, { onConflict: "id" });
    if (created.error) throw created.error;
    return;
  }
  const existing = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data && String(existing.data.full_name || "").trim()) return;
  const { error } = await admin
    .from("profiles")
    .upsert({ id: userId, full_name: fullName }, { onConflict: "id" });
  if (error) throw error;
}

const socialTickets = createTicketStore();

function redirectWithError(res, returnTo, code) {
  res.redirect(`${returnTo}?auth_error=${encodeURIComponent(code)}`);
}

// Facebook must land on the leader profile even when the browser returned
// the site root. The query string is added by the caller.
function profileReturnTo(returnTo) {
  const url = new URL(returnTo);
  url.pathname = "/profile";
  url.search = "";
  url.hash = "";
  return `${url.origin}/profile`;
}

router.get("/oauth/:provider/start", (req, res) => {
  const provider = req.params.provider;
  if (!isProvider(provider)) return res.status(404).json({ error: "not_found" });

  const returnTo = safeReturnTo(req.query.return_to);
  if (!returnTo) return res.status(400).json({ error: "invalid_return" });
  if (!providerConfigured(provider)) {
    // Same demo path as WhatsApp OTP: local sign-in without Meta/Google apps.
    if (isDemoOtpEnabled() && (provider === "facebook" || provider === "google")) {
      const session = demoSocialSession(provider);
      void ensureDemoAccount(`+${session.user_id.replace(/^demo-/, "")}`);
      const ticket = socialTickets.issue(session);
      const destination = `${profileReturnTo(returnTo)}?auth_ticket=${encodeURIComponent(ticket)}`;
      console.log(`demo social sign-in provider=${provider} path=/profile`);
      return res.redirect(destination);
    }
    return redirectWithError(res, returnTo, "social_not_configured");
  }

  const creds = appCredentials(provider);
  let redirectUri;
  try {
    redirectUri = callbackUrl(req, process.env, provider);
  } catch (err) {
    console.error(`social callback configuration failed: ${err.code || err.message}`);
    return redirectWithError(res, returnTo, "social_not_configured");
  }
  const useIdToken = provider === "google" && creds.id && creds.secret === creds.id;
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = signState(
    {
      provider,
      returnTo,
      exp: Date.now() + STATE_TTL_MS,
      nonce,
      flow: useIdToken ? "id_token" : "code",
    },
    required("SUPABASE_SECRET_KEY")
  );
  // Facebook Login for Business rejects profile and email on their own.
  // The configuration supplies the required permission, so no scope is sent.
  const configId =
    provider === "facebook" ? String(process.env.META_LOGIN_CONFIG_ID || "").trim() : "";
  res.redirect(
    authorizeUrl(provider, {
      clientId: creds.id,
      redirectUri,
      state,
      responseType: useIdToken ? "id_token" : "code",
      nonce,
      configId,
    })
  );
});

const GOOGLE_ID_TOKEN_PAGE = `<!DOCTYPE html>
<meta charset="utf-8">
<title>Signing in</title>
<p>Signing in with Google…</p>
<script>
var hash = new URLSearchParams((location.hash || "").replace(/^#/, ""));
var idToken = hash.get("id_token") || "";
var state = hash.get("state") || "";
var error = hash.get("error") || "";
function leave(url) { location.replace(url || "/"); }
if (error) {
  leave("/?auth_error=" + encodeURIComponent(error === "access_denied" ? "social_denied" : "social_failed"));
} else if (!idToken || !state) {
  leave("/?auth_error=social_failed");
} else {
  var body = new URLSearchParams();
  body.set("id_token", idToken);
  body.set("state", state);
  fetch("/auth/callback", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  }).then(function (res) {
    return res.json().catch(function () { return {}; });
  }).then(function (data) {
    leave(data && data.redirect);
  }).catch(function () {
    leave("/?auth_error=social_failed");
  });
}
</script>`;

function sendGoogleIdTokenBridge(res) {
  res.set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'");
  res.set("Cache-Control", "no-store");
  res.type("html").send(GOOGLE_ID_TOKEN_PAGE);
}

async function loginFromProviderProfile(profile) {
  const { session, user } = await signInOrCreateSocial(profile);
  try {
    await rememberSocialIdentity(user, profile);
  } catch (err) {
    console.error(`social identity save failed: ${err.message || err}`);
  }
  try {
    await saveSocialDisplayName(user.id, profile.name);
  } catch (err) {
    console.error(`profile name save failed: ${err.message || err}`);
  }
  await noteLogin({ id: user.id, phone: "" });
  if (profile.provider === "google" && profile.picture) {
    try {
      await saveGooglePhoto(user.id, profile.picture);
    } catch (err) {
      console.error(`profile photo save failed: ${err.message || err}`);
    }
  }
  return socialTickets.issue({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user_id: user.id,
    full_name: profile.name || "",
    email: profile.email || "",
    avatar_url: profile.picture || "",
  });
}

async function finishGoogleIdToken(req, res) {
  const secret = process.env.SUPABASE_SECRET_KEY || "";
  const state = readState(req.body && req.body.state, secret);
  const returnTo = state && state.returnTo;
  if (!returnTo || state.provider !== "google" || state.flow !== "id_token") {
    return res.status(400).json({ error: "social_expired" });
  }
  try {
    const creds = appCredentials("google");
    const profile = await googleProfileFromIdToken({
      idToken: req.body.id_token,
      clientId: creds.id,
      nonce: state.nonce,
    });
    const ticket = await loginFromProviderProfile(profile);
    res.json({ redirect: `${returnTo}?auth_ticket=${encodeURIComponent(ticket)}` });
  } catch (err) {
    console.error(`google id token sign-in failed: ${err.code || err.message}`);
    res.status(401).json({
      error: "social_failed",
      redirect: `${returnTo}?auth_error=social_failed`,
    });
  }
}

async function oauthCallback(req, res, next) {
  if (req.method === "POST" && req.body && typeof req.body.id_token === "string") {
    return finishGoogleIdToken(req, res);
  }
  if (
    req.method === "GET" &&
    !req.query.code &&
    !req.query.state &&
    !req.query.error
  ) {
    return sendGoogleIdTokenBridge(res);
  }
  const secret = process.env.SUPABASE_SECRET_KEY || "";
  const state = readState(req.query.state, secret);
  const returnTo = state && state.returnTo;
  if (!returnTo) {
    return res.status(400).json({ error: "social_expired" });
  }
  try {
    if (state.purpose === "connect") {
      const { finishConnect, saveConnection } = require("../routes/social_connections");
      if (req.query.error) {
        const status = req.query.error === "access_denied" ? "cancelled" : "failed";
        return res.redirect(
          `${returnTo}?social_status=${status}&provider=${encodeURIComponent(state.provider)}`
        );
      }
      try {
        const account = await finishConnect({
          state,
          code: req.query.code,
          redirectUri: callbackUrl(req, process.env, state.provider),
          save: saveConnection,
        });
        const name = encodeURIComponent(account.accountName || account.accountUsername || "");
        return res.redirect(
          `${returnTo}?social_status=connected&provider=${encodeURIComponent(state.provider)}&account=${name}`
        );
      } catch (err) {
        const status = encodeURIComponent(err.code || "failed");
        console.error(`social connect failed: ${err.code || err.message}`);
        return res.redirect(
          `${returnTo}?social_status=${status}&provider=${encodeURIComponent(state.provider)}`
        );
      }
    }
    if (req.query.error) {
      const code = req.query.error === "access_denied" ? "social_denied" : "social_failed";
      return redirectWithError(res, returnTo, code);
    }
    const creds = appCredentials(state.provider);
    const exchange =
      state.provider === "facebook"
        ? exchangeFacebookCode
        : state.provider === "google"
          ? exchangeGoogleCode
          : exchangeInstagramCode;
    const profile = await exchange({
      code: req.query.code,
      redirectUri: callbackUrl(req, process.env, state.provider),
      clientId: creds.id,
      clientSecret: creds.secret,
    });
    const ticket = await loginFromProviderProfile(profile);
    const landing = profile.provider === "facebook" ? profileReturnTo(returnTo) : returnTo;
    console.log(
      `social sign-in redirect provider=${profile.provider} path=${new URL(landing).pathname}`
    );
    res.redirect(`${landing}?auth_ticket=${encodeURIComponent(ticket)}`);
  } catch (err) {
    console.error(`social sign-in failed: ${err.code || err.message}`);
    if (returnTo) return redirectWithError(res, returnTo, "social_failed");
    next(err);
  }
}

router.get("/oauth/callback", oauthCallback);
router.get("/callback", oauthCallback);

router.post("/oauth/exchange", otpLimiter, (req, res) => {
  const ticket = req.body && req.body.ticket;
  if (typeof ticket !== "string" || !/^[a-f0-9]{64}$/.test(ticket)) {
    return res.status(401).json({ error: "social_expired" });
  }
  const session = socialTickets.take(ticket);
  if (!session) return res.status(401).json({ error: "social_expired" });
  res.json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user: {
      id: session.user_id,
      phone: "",
      full_name: session.full_name || "",
      email: session.email || "",
      avatar_url: session.avatar_url || "",
    },
  });
});

router.post("/otp/send", otpLimiter, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: "invalid_phone" });

    const channel = req.body && req.body.channel;
    if (channel !== "whatsapp") {
      return res.status(400).json({ error: "whatsapp_only" });
    }

    if (isDemoOtpEnabled()) {
      if (!demoOtpConfigured(phone)) {
        return res.status(403).json({ error: "demo_number_not_allowed" });
      }
      return res.json({ status: "sent", channel, provider: "demo" });
    }

    if (process.env.WHATSAPP_OTP_ENABLED !== "true") {
      return res.status(400).json({ error: "channel_unavailable" });
    }

    await verifyService().verifications.create({ to: phone, channel });
    res.json({ status: "sent", channel });
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: "too_many_requests" });
    // Twilio trial accounts can only text numbers verified in the Twilio console.
    if (err.code === 21608 || /verified tester|unverified/i.test(err.message || "")) {
      return res.status(403).json({ error: "number_not_verified" });
    }
    // WhatsApp must be enabled on the Twilio Verify service.
    if (req.body && req.body.channel === "whatsapp" && (err.status === 400 || err.status === 404)) {
      console.error(`WhatsApp channel unavailable: ${err.code} ${err.message}`);
      return res.status(400).json({ error: "channel_unavailable" });
    }
    if (err.status === 400) return res.status(400).json({ error: "invalid_phone" });
    next(err);
  }
});

router.post("/otp/verify", otpLimiter, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    const code = req.body && req.body.code;
    if (!phone) return res.status(400).json({ error: "invalid_phone" });
    if (typeof code !== "string" || !CODE.test(code)) {
      return res.status(400).json({ error: "invalid_code" });
    }

    if (isDemoOtpEnabled()) {
      if (!demoOtpConfigured(phone)) {
        return res.status(403).json({ error: "demo_number_not_allowed" });
      }
      if (code !== process.env.DEMO_OTP) {
        return res.status(401).json({ error: "incorrect_code" });
      }
      await ensureDemoAccount(phone);
      const demoSession = demoSessionFor(phone);
      return res.json({
        ...demoSession,
        user: { id: demoSession.user_id, phone },
      });
    } else {
      const check = await verifyService().verificationChecks.create({ to: phone, code });
      if (check.status !== "approved") {
        return res.status(401).json({ error: "incorrect_code" });
      }
    }

    const { session, user } = await signInOrCreate(phone);
    await noteLogin({ id: user.id, phone });
    res.json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      user: { id: user.id, phone },
    });
  } catch (err) {
    // Twilio returns 404 when the code expired or no verification is pending.
    if (err.status === 404) return res.status(401).json({ error: "code_expired" });
    if (err.status === 429) return res.status(429).json({ error: "too_many_requests" });
    next(err);
  }
});

module.exports = router;
module.exports.oauthCallback = oauthCallback;

router.post("/session/end", async (req, res) => {
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  await trackActivity({
    profileId: user.id,
    eventType: "logout",
    description: "Signed out",
    status: "recorded",
    dedupeKey: `logout:${user.id}:${new Date().toISOString().slice(0, 16)}`,
  });
  res.json({ ok: true });
});

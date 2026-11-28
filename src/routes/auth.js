const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");

const { noteLogin, trackActivity } = require("../admin/activity");
const { authenticate } = require("../admin/access");
const { createSupabaseRepository } = require("../admin/repository");
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
const accountAccess = createSupabaseRepository();

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
  skip: (req) =>
    process.env.OTP_PROVIDER === "demo" &&
    !(req.body && req.body.purpose === "password_reset"),
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

const DEFAULT_COUNTRY_CODE = "+91";

function normalizePhone(input) {
  if (typeof input !== "string") return null;
  const cleaned = input.trim().replace(/[\s\-()]/g, "");
  if (!cleaned) return null;

  let candidate = cleaned;
  if (cleaned.startsWith("+")) {
    candidate = cleaned;
  } else if (/^\d{10}$/.test(cleaned)) {
    candidate = `${DEFAULT_COUNTRY_CODE}${cleaned}`;
  } else if (/^0\d{10}$/.test(cleaned)) {
    candidate = `${DEFAULT_COUNTRY_CODE}${cleaned.slice(1)}`;
  } else if (/^91\d{10}$/.test(cleaned)) {
    candidate = `+${cleaned}`;
  } else {
    return null;
  }

  return E164.test(candidate) ? candidate : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;
const SCRYPT_KEYLEN = 64;

function normalizeEmail(input) {
  if (typeof input !== "string") return null;
  const email = input.trim().toLowerCase();
  if (!email || email.length > 160 || !EMAIL_RE.test(email)) return null;
  return email;
}

function normalizeIdentifier(input) {
  if (typeof input !== "string") return { type: null, value: null };
  const raw = input.trim();
  if (!raw) return { type: null, value: null };
  if (raw.includes("@")) return { type: "email", value: normalizeEmail(raw) };
  return { type: "mobile", value: normalizePhone(raw) };
}

function validatePassword(password) {
  if (typeof password !== "string") return "invalid_password";
  if (password.length < PASSWORD_MIN) return "password_too_short";
  if (password.length > 128) return "invalid_password";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "password_weak";
  return null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string") return false;
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function unexpiredJwtPayload(token, now = Date.now()) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload || typeof payload.exp !== "number" || payload.exp * 1000 <= now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function hashPasswordResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hasTwilioVerifyConfiguration() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_VERIFY_SERVICE_SID,
  );
}

function createPasswordResetOtpHandlers({
  getAdmin = getSupabaseAdmin,
  getVerifyService = verifyService,
  isSmsConfigured = hasTwilioVerifyConfiguration,
  now = () => Date.now(),
  createToken = () => crypto.randomBytes(32).toString("hex"),
  hashToken = hashPasswordResetToken,
} = {}) {
  async function findAccount(phone) {
    const { data, error } = await getAdmin()
      .from("users")
      .select("id")
      .eq("mobile", phone)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function send(req, res, next) {
    try {
      const phone = normalizePhone(req.body && req.body.phone);
      if (!phone) return res.status(400).json({ error: "invalid_phone" });
      if (!isSmsConfigured()) {
        return res.status(503).json({ error: "password_reset_sms_unavailable" });
      }

      const account = await findAccount(phone);
      if (!account) return res.json({ status: "sent", channel: "sms" });

      await getVerifyService().verifications.create({ to: phone, channel: "sms" });
      res.json({ status: "sent", channel: "sms" });
    } catch (err) {
      if (err.status === 429) {
        return res.status(429).json({ error: "too_many_requests" });
      }
      if (err.code === 21608 || /verified tester|unverified/i.test(err.message || "")) {
        return res.status(403).json({ error: "number_not_verified" });
      }
      if (err.status === 400 || err.status === 404) {
        console.error("password reset SMS unavailable", {
          code: err.code || err.status,
        });
        return res.status(503).json({ error: "password_reset_sms_unavailable" });
      }
      next(err);
    }
  }

  async function verify(req, res, next) {
    try {
      const phone = normalizePhone(req.body && req.body.phone);
      const code = req.body && req.body.code;
      if (!phone) return res.status(400).json({ error: "invalid_phone" });
      if (typeof code !== "string" || !CODE.test(code)) {
        return res.status(400).json({ error: "invalid_code" });
      }
      if (!isSmsConfigured()) {
        return res.status(503).json({ error: "password_reset_sms_unavailable" });
      }

      const account = await findAccount(phone);
      if (!account) return res.status(401).json({ error: "incorrect_code" });

      const check = await getVerifyService().verificationChecks.create({
        to: phone,
        code,
      });
      if (check.status !== "approved") {
        return res.status(401).json({ error: "incorrect_code" });
      }

      const token = createToken();
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) {
        throw new Error("invalid_password_reset_token");
      }
      const { error } = await getAdmin()
        .from("users")
        .update({
          password_reset_token_hash: hashToken(token),
          password_reset_expires_at: new Date(now() + 10 * 60 * 1000).toISOString(),
        })
        .eq("id", account.id);
      if (error) throw error;

      res.json({ status: "verified", reset_token: token });
    } catch (err) {
      if (err.status === 404) {
        return res.status(401).json({ error: "code_expired" });
      }
      if (err.status === 429) {
        return res.status(429).json({ error: "too_many_requests" });
      }
      if (err.status === 400) {
        return res.status(401).json({ error: "incorrect_code" });
      }
      next(err);
    }
  }

  return { send, verify };
}

function passwordResetRedirectUrl(req) {
  const requestOrigin = req && typeof req.get === "function" ? req.get("origin") : "";
  const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(
    String(requestOrigin || ""),
  );
  const candidates = localOrigin
    ? [requestOrigin, process.env.FRONTEND_URL]
    : [process.env.FRONTEND_URL, requestOrigin];
  candidates.push("https://votebanker-frontend.vercel.app");

  for (const candidate of candidates) {
    const safeOrigin = safeReturnTo(candidate);
    if (safeOrigin) {
      return `${safeOrigin.replace(/\/$/, "")}/forgot-password/new`;
    }
  }

  const error = new Error("password_reset_redirect_unavailable");
  error.code = "password_reset_redirect_unavailable";
  throw error;
}

function createPasswordResetRouter({
  getAdmin = getSupabaseAdmin,
  getPublic = getSupabasePublic,
  getRedirectUrl = passwordResetRedirectUrl,
  now = () => Date.now(),
  passwordHasher = hashPassword,
} = {}) {
  const resetRouter = express.Router();

  resetRouter.post("/request", async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body && req.body.email);
      if (!email) return res.status(400).json({ error: "invalid_email" });

      const admin = getAdmin();
      const { data: account, error: lookupError } = await admin
        .from("users")
        .select("id")
        .ilike("email", email)
        .maybeSingle();
      if (lookupError) throw lookupError;

      if (account) {
        const { error } = await getPublic().auth.resetPasswordForEmail(email, {
          redirectTo: getRedirectUrl(req),
        });
        if (error) {
          if (error.status === 429) {
            return res.status(429).json({ error: "too_many_requests" });
          }
          console.error("password reset email failed", {
            code: error.code || error.status || "email_service_error",
          });
          return res.status(503).json({ error: "password_reset_unavailable" });
        }
      }

      res.json({ status: "requested" });
    } catch (err) {
      next(err);
    }
  });

  resetRouter.post("/complete", async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const password = typeof body.password === "string" ? body.password : "";
      const confirmPassword =
        typeof body.confirm_password === "string" ? body.confirm_password : "";
      const passwordError = validatePassword(password);

      if (passwordError) return res.status(400).json({ error: passwordError });
      if (password !== confirmPassword) {
        return res.status(400).json({ error: "password_mismatch" });
      }

      if (typeof body.reset_token === "string") {
        if (!/^[a-f0-9]{64}$/i.test(body.reset_token)) {
          return res.status(401).json({ error: "invalid_reset_link" });
        }
        const admin = getAdmin();
        const { data: account, error } = await admin
          .from("users")
          .update({
            hashed_password: passwordHasher(password),
            password_reset_token_hash: null,
            password_reset_expires_at: null,
          })
          .eq("password_reset_token_hash", hashPasswordResetToken(body.reset_token))
          .gt("password_reset_expires_at", new Date(now()).toISOString())
          .select("id")
          .maybeSingle();
        if (error) throw error;
        if (!account) return res.status(401).json({ error: "invalid_reset_link" });

        const { error: authUpdateError } =
          await admin.auth.admin.updateUserById(account.id, { password });
        if (authUpdateError) {
          console.error("phone password reset auth update failed", {
            userId: account.id,
            code: authUpdateError.code || authUpdateError.status || "auth_update_error",
          });
          return res.json({ status: "reset", auth_sync_pending: true });
        }
        return res.json({ status: "reset" });
      }

      const accessToken = body.access_token;
      const refreshToken = body.refresh_token;
      if (
        typeof accessToken !== "string" ||
        accessToken.length > 8192 ||
        typeof refreshToken !== "string" ||
        refreshToken.length > 8192
      ) {
        return res.status(401).json({ error: "invalid_reset_link" });
      }
      if (!unexpiredJwtPayload(accessToken, now())) {
        return res.status(401).json({ error: "reset_link_expired" });
      }

      const publicClient = getPublic();
      const { data: sessionData, error: sessionError } =
        await publicClient.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
      if (sessionError || !sessionData || !sessionData.user) {
        return res.status(401).json({ error: "invalid_reset_link" });
      }

      const admin = getAdmin();
      const { data: account, error: accountError } = await admin
        .from("users")
        .select("id, hashed_password")
        .eq("id", sessionData.user.id)
        .maybeSingle();
      if (accountError) throw accountError;
      if (!account) return res.status(401).json({ error: "invalid_reset_link" });

      const { error: hashError } = await admin
        .from("users")
        .update({ hashed_password: passwordHasher(password) })
        .eq("id", account.id);
      if (hashError) throw hashError;

      const { error: passwordErrorFromAuth } =
        await publicClient.auth.updateUser({ password });
      if (passwordErrorFromAuth) {
        const { error: rollbackError } = await admin
          .from("users")
          .update({ hashed_password: account.hashed_password })
          .eq("id", account.id);
        if (rollbackError) {
          console.error("password reset hash rollback failed", {
            userId: account.id,
            code: rollbackError.code || "database_error",
          });
          return res.status(503).json({ error: "password_reset_unavailable" });
        }
        if (passwordErrorFromAuth.status === 401) {
          return res.status(401).json({ error: "invalid_reset_link" });
        }
        console.error("password reset auth update failed", {
          code:
            passwordErrorFromAuth.code ||
            passwordErrorFromAuth.status ||
            "auth_update_error",
        });
        return res.status(503).json({ error: "password_reset_unavailable" });
      }

      const { error: signOutError } = await publicClient.auth.signOut({
        scope: "global",
      });
      if (signOutError) {
        console.error("password reset session revocation failed", {
          userId: account.id,
          code: signOutError.code || signOutError.status || "sign_out_error",
        });
        return res
          .status(503)
          .json({ error: "password_reset_session_revoke_failed" });
      }

      res.json({ status: "reset" });
    } catch (err) {
      next(err);
    }
  });

  return resetRouter;
}

async function findPublicUserByEmail(email) {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("users")
    .select("id, email, mobile, hashed_password, created_at")
    .ilike("email", email)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findPublicUserByMobile(mobile) {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("users")
    .select("id, email, mobile, hashed_password, created_at")
    .eq("mobile", mobile)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findPublicUserByIdentifier(identifier) {
  const { type, value } = normalizeIdentifier(identifier);
  if (!type || !value) return { type, value, user: null };
  const user = type === "email"
    ? await findPublicUserByEmail(value)
    : await findPublicUserByMobile(value);
  return { type, value, user };
}

function publicUserResponse(user) {
  return {
    id: user.id,
    email: user.email,
    mobile: user.mobile,
    created_at: user.created_at,
  };
}

function sessionResponse(session, user, account) {
  const meta = user && user.user_metadata && typeof user.user_metadata === "object"
    ? user.user_metadata
    : {};
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user: {
      id: user.id,
      phone: account?.mobile || user.phone || meta.mobile || "",
      email: account?.email || meta.contact_email || user.email || "",
      full_name: meta.name || meta.full_name || "",
      avatar_url: meta.avatar_url || "",
    },
  };
}

async function ensureProfileForAccount(userId, { fullName, phone, email }) {
  const admin = getSupabaseAdmin();
  const payload = { id: userId };
  if (typeof fullName === "string" && fullName.trim()) {
    payload.full_name = fullName.trim().slice(0, 120);
  }
  if (typeof phone === "string" && phone.trim()) {
    payload.phone = phone.trim();
  }
  if (typeof email === "string" && email.trim()) {
    payload.contact_email = email.trim().toLowerCase();
  }
  const { error } = await admin.from("profiles").upsert(payload, { onConflict: "id" });
  if (error) throw error;
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
  const storedMeta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const contactEmail = String(profile.email || storedMeta.contact_email || "").trim();
  await noteLogin({
    id: user.id,
    phone: "",
    email: contactEmail,
  });
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
    email: contactEmail,
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

router.get("/me", async (req, res) => {
  try {
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const access = await accountAccess.accessFor(user);
    res.json({
      id: user.id,
      role: access.admin ? "admin" : "client",
    });
  } catch (err) {
    if (err && err.code === "admin_not_ready") {
      return res.status(503).json({ error: "admin_not_ready" });
    }
    console.error(`session role lookup failed: ${err.message || err}`);
    res.status(500).json({ error: "server_error" });
  }
});

router.post("/session/refresh", async (req, res) => {
  const refreshToken = req.body && req.body.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken.trim().length < 20) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { data, error } = await getSupabasePublic().auth.refreshSession({
    refresh_token: refreshToken.trim(),
  });
  if (error || !data.session || !data.user) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const meta = data.user.user_metadata && typeof data.user.user_metadata === "object" ? data.user.user_metadata : {};
  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: {
      id: data.user.id,
      phone: data.user.phone || "",
      full_name: meta.name || "",
      email: meta.contact_email || "",
      avatar_url: meta.avatar_url || "",
    },
  });
});

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
  if (req.body && req.body.purpose === "password_reset") {
    return createPasswordResetOtpHandlers().send(req, res, next);
  }
  if (req.body && req.body.purpose) {
    return res.status(400).json({ error: "invalid_otp_purpose" });
  }
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
  if (req.body && req.body.purpose === "password_reset") {
    return createPasswordResetOtpHandlers().verify(req, res, next);
  }
  if (req.body && req.body.purpose) {
    return res.status(400).json({ error: "invalid_otp_purpose" });
  }
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

router.post("/register", otpLimiter, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = normalizeEmail(body.email);
    const mobile = normalizePhone(body.mobile);
    const password = typeof body.password === "string" ? body.password : "";
    const confirmPassword = typeof body.confirm_password === "string" ? body.confirm_password : "";
    const termsAccepted = body.terms_accepted === true;

    if (!email) return res.status(400).json({ error: "invalid_email" });
    if (!mobile) return res.status(400).json({ error: "invalid_phone" });
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    if (password !== confirmPassword) {
      return res.status(400).json({ error: "password_mismatch" });
    }
    if (!termsAccepted) {
      return res.status(400).json({ error: "terms_required" });
    }

    const [existingEmail, existingMobile] = await Promise.all([
      findPublicUserByEmail(email),
      findPublicUserByMobile(mobile),
    ]);
    if (existingEmail) return res.status(409).json({ error: "email_already_registered" });
    if (existingMobile) return res.status(409).json({ error: "mobile_already_registered" });

    // Guard against legacy accounts that exist outside public.users.
    const adminClient = getSupabaseAdmin();
    const [profileByPhone, profileByEmail] = await Promise.all([
      adminClient.from("profiles").select("id").eq("phone", mobile).maybeSingle(),
      adminClient.from("profiles").select("id").ilike("contact_email", email).maybeSingle(),
    ]);
    if (profileByEmail.error) throw profileByEmail.error;
    if (profileByPhone.error) throw profileByPhone.error;
    if (profileByEmail.data) return res.status(409).json({ error: "email_already_registered" });
    if (profileByPhone.data) return res.status(409).json({ error: "mobile_already_registered" });

    const admin = getSupabaseAdmin();
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      phone: mobile,
      phone_confirm: true,
      user_metadata: {
        mobile,
        contact_email: email,
        auth_provider: "password",
      },
    });

    if (created.error) {
      const msg = String(created.error.message || "").toLowerCase();
      if (/already|registered|exists/.test(msg)) {
        if (msg.includes("phone")) return res.status(409).json({ error: "mobile_already_registered" });
        return res.status(409).json({ error: "email_already_registered" });
      }
      throw created.error;
    }

    const user = created.data && created.data.user;
    if (!user) throw new Error("user_create_failed");

    const hashedPassword = hashPassword(password);
    const { data: account, error: insertError } = await admin
      .from("users")
      .insert({
        id: user.id,
        email,
        mobile,
        hashed_password: hashedPassword,
      })
      .select("id, email, mobile, created_at")
      .single();

    if (insertError) {
      // Avoid leaving an orphan auth user if the app table insert fails.
      await admin.auth.admin.deleteUser(user.id).catch(() => {});
      if (insertError.code === "23505") {
        const detail = String(insertError.details || insertError.message || "").toLowerCase();
        if (detail.includes("mobile")) return res.status(409).json({ error: "mobile_already_registered" });
        return res.status(409).json({ error: "email_already_registered" });
      }
      throw insertError;
    }

    await ensureProfileForAccount(user.id, { phone: mobile, email });

    const publicClient = getSupabasePublic();
    const { data: signInData, error: signInError } = await publicClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || !signInData.session || !signInData.user) {
      throw signInError || new Error("session_create_failed");
    }

    await noteLogin({ id: signInData.user.id, phone: mobile, email });
    await trackActivity({
      profileId: signInData.user.id,
      eventType: "register",
      description: "Created account with email and password",
      status: "recorded",
      dedupeKey: `register:${signInData.user.id}`,
    });

    res.status(201).json({
      ...sessionResponse(signInData.session, signInData.user, account),
      account: publicUserResponse(account),
    });
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: "too_many_requests" });
    const msg = String(err.message || "");
    if (err.code === "42P01" || msg.includes("Could not find the table 'public.users'")) {
      console.error("register failed: users table missing", msg);
      return res.status(503).json({ error: "registration_unavailable" });
    }
    next(err);
  }
});

router.post("/login", otpLimiter, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const identifier = typeof body.identifier === "string" ? body.identifier : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) return res.status(400).json({ error: "invalid_credentials" });

    const { type, value, user: account } = await findPublicUserByIdentifier(identifier);
    if (!type || !value || !account) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    if (!verifyPassword(password, account.hashed_password)) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const publicClient = getSupabasePublic();
    let { data, error } = await publicClient.auth.signInWithPassword({
      email: account.email,
      password,
    });

    // Backward-compatible repair: if the app users table has the account but
    // the Supabase Auth password is out of sync, reset it after hash verification.
    if (error) {
      const admin = getSupabaseAdmin();
      const repaired = await admin.auth.admin.updateUserById(account.id, {
        password,
        email_confirm: true,
        phone: account.mobile,
        phone_confirm: true,
        user_metadata: { mobile: account.mobile, contact_email: account.email, auth_provider: "password" },
      });
      if (!repaired.error) {
        ({ data, error } = await publicClient.auth.signInWithPassword({
          email: account.email,
          password,
        }));
      }
    }

    if (error || !data.session || !data.user) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    await ensureProfileForAccount(data.user.id, {
      phone: account.mobile,
      email: account.email,
    });
    await noteLogin({ id: data.user.id, phone: account.mobile, email: account.email });

    res.json(sessionResponse(data.session, data.user, account));
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: "too_many_requests" });
    const msg = String(err.message || "");
    if (err.code === "42P01" || msg.includes("Could not find the table 'public.users'")) {
      console.error("login failed: users table missing", msg);
      return res.status(503).json({ error: "registration_unavailable" });
    }
    next(err);
  }
});

router.use("/password-reset", passwordResetLimiter, createPasswordResetRouter());

module.exports = router;
module.exports.oauthCallback = oauthCallback;
module.exports.createPasswordResetRouter = createPasswordResetRouter;
module.exports.createPasswordResetOtpHandlers = createPasswordResetOtpHandlers;

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

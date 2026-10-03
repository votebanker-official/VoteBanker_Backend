const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");

const { verifyService, getSupabaseAdmin, getSupabasePublic, required } = require("../lib/clients");

const router = express.Router();

const E164 = /^\+[1-9]\d{7,14}$/;
const CODE = /^\d{4,10}$/;

// Tight limits on OTP endpoints to protect SMS spend and brute force.
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

function normalizePhone(input) {
  if (typeof input !== "string") return null;
  const phone = input.replace(/[\s-]/g, "");
  return E164.test(phone) ? phone : null;
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

router.post("/otp/send", otpLimiter, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: "invalid_phone" });

    const requested = req.body && req.body.channel;
    const channel = requested === "whatsapp" ? "whatsapp" : "sms";

    // Without a WhatsApp sender on the Twilio Verify service, Twilio silently
    // falls back to SMS. Keep WhatsApp off until it is set up, then set
    // WHATSAPP_OTP_ENABLED=true.
    if (channel === "whatsapp" && process.env.WHATSAPP_OTP_ENABLED !== "true") {
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
    // WhatsApp must be enabled on the Twilio Verify service; fall back guidance for the app.
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

    const check = await verifyService().verificationChecks.create({ to: phone, code });
    if (check.status !== "approved") {
      return res.status(401).json({ error: "incorrect_code" });
    }

    const { session, user } = await signInOrCreate(phone);
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

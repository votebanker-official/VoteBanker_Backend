const { getSupabasePublic } = require("../lib/clients");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(String(value || ""));
}

function normalizePhone(input) {
  if (typeof input !== "string") return "";
  const phone = input.replace(/[\s-]/g, "");
  if (!phone) return "";
  return phone.startsWith("+") ? phone : `+${phone}`;
}

function adminPhones() {
  return new Set(
    String(process.env.ADMIN_PHONES || "")
      .split(",")
      .map(normalizePhone)
      .filter(Boolean),
  );
}

function normalizeEmail(input) {
  return String(input || "").trim().toLowerCase();
}

function isLoginAlias(email) {
  return email.endsWith("@social.votebanker.app") || email.endsWith("@phone.votebanker.app");
}

// Facebook sign-in has no phone. This mailbox is the admin account.
function adminEmails() {
  const configured = String(process.env.ADMIN_EMAILS || "votebanker.com@gmail.com");
  return new Set(
    configured
      .split(",")
      .map(normalizeEmail)
      .filter((email) => email.includes("@") && !isLoginAlias(email)),
  );
}

function phoneFromUser(user) {
  if (!user) return "";
  return normalizePhone(user.phone || "");
}

function emailFromUser(user) {
  if (!user) return "";
  const meta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const email = normalizeEmail(meta.contact_email || user.email || "");
  if (!email || isLoginAlias(email)) return "";
  return email;
}

function isListedAdmin(user) {
  const phone = phoneFromUser(user);
  const email = emailFromUser(user);
  return Boolean((phone && adminPhones().has(phone)) || (email && adminEmails().has(email)));
}

/**
 * Resolves the signed-in user from the bearer token.
 * Demo tokens are accepted only while OTP_PROVIDER=demo, matching profile routes.
 */
async function authenticate(req) {
  try {
    const header = (req && req.headers && req.headers.authorization) || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return null;

    if (process.env.OTP_PROVIDER === "demo" && token.startsWith("demo-")) {
      const raw = token.slice("demo-".length);
      return { id: raw, phone: normalizePhone(raw) };
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) return null;
    const { data, error } = await getSupabasePublic().auth.getUser(token);
    if (error || !data.user) return null;
    const user = data.user;
    return {
      id: user.id,
      phone: normalizePhone(user.phone || ""),
      email: emailFromUser(user),
      user_metadata: user.user_metadata || {},
    };
  } catch (err) {
    console.error(`auth lookup failed: ${err.message || err}`);
    return null;
  }
}

module.exports = {
  UUID_RE,
  isUuid,
  normalizePhone,
  normalizeEmail,
  adminPhones,
  adminEmails,
  phoneFromUser,
  emailFromUser,
  isListedAdmin,
  authenticate,
};

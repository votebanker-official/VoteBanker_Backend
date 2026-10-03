const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

let twilioClient;
function getTwilio() {
  if (!twilioClient) {
    twilioClient = twilio(required("TWILIO_ACCOUNT_SID"), required("TWILIO_AUTH_TOKEN"));
  }
  return twilioClient;
}

function verifyService() {
  return getTwilio().verify.v2.services(required("TWILIO_VERIFY_SERVICE_SID"));
}

const authOptions = { auth: { persistSession: false, autoRefreshToken: false } };

// Admin client: bypasses RLS. Server-side only, never expose this key.
let adminClient;
function getSupabaseAdmin() {
  if (!adminClient) {
    adminClient = createClient(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), authOptions);
  }
  return adminClient;
}

// Public client: used to sign users in and to validate their tokens.
function getSupabasePublic() {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_PUBLISHABLE_KEY"), authOptions);
}

module.exports = { verifyService, getSupabaseAdmin, getSupabasePublic, required };

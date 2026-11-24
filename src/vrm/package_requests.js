const { getSupabaseAdmin } = require("../lib/clients");

const PACKAGES = Object.freeze({
  voters_100: Object.freeze({ voterCount: 100, amountInr: 100 }),
  voters_1000: Object.freeze({ voterCount: 1000, amountInr: 999 }),
  voters_10000: Object.freeze({ voterCount: 10000, amountInr: 9999 }),
});

function packageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function value(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function createVoterPackageRequest(user, packageCode) {
  if (!user || !user.id) throw packageError("unauthorized");
  const selection = Object.hasOwn(PACKAGES, packageCode) ? PACKAGES[packageCode] : null;
  if (!selection) throw packageError("invalid_package");

  const supabase = getSupabaseAdmin();
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("full_name, phone")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    const error = packageError("vrm_package_profile_lookup_failed");
    error.cause = profileError;
    throw error;
  }

  const metadata =
    user.user_metadata && typeof user.user_metadata === "object"
      ? user.user_metadata
      : {};
  const name = value(profile && profile.full_name) ||
    value(metadata.full_name) ||
    value(metadata.name);
  const phone = value(profile && profile.phone) ||
    value(user.phone) ||
    value(metadata.phone);
  const digits = phone.replace(/\D/g, "");
  if (!name || name.length > 160 || digits.length < 7 || digits.length > 15 || phone.length > 40) {
    throw packageError("profile_details_required");
  }

  const { data: request, error: insertError } = await supabase
    .from("vrm_package_requests")
    .insert({
      user_id: user.id,
      user_name: name,
      user_phone: phone,
      package_code: packageCode,
      voter_count: selection.voterCount,
      amount_inr: selection.amountInr,
      status: "requested",
    })
    .select("id, package_code, voter_count, amount_inr, status, created_at")
    .single();

  if (insertError) {
    const error = packageError("vrm_package_request_failed");
    error.cause = insertError;
    throw error;
  }

  return {
    id: request.id,
    packageCode: request.package_code,
    voterCount: request.voter_count,
    amountInr: request.amount_inr,
    status: request.status,
    createdAt: request.created_at,
  };
}

module.exports = { PACKAGES, createVoterPackageRequest };

require("dotenv").config();

const { getSupabaseAdmin } = require("../src/lib/clients");

async function main() {
  const phone = String(process.argv[2] || "").replace(/[\s-]/g, "");
  const normalized = phone.startsWith("+") ? phone : phone ? `+${phone}` : "";
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    console.error("Usage: node scripts/promote-admin.js +91XXXXXXXXXX");
    process.exit(1);
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("profiles")
    .select("id, full_name, phone, app_role")
    .eq("phone", normalized)
    .maybeSingle();
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (!data) {
    console.error("No profile is stored for that phone. The person must sign in once before promotion.");
    process.exit(1);
  }

  const saved = await admin
    .from("profiles")
    .update({ app_role: "admin", account_status: "active" })
    .eq("id", data.id)
    .select("id, full_name, phone, app_role")
    .single();
  if (saved.error) {
    console.error(saved.error.message);
    process.exit(1);
  }
  console.log(`Promoted ${saved.data.full_name || saved.data.phone} to admin.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

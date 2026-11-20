const { getSupabaseAdmin } = require("../lib/clients");
const { adminPhones, isUuid, phoneFromUser } = require("./access");

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function trackActivity(event) {
  try {
    const profileId = event && event.profileId;
    if (!isUuid(profileId)) return;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;

    const row = {
      profile_id: profileId,
      event_type: String(event.eventType || "activity").slice(0, 80),
      description: String(event.description || "Activity recorded").slice(0, 400),
      resource_type: event.resourceType ? String(event.resourceType).slice(0, 40) : null,
      resource_id: event.resourceId ? String(event.resourceId).slice(0, 80) : null,
      status: String(event.status || "recorded").slice(0, 40),
      dedupe_key: event.dedupeKey ? String(event.dedupeKey).slice(0, 160) : null,
    };

    const { error } = await getSupabaseAdmin().from("activity_events").insert(row);
    if (error && error.code !== "23505") {
      console.error(`activity log skipped: ${error.code || error.message}`);
    }
  } catch (err) {
    console.error(`activity log skipped: ${err.message || err}`);
  }
}

async function trackRequest(req, event) {
  try {
    const { authenticate } = require("./access");
    const user = await authenticate(req);
    if (!user) return;
    await trackActivity({ profileId: user.id, ...event });
  } catch (err) {
    console.error(`activity log skipped: ${err.message || err}`);
  }
}

async function noteLogin(user) {
  try {
    if (!user || !isUuid(user.id)) return;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;
    const patch = { last_login_at: new Date().toISOString() };
    const phone = phoneFromUser(user);
    if (phone && adminPhones().has(phone)) patch.app_role = "admin";
    const { error } = await getSupabaseAdmin().from("profiles").update(patch).eq("id", user.id);
    if (error) {
      console.error(`login stamp skipped: ${error.code || error.message}`);
    }
    await trackActivity({
      profileId: user.id,
      eventType: "login",
      description: "Signed in",
      status: "recorded",
      dedupeKey: `login:${user.id}:${dayKey()}`,
    });
  } catch (err) {
    console.error(`login stamp skipped: ${err.message || err}`);
  }
}

module.exports = { trackActivity, trackRequest, noteLogin, dayKey };

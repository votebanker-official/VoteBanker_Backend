const crypto = require("node:crypto");

const { getSupabaseAdmin } = require("../lib/clients");

const LIST_COLUMNS =
  "id, owner_user_id, name, age, gender, epic_number, source_serial, import_batch_id, needs_review, review_notes, is_shared, whatsapp_contact, instagram_contact, facebook_contact, created_at";

const CONTACT_MAX = {
  whatsapp_contact: 40,
  instagram_contact: 200,
  facebook_contact: 200,
};

function stableBatchId(sourceLabel) {
  const label = String(sourceLabel || "electoral-roll").trim().toLowerCase();
  return `vrm_${crypto.createHash("sha256").update(label).digest("hex").slice(0, 24)}`;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    age: row.age,
    gender: row.gender,
    epicNumber: row.epic_number,
    sourceSerial: row.source_serial,
    importBatchId: row.import_batch_id,
    needsReview: Boolean(row.needs_review),
    reviewNotes: row.review_notes,
    isShared: Boolean(row.is_shared),
    whatsappContact: row.whatsapp_contact || null,
    instagramContact: row.instagram_contact || null,
    facebookContact: row.facebook_contact || null,
    createdAt: row.created_at,
  };
}

const CONTACT_FIELDS = [
  ["whatsappContact", "whatsapp_contact"],
  ["instagramContact", "instagram_contact"],
  ["facebookContact", "facebook_contact"],
];

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const FACEBOOK_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "fb.com",
  "www.fb.com",
  "m.fb.com",
]);

function isHandleOrProfileUrl(value, hosts) {
  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.username || url.password) return false;
    return hosts.has(url.hostname.toLowerCase());
  }
  if (/[\s/\\]/.test(value)) return false;
  const handle = value.replace(/^@/, "");
  return /^[A-Za-z0-9._]{1,50}$/.test(handle);
}

function validateContactColumn(column, raw) {
  if (raw == null) return { ok: true, value: null };
  const value = String(raw).trim();
  if (!value) return { ok: true, value: null };
  if (value.length > CONTACT_MAX[column]) return { ok: false };

  if (column === "whatsapp_contact") {
    if (!/^[0-9+\-().\s]+$/.test(value)) return { ok: false };
    const digits = value.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return { ok: false };
    return { ok: true, value };
  }
  if (column === "instagram_contact" && !isHandleOrProfileUrl(value, INSTAGRAM_HOSTS)) {
    return { ok: false };
  }
  if (column === "facebook_contact" && !isHandleOrProfileUrl(value, FACEBOOK_HOSTS)) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Only keys present on the request are updated. An empty string clears that field.
 * Omitted keys keep the stored value.
 */
function buildContactPatch(contacts = {}) {
  const source = contacts && typeof contacts === "object" ? contacts : {};
  const patch = {};
  for (const [camel, snake] of CONTACT_FIELDS) {
    const hasCamel = Object.prototype.hasOwnProperty.call(source, camel);
    const hasSnake = Object.prototype.hasOwnProperty.call(source, snake);
    if (!hasCamel && !hasSnake) continue;
    const result = validateContactColumn(snake, hasCamel ? source[camel] : source[snake]);
    if (!result.ok) {
      const err = new Error("invalid_contact");
      err.code = "invalid_contact";
      err.field = camel;
      return { error: err, patch: null };
    }
    patch[snake] = result.value;
  }
  return { error: null, patch };
}

function groupSocialContacts(records, query = "") {
  const needle = String(query || "").trim().toLowerCase();
  const sections = {
    whatsapp: [],
    instagram: [],
    facebook: [],
  };
  const seen = {
    whatsapp: new Set(),
    instagram: new Set(),
    facebook: new Set(),
  };

  for (const row of records || []) {
    const name = row && row.name ? String(row.name) : "";
    const id = row && row.id ? String(row.id) : "";
    if (!id || !name) continue;

    const whatsapp = row.whatsappContact || null;
    const instagram = row.instagramContact || null;
    const facebook = row.facebookContact || null;
    const epic = row.epicNumber || null;

    if (whatsapp) {
      const key = `${id}|${whatsapp}`;
      const hay = `${name} ${whatsapp} ${epic || ""}`.toLowerCase();
      if (!seen.whatsapp.has(key) && (!needle || hay.includes(needle))) {
        seen.whatsapp.add(key);
        sections.whatsapp.push({
          id,
          name,
          epicNumber: epic,
          whatsappContact: whatsapp,
        });
      }
    }
    if (instagram) {
      const key = `${id}|${instagram}`;
      const hay = `${name} ${instagram}`.toLowerCase();
      if (!seen.instagram.has(key) && (!needle || hay.includes(needle))) {
        seen.instagram.add(key);
        sections.instagram.push({ id, name, instagramContact: instagram });
      }
    }
    if (facebook) {
      const key = `${id}|${facebook}`;
      const hay = `${name} ${facebook}`.toLowerCase();
      if (!seen.facebook.has(key) && (!needle || hay.includes(needle))) {
        seen.facebook.add(key);
        sections.facebook.push({ id, name, facebookContact: facebook });
      }
    }
  }

  return {
    counts: {
      whatsapp: sections.whatsapp.length,
      instagram: sections.instagram.length,
      facebook: sections.facebook.length,
    },
    whatsapp: sections.whatsapp,
    instagram: sections.instagram,
    facebook: sections.facebook,
  };
}

/**
 * Update only WhatsApp / Instagram / Facebook on an authorized record.
 * Does not touch name, age, gender, EPIC, or other voter fields.
 */
async function updateVoterContacts(userId, recordId, contacts = {}, options = {}) {
  if (!userId) {
    const err = new Error("unauthorized");
    err.code = "unauthorized";
    throw err;
  }
  if (!recordId || typeof recordId !== "string") {
    const err = new Error("invalid_record_id");
    err.code = "invalid_record_id";
    throw err;
  }

  const supabase = options.supabase || getSupabaseAdmin();
  const { data: existing, error: loadError } = await supabase
    .from("vrm_voter_records")
    .select(LIST_COLUMNS)
    .eq("id", recordId)
    .maybeSingle();

  if (loadError) {
    const err = new Error("vrm_contact_update_failed");
    err.code = "vrm_contact_update_failed";
    err.cause = loadError;
    throw err;
  }
  if (!existing) {
    const err = new Error("not_found");
    err.code = "not_found";
    throw err;
  }

  const isOwner = existing.owner_user_id === userId;
  const isShared = Boolean(existing.is_shared);
  if (!isOwner && !isShared) {
    const err = new Error("forbidden");
    err.code = "forbidden";
    throw err;
  }

  const built = buildContactPatch(contacts);
  if (built.error) throw built.error;
  if (Object.keys(built.patch).length === 0) return mapRow(existing);

  const patch = built.patch;

  const { data, error } = await supabase
    .from("vrm_voter_records")
    .update(patch)
    .eq("id", recordId)
    .select(LIST_COLUMNS)
    .maybeSingle();

  if (error) {
    const err = new Error("vrm_contact_update_failed");
    err.code = "vrm_contact_update_failed";
    err.cause = error;
    throw err;
  }
  return mapRow(data);
}

async function listVoterRecords(ownerUserId, { q, limit = 200 } = {}) {
  const supabase = getSupabaseAdmin();
  // Shared catalog is public (including signed-out users).
  // Signed-in users also see any private rows they own.
  let query = supabase
    .from("vrm_voter_records")
    .select(LIST_COLUMNS)
    .order("source_serial", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(Number(limit) || 200, 1), 500));

  if (ownerUserId) {
    query = query.or(`is_shared.eq.true,owner_user_id.eq.${ownerUserId}`);
  } else {
    query = query.eq("is_shared", true);
  }

  const { data, error } = await query;

  if (error) {
    const err = new Error("vrm_list_failed");
    err.code = "vrm_list_failed";
    err.cause = error;
    throw err;
  }

  const rows = (data || []).map(mapRow);
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) {
    return rows;
  }
  return rows.filter((row) => {
    const name = String(row.name || "").toLowerCase();
    const epic = String(row.epicNumber || "").toLowerCase();
    return name.includes(needle) || epic.includes(needle);
  });
}

/**
 * Insert previewed records for one owner. Idempotent on (owner, batch, serial)
 * and (owner, epic). Does not delete or overwrite existing rows.
 */
async function importVoterRecords(ownerUserId, records, options = {}) {
  const batchId = options.batchId || stableBatchId(options.sourceLabel || "import");
  const supabase = getSupabaseAdmin();

  const rows = [];
  const skipped = [];

  for (const item of records) {
    const name = item && item.name != null ? String(item.name).trim() : "";
    if (!name) {
      skipped.push({
        sourceSerial: item && item.sourceSerial,
        reason: "missing_name",
      });
      continue;
    }

    rows.push({
      owner_user_id: ownerUserId,
      name: name.slice(0, 200),
      age: item.age == null ? null : Number(item.age),
      gender: item.gender ? String(item.gender).slice(0, 40) : null,
      epic_number: item.epicNumber ? String(item.epicNumber).trim().toUpperCase() : null,
      source_serial: item.sourceSerial == null ? null : Number(item.sourceSerial),
      import_batch_id: batchId,
      needs_review: Boolean(item.needsReview),
      review_notes: item.reviewNotes ? String(item.reviewNotes).slice(0, 200) : null,
      // Electoral-roll seed is a shared catalog for all signed-in users.
      is_shared: options.shared !== false,
    });
  }

  if (rows.length === 0) {
    return {
      batchId,
      inserted: 0,
      skippedDuplicates: 0,
      skippedInvalid: skipped.length,
      skipped,
      records: [],
    };
  }

  // Load existing keys for this owner so re-imports do not duplicate.
  const { data: existing, error: existingError } = await supabase
    .from("vrm_voter_records")
    .select("epic_number, source_serial, import_batch_id")
    .eq("owner_user_id", ownerUserId);

  if (existingError) {
    const err = new Error("vrm_import_failed");
    err.code = "vrm_import_failed";
    err.cause = existingError;
    throw err;
  }

  const existingEpics = new Set(
    (existing || [])
      .map((row) => (row.epic_number ? String(row.epic_number).toUpperCase() : null))
      .filter(Boolean)
  );
  const existingBatchSerials = new Set(
    (existing || [])
      .filter((row) => row.import_batch_id && row.source_serial != null)
      .map((row) => `${row.import_batch_id}:${row.source_serial}`)
  );

  const toInsert = [];
  let skippedDuplicates = 0;
  for (const row of rows) {
    const batchKey =
      row.import_batch_id && row.source_serial != null
        ? `${row.import_batch_id}:${row.source_serial}`
        : null;
    if (batchKey && existingBatchSerials.has(batchKey)) {
      skippedDuplicates += 1;
      continue;
    }
    if (row.epic_number && existingEpics.has(row.epic_number)) {
      skippedDuplicates += 1;
      continue;
    }
    toInsert.push(row);
  }

  if (toInsert.length === 0) {
    return {
      batchId,
      inserted: 0,
      skippedDuplicates,
      skippedInvalid: skipped.length,
      skipped,
      records: [],
    };
  }

  const { data, error } = await supabase
    .from("vrm_voter_records")
    .insert(toInsert)
    .select(LIST_COLUMNS);

  if (error) {
    if (error.code === "23505") {
      // Race or leftover unique conflict: fall back to row-by-row inserts.
      return importOneByOne(supabase, toInsert, batchId, skipped, skippedDuplicates);
    }
    const err = new Error("vrm_import_failed");
    err.code = "vrm_import_failed";
    err.cause = error;
    throw err;
  }

  const insertedRows = data || [];
  return {
    batchId,
    inserted: insertedRows.length,
    skippedDuplicates,
    skippedInvalid: skipped.length,
    skipped,
    records: insertedRows.map(mapRow),
  };
}

async function importOneByOne(supabase, rows, batchId, skipped, skippedDuplicatesStart = 0) {
  let inserted = 0;
  let skippedDuplicates = skippedDuplicatesStart;
  const records = [];

  for (const row of rows) {
    const { data, error } = await supabase
      .from("vrm_voter_records")
      .insert(row)
      .select(LIST_COLUMNS)
      .maybeSingle();

    if (error) {
      if (error.code === "23505") {
        skippedDuplicates += 1;
        continue;
      }
      const err = new Error("vrm_import_failed");
      err.code = "vrm_import_failed";
      err.cause = error;
      throw err;
    }
    if (data) {
      inserted += 1;
      records.push(mapRow(data));
    }
  }

  return {
    batchId,
    inserted,
    skippedDuplicates,
    skippedInvalid: skipped.length,
    skipped,
    records,
  };
}

module.exports = {
  buildContactPatch,
  groupSocialContacts,
  importVoterRecords,
  listVoterRecords,
  mapRow,
  stableBatchId,
  updateVoterContacts,
};

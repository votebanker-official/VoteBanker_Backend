/**
 * Upserts the committed LGD snapshot into Supabase.
 * The snapshot is produced from the official workbooks named in data/lgd/source.json.
 * Assembly constituencies are intentionally not seeded.
 */
const { createClient } = require("@supabase/supabase-js");
const states = require("../data/lgd/states.json");
const districts = require("../data/lgd/districts.json");

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }
  const db = createClient(url, key);
  const stateRows = states.map((state) => ({
    id: state.id,
    official_state_code: state.code,
    name: state.name,
    local_name: state.local_name,
    state_or_ut: state.type,
  }));
  const { error: stateError } = await db.from("states").upsert(stateRows, { onConflict: "id" });
  if (stateError) throw stateError;
  const districtRows = districts.map((district) => ({
    id: district.id,
    official_district_code: district.code,
    state_id: district.state_id,
    name: district.name,
  }));
  const { error: districtError } = await db
    .from("districts")
    .upsert(districtRows, { onConflict: "id" });
  if (districtError) throw districtError;
  console.log(`Upserted ${stateRows.length} states and ${districtRows.length} districts.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

/**
 * Upserts the committed LGD snapshot into Supabase.
 * Assembly rows are inserted from data/lgd/assembly_constituencies.json.
 * Existing constituency rows are left in place; this script does not delete them.
 */
const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");
const { loadEnv } = require("../src/env");
const states = require("../data/lgd/states.json");
const districts = require("../data/lgd/districts.json");

loadEnv();

const assemblyPath = path.join(__dirname, "../data/lgd/assembly_constituencies.json");

async function seedStatesAndDistricts() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.log("Skipping state and district upsert; Supabase credentials are not set.");
    return;
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

async function insertChunks(client, table, columns, rows, conflict) {
  const width = columns.length;
  const size = 200;
  for (let start = 0; start < rows.length; start += size) {
    const chunk = rows.slice(start, start + size);
    const params = [];
    const values = chunk.map((row, rowIndex) => {
      const placeholders = columns.map((_, columnIndex) => {
        params.push(row[columnIndex]);
        return `$${rowIndex * width + columnIndex + 1}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const override = table === "assembly_constituencies" ? "overriding system value" : "";
    await client.query(
      `insert into public.${table} (${columns.join(", ")})
       ${override}
       values ${values.join(", ")}
       on conflict ${conflict} do nothing`,
      params,
    );
  }
}

async function seedAssemblyConstituencies() {
  if (!process.env.DATABASE_URL) {
    console.log("Skipping assembly constituency import; DATABASE_URL is not set.");
    return;
  }
  if (!fs.existsSync(assemblyPath)) {
    console.log("Skipping assembly constituency import; the catalog file is missing.");
    return;
  }
  const catalog = JSON.parse(fs.readFileSync(assemblyPath, "utf8"));
  let Client;
  try {
    ({ Client } = require("pg"));
  } catch {
    console.log("Skipping assembly constituency import; the pg package is not installed.");
    return;
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const table = await client.query(
      "select to_regclass('public.assembly_constituencies') as name",
    );
    if (!table.rows[0].name) {
      console.log(
        "Skipping assembly constituency import; public.assembly_constituencies does not exist.",
      );
      return;
    }
    const existing = await client.query("select count(*)::int as count from public.assembly_constituencies");
    if (existing.rows[0].count > 0) {
      console.log(
        `Leaving ${existing.rows[0].count} existing assembly constituencies in place. No rows were deleted.`,
      );
      return;
    }
    await insertChunks(
      client,
      "assembly_constituencies",
      ["id", "state_id", "constituency_number", "name"],
      catalog.map((row) => [row.id, row.state_id, row.constituency_number, row.name]),
      "(state_id, constituency_number)",
    );
    await insertChunks(
      client,
      "district_assembly_constituency",
      ["district_id", "assembly_constituency_id"],
      catalog.map((row) => [row.district_id, row.id]),
      "(district_id, assembly_constituency_id)",
    );
    const check = await client.query("select count(*)::int as count from public.assembly_constituencies");
    console.log(`Inserted ${check.rows[0].count} assembly constituencies.`);
  } finally {
    await client.end();
  }
}

async function main() {
  try {
    await seedStatesAndDistricts();
  } catch (error) {
    console.error(`State and district upsert was not completed: ${error.message}`);
  }
  await seedAssemblyConstituencies();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

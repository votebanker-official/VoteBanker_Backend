#!/usr/bin/env node
/** Apply the VRM voter records migration via DATABASE_URL. */
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv } = require("../src/env");

loadEnv();

async function main() {
  let Client;
  try {
    ({ Client } = require("pg"));
  } catch {
    console.error("Install pg to apply migrations: npm install pg");
    process.exit(1);
  }

  const sqlPath = path.join(
    __dirname,
    "..",
    "supabase",
    "migrations",
    "20261019120000_vrm_voter_records.sql"
  );
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(sql);
    const check = await client.query(
      "select to_regclass('public.vrm_voter_records') as table_name"
    );
    console.log("vrm_voter_records:", check.rows[0].table_name);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

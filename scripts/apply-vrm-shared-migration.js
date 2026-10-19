#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv } = require("../src/env");

loadEnv();

async function main() {
  const { Client } = require("pg");
  const sqlPath = path.join(
    __dirname,
    "..",
    "supabase",
    "migrations",
    "20261019140000_vrm_shared_catalog.sql"
  );
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(fs.readFileSync(sqlPath, "utf8"));
    const check = await client.query(
      "select count(*)::int as shared from public.vrm_voter_records where is_shared = true"
    );
    console.log("shared_records:", check.rows[0].shared);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

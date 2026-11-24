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
    "20261124170000_vrm_package_requests.sql",
  );
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(fs.readFileSync(sqlPath, "utf8"));
    const check = await client.query(
      `select column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'vrm_package_requests'
       order by ordinal_position`,
    );
    console.log("vrm_package_requests_columns:", check.rows.map((row) => row.column_name));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

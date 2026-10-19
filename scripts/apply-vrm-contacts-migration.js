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
    "20261019150000_vrm_social_contacts.sql"
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
         and table_name = 'vrm_voter_records'
         and column_name in ('whatsapp_contact','instagram_contact','facebook_contact')
       order by column_name`
    );
    console.log(
      "contact_columns:",
      check.rows.map((row) => row.column_name)
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

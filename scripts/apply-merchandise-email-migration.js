#!/usr/bin/env node
/** Add contact_email on merchandise_orders. Prints only the column name. */
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv } = require("../src/env");

loadEnv();

async function main() {
  const { Client } = require("pg");
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "supabase", "migrations", "20261122170000_merchandise_order_email.sql"),
    "utf8",
  );
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(sql);
    const check = await client.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'merchandise_orders' and column_name = 'contact_email'",
    );
    console.log("contact_email:", check.rows[0] ? check.rows[0].column_name : "missing");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.includes("postgres://") ? "migration_failed" : message);
  process.exit(1);
});

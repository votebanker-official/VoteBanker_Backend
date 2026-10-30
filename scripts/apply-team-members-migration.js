#!/usr/bin/env node
/** Apply the team_members migration via DATABASE_URL. Prints only table status. */
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv } = require("../src/env");

loadEnv();

async function main() {
  const { Client } = require("pg");
  const sqlPath = path.join(__dirname, "..", "supabase", "migrations", "20261030160000_team_members.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(sql);
    const check = await client.query("select to_regclass('public.team_members') as table_name");
    const name = check.rows[0] && check.rows[0].table_name;
    if (name !== "team_members") {
      throw new Error("table_missing_after_migration");
    }
    console.log("team_members: ready");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  const message = String(err && err.message ? err.message : err);
  console.error(message.includes("postgres://") ? "migration_failed" : message);
  process.exit(1);
});

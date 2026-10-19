#!/usr/bin/env node
/**
 * Confirm import of a preview JSON into Supabase for one owner user.
 * Uses SUPABASE_SECRET_KEY on the server only.
 *
 * Usage:
 *   node scripts/vrm-import-confirm.js --preview tmp/vrm-import-preview.json --user <auth-user-uuid>
 *   node scripts/vrm-import-confirm.js --preview tmp/vrm-import-preview.json --user <uuid> --dry-run
 */
const fs = require("node:fs");
const path = require("node:path");

const { loadEnv } = require("../src/env");
const { importVoterRecords } = require("../src/vrm/records");

loadEnv();

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

async function main() {
  const previewPath = argValue("--preview");
  const userId = argValue("--user");
  const dryRun = process.argv.includes("--dry-run");

  if (!previewPath || !userId) {
    console.error("Required: --preview <file> --user <auth-user-uuid>");
    process.exit(1);
  }

  const absolute = path.resolve(previewPath);
  const payload = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const records = Array.isArray(payload.preview) ? payload.preview : [];
  if (records.length === 0) {
    console.error("Preview contains no records.");
    process.exit(1);
  }
  if (records.length > 50) {
    console.error("Preview has more than 50 records; refusing import.");
    process.exit(1);
  }

  console.log(`Preview records: ${records.length}`);
  console.log(`Review flags: ${(payload.review || []).length}`);
  console.log(`Owner user: ${userId}`);
  console.log(`Batch: ${payload.batchId || "(auto)"}`);

  if (dryRun) {
    console.log("Dry run only — no Supabase writes.");
    process.exit(0);
  }

  const result = await importVoterRecords(userId, records, {
    batchId: payload.batchId,
    sourceLabel: payload.sourceLabel || absolute,
  });

  const out = path.join(path.dirname(absolute), "vrm-import-result.json");
  fs.writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
  console.log(`Inserted: ${result.inserted}`);
  console.log(`Skipped duplicates: ${result.skippedDuplicates}`);
  console.log(`Skipped invalid: ${result.skippedInvalid}`);
  console.log(`Wrote result: ${out}`);
}

main().catch((err) => {
  console.error(err && err.cause ? err.cause : err);
  process.exit(1);
});

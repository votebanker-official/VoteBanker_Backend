#!/usr/bin/env node
/**
 * Extract the first 50 voter records from an electoral-roll PDF (OCR) or OCR fixtures.
 * Writes a reviewable preview JSON. Does not insert into Supabase.
 *
 * Usage:
 *   node scripts/vrm-import-preview.js --pdf "C:/path/to/roll.pdf"
 *   node scripts/vrm-import-preview.js --fixtures
 */
const fs = require("node:fs");
const path = require("node:path");

const { loadEnv } = require("../src/env");
const { extractFirstVotersFromPdf, extractFromOcrTexts } = require("../src/vrm/extract_pdf");
const { stableBatchId } = require("../src/vrm/records");

loadEnv();

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

async function main() {
  const outPath =
    argValue("--out") ||
    path.join(__dirname, "..", "tmp", "vrm-import-preview.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let result;
  let sourceLabel;

  if (process.argv.includes("--fixtures")) {
    const dir = path.join(__dirname, "..", "test", "fixtures", "vrm");
    const texts = ["page3_ocr.txt", "page4_ocr.txt"].map((name) =>
      fs.readFileSync(path.join(dir, name), "utf8")
    );
    result = extractFromOcrTexts(texts, { limit: 50 });
    sourceLabel = "fixtures:page3+page4";
  } else {
    const pdfPath = argValue("--pdf") || process.env.VRM_PDF_PATH;
    if (!pdfPath) {
      console.error("Provide --pdf path or set VRM_PDF_PATH (or use --fixtures).");
      process.exit(1);
    }
    result = extractFirstVotersFromPdf(pdfPath, { limit: 50 });
    sourceLabel = pdfPath;
  }

  const batchId = stableBatchId(sourceLabel);
  const payload = {
    batchId,
    sourceLabel,
    extracted: result.extracted,
    limit: 50,
    preview: result.preview,
    review: result.review,
    pagesOcrd: result.pagesOcrd || null,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote preview: ${outPath}`);
  console.log(`Extracted: ${payload.extracted} (limit 50)`);
  console.log(`Needs review: ${payload.review.length}`);
  console.log(`Batch id: ${batchId}`);
}

main().catch((err) => {
  console.error(err && err.code ? err.code : err);
  process.exit(1);
});

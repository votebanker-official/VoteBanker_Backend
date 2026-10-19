/**
 * Render scanned electoral-roll PDF pages and OCR them (Tesseract + Poppler).
 * Paths are configurable so secrets/PDFs stay outside the repo.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { parseElectoralOcr, toPreviewRows, DEFAULT_LIMIT } = require("./parse_electoral_ocr");

function resolveTool(envName, fallbacks) {
  const fromEnv = process.env[envName];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const candidate of fallbacks) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function defaultPopplerBin(tool) {
  const base = process.env.POPPLER_BIN_DIR;
  if (base) return path.join(base, tool);
  return path.join(
    "C:\\Users\\Lenovo\\Downloads\\Release-25.12.0-0\\poppler-25.12.0\\Library\\bin",
    tool
  );
}

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error) {
    const err = new Error(`${label}_failed`);
    err.code = `${label}_failed`;
    err.cause = result.error;
    throw err;
  }
  if (result.status !== 0) {
    const err = new Error(`${label}_failed`);
    err.code = `${label}_failed`;
    err.stderr = result.stderr;
    throw err;
  }
  return result;
}

function ocrImage(imagePath, outBase, tesseractPath) {
  run(
    tesseractPath,
    [imagePath, outBase, "-l", "eng", "--psm", "4"],
    "tesseract"
  );
  const txtPath = `${outBase}.txt`;
  return fs.readFileSync(txtPath, "utf8");
}

/**
 * OCR pages starting at firstVotersPage until `limit` records are collected.
 */
function extractFirstVotersFromPdf(pdfPath, options = {}) {
  const limit = options.limit || DEFAULT_LIMIT;
  const firstPage = options.firstVotersPage || 3;
  const maxPages = options.maxPages || 4;
  const workDir =
    options.workDir ||
    fs.mkdtempSync(path.join(os.tmpdir(), "votebanker-vrm-"));

  const pdftoppm = resolveTool("PDFTOPPM_PATH", [
    defaultPopplerBin(process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm"),
  ]);
  const tesseract = resolveTool("TESSERACT_PATH", [
    "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
    "/usr/bin/tesseract",
  ]);

  if (!pdfPath || !fs.existsSync(pdfPath)) {
    const err = new Error("pdf_not_found");
    err.code = "pdf_not_found";
    throw err;
  }
  if (!pdftoppm) {
    const err = new Error("pdftoppm_not_found");
    err.code = "pdftoppm_not_found";
    throw err;
  }
  if (!tesseract) {
    const err = new Error("tesseract_not_found");
    err.code = "tesseract_not_found";
    throw err;
  }

  fs.mkdirSync(workDir, { recursive: true });
  const prefix = path.join(workDir, "roll");
  const lastPage = firstPage + maxPages - 1;

  run(
    pdftoppm,
    ["-f", String(firstPage), "-l", String(lastPage), "-png", "-r", String(options.dpi || 200), pdfPath, prefix],
    "pdftoppm"
  );

  const images = fs
    .readdirSync(workDir)
    .filter((name) => name.startsWith("roll") && name.endsWith(".png"))
    .sort()
    .map((name) => path.join(workDir, name));

  if (images.length === 0) {
    const err = new Error("pdf_render_empty");
    err.code = "pdf_render_empty";
    throw err;
  }

  const ocrChunks = [];
  for (let i = 0; i < images.length; i += 1) {
    const outBase = path.join(workDir, `ocr_${i + 1}`);
    ocrChunks.push(ocrImage(images[i], outBase, tesseract));
  }

  const combined = ocrChunks.join("\n\n");
  const parsed = parseElectoralOcr(combined, { limit });
  return {
    ...parsed,
    preview: toPreviewRows(parsed.records),
    pagesOcrd: images.length,
    firstVotersPage: firstPage,
    workDir,
  };
}

/**
 * Parse pre-saved OCR text files (for tests / offline preview).
 */
function extractFromOcrTexts(texts, options = {}) {
  const limit = options.limit || DEFAULT_LIMIT;
  const combined = (Array.isArray(texts) ? texts : [texts]).join("\n\n");
  const parsed = parseElectoralOcr(combined, { limit });
  return {
    ...parsed,
    preview: toPreviewRows(parsed.records),
  };
}

module.exports = {
  extractFirstVotersFromPdf,
  extractFromOcrTexts,
};

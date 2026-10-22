const express = require("express");
const rateLimit = require("express-rate-limit");

const clients = require("../lib/clients");
const { extractFirstVotersFromPdf, extractFromOcrTexts } = require("../vrm/extract_pdf");
const { parseElectoralOcr, toPreviewRows, DEFAULT_LIMIT } = require("../vrm/parse_electoral_ocr");
const {
  importVoterRecords,
  listVoterRecords,
  stableBatchId,
  updateVoterContacts,
} = require("../vrm/records");

const router = express.Router();

async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, error: "unauthorized" });

    const { data, error } = await clients.getSupabasePublic().auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ success: false, error: "unauthorized" });

    req.user = data.user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Attach req.user when a valid token is present; otherwise continue as guest. */
async function optionalUser(req, _res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      req.user = null;
      return next();
    }
    const { data, error } = await clients.getSupabasePublic().auth.getUser(token);
    req.user = !error && data && data.user ? data.user : null;
    next();
  } catch (err) {
    next(err);
  }
}

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "rate_limited" },
});

router.use(limiter);

/** Shared voter catalog is public; signed-in users also see their private rows. */
router.get("/records", optionalUser, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const ownerId = req.user && req.user.id ? req.user.id : null;
    const records = await listVoterRecords(ownerId, { q });
    res.json({ success: true, records });
  } catch (err) {
    next(err);
  }
});

/**
 * Save WhatsApp / Instagram / Facebook for one voter record.
 * Requires auth. Only contact columns are updated.
 */
router.patch("/records/:id/contacts", requireUser, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const record = await updateVoterContacts(req.user.id, req.params.id, body);
    res.json({ success: true, record });
  } catch (err) {
    const code = err && err.code ? err.code : "vrm_contact_update_failed";
    if (code === "unauthorized") {
      return res.status(401).json({ success: false, error: code });
    }
    if (code === "forbidden") {
      return res.status(403).json({ success: false, error: code });
    }
    if (code === "not_found" || code === "invalid_record_id") {
      return res.status(404).json({ success: false, error: code });
    }
    if (code === "invalid_contact") {
      return res.status(400).json({ success: false, error: code, field: err.field || null });
    }
    return next(err);
  }
});

/**
 * Preview extraction from OCR text body (no PDF stored).
 * Body: { ocrText: string } or { ocrTexts: string[] }
 */
router.post("/import/preview-ocr", requireUser, async (req, res) => {
  const source = req.body && typeof req.body === "object" ? req.body : {};
  const texts = Array.isArray(source.ocrTexts)
    ? source.ocrTexts
    : typeof source.ocrText === "string"
      ? [source.ocrText]
      : null;

  if (!texts || texts.length === 0) {
    return res.status(400).json({ success: false, error: "missing_ocr_text" });
  }

  const parsed = extractFromOcrTexts(texts, { limit: DEFAULT_LIMIT });
  if (parsed.extracted === 0) {
    return res.status(422).json({
      success: false,
      error: "no_records_parsed",
      hint: "OCR text did not contain recognizable voter entries.",
    });
  }

  const batchId = stableBatchId(source.sourceLabel || "ocr-preview");
  return res.json({
    success: true,
    batchId,
    extracted: parsed.extracted,
    limit: parsed.limit,
    preview: parsed.preview,
    review: parsed.review,
  });
});

/**
 * Confirm import of at most 50 previewed records for the signed-in user.
 * Body: { batchId, records: [{ name, age, gender, epicNumber, sourceSerial, needsReview, reviewNotes }] }
 */
router.post("/import/confirm", requireUser, async (req, res, next) => {
  try {
    const source = req.body && typeof req.body === "object" ? req.body : {};
    const records = Array.isArray(source.records) ? source.records : null;
    if (!records || records.length === 0) {
      return res.status(400).json({ success: false, error: "missing_records" });
    }
    if (records.length > DEFAULT_LIMIT) {
      return res.status(400).json({ success: false, error: "too_many_records" });
    }

    const normalized = records.map((item, index) => ({
      name: item && item.name,
      age: item && item.age,
      gender: item && item.gender,
      epicNumber: item && (item.epicNumber || item.epic_number),
      sourceSerial: item && (item.sourceSerial ?? item.source_serial ?? index + 1),
      needsReview: Boolean(item && (item.needsReview || item.needs_review)),
      reviewNotes: item && (item.reviewNotes || item.review_notes),
    }));

    // Never import beyond the first 50 by source serial when serials are present.
    const capped = normalized
      .filter((item) => item.sourceSerial == null || Number(item.sourceSerial) <= DEFAULT_LIMIT)
      .slice(0, DEFAULT_LIMIT);

    const result = await importVoterRecords(req.user.id, capped, {
      batchId: typeof source.batchId === "string" ? source.batchId : undefined,
      sourceLabel: source.sourceLabel || "confirm",
    });

    return res.json({
      success: true,
      batchId: result.batchId,
      inserted: result.inserted,
      skippedDuplicates: result.skippedDuplicates,
      skippedInvalid: result.skippedInvalid,
      skipped: result.skipped,
      records: result.records,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Server-side PDF extract (opt-in). Requires VRM_ALLOW_SERVER_PDF_IMPORT=true
 * and VRM_PDF_PATH. Never stores the PDF in the voter table.
 */
router.post("/import/preview-pdf", requireUser, async (req, res) => {
  if (String(process.env.VRM_ALLOW_SERVER_PDF_IMPORT || "").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: "pdf_import_disabled" });
  }
  const pdfPath = process.env.VRM_PDF_PATH;
  if (!pdfPath) {
    return res.status(503).json({ success: false, error: "pdf_path_not_configured" });
  }

  try {
    const extracted = extractFirstVotersFromPdf(pdfPath, { limit: DEFAULT_LIMIT });
    const batchId = stableBatchId(pdfPath);
    return res.json({
      success: true,
      batchId,
      extracted: extracted.extracted,
      limit: extracted.limit,
      preview: extracted.preview,
      review: extracted.review,
      pagesOcrd: extracted.pagesOcrd,
    });
  } catch (err) {
    const code = err && err.code ? err.code : "pdf_extract_failed";
    return res.status(422).json({ success: false, error: code });
  }
});

module.exports = {
  createVrmRouter: () => router,
  requireUser,
  parseElectoralOcr,
  toPreviewRows,
};

const express = require("express");
const rateLimit = require("express-rate-limit");

const { createOpenproviderClient } = require("./openprovider");

const DEFAULT_EXTENSIONS = ["com", "org", "net", "in", "io", "ai", "co"];
const ALLOWED_EXTENSIONS = new Set([
  "com",
  "in",
  "org",
  "net",
  "co.in",
  "info",
  "biz",
  "io",
  "ai",
  "co",
  "online",
  "site",
  "store",
  "xyz",
]);

const MAX_NAME_LENGTH = 63;
const DEFAULT_MAX_EXTENSIONS = 10;
const DEFAULT_BATCH_SIZE = 10;

// 1–63 chars, alphanumeric edges, hyphens allowed in the middle.
const LABEL_PATTERN = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/;
const EXTENSION_PATTERN = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)(?:\.(?:[a-z0-9]+(?:-[a-z0-9]+)*))*$/;

function maxExtensions(env = process.env) {
  const value = Number(env.OPENPROVIDER_MAX_EXTENSIONS);
  if (Number.isInteger(value) && value >= 1 && value <= 50) {
    return value;
  }
  return DEFAULT_MAX_EXTENSIONS;
}

function batchSize(env = process.env) {
  const value = Number(env.OPENPROVIDER_BATCH_SIZE);
  if (Number.isInteger(value) && value >= 1 && value <= 50) {
    return value;
  }
  return DEFAULT_BATCH_SIZE;
}

function normalizeName(raw) {
  let value = String(raw || "").trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "");
  value = value.replace(/^www\./, "");
  value = value.split("/")[0].split("?")[0].split("#")[0];
  value = value.replace(/\.+$/, "");

  // If the client pasted a full domain with a known extension, keep only the label.
  for (const extension of [...ALLOWED_EXTENSIONS].sort((a, b) => b.length - a.length)) {
    const suffix = `.${extension}`;
    if (value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }

  return value;
}

function normalizeExtension(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

function validateDomainSearch(body, env = process.env) {
  const source = body && typeof body === "object" ? body : {};
  const name = normalizeName(source.name);

  if (!name || name.length > MAX_NAME_LENGTH) {
    return { error: "invalid_name" };
  }
  if (name.includes(".") || name.includes("_") || name.includes(" ")) {
    return { error: "invalid_name" };
  }
  if (!LABEL_PATTERN.test(name)) {
    return { error: "invalid_name" };
  }

  let extensions = Array.isArray(source.extensions) ? source.extensions : DEFAULT_EXTENSIONS;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return { error: "invalid_extensions" };
  }

  const normalized = [];
  const seen = new Set();
  for (const item of extensions) {
    const extension = normalizeExtension(item);
    if (!extension || !EXTENSION_PATTERN.test(extension) || !ALLOWED_EXTENSIONS.has(extension)) {
      return { error: "invalid_extensions" };
    }
    if (seen.has(extension)) {
      continue;
    }
    seen.add(extension);
    normalized.push(extension);
  }

  if (normalized.length === 0) {
    return { error: "invalid_extensions" };
  }
  if (normalized.length > maxExtensions(env)) {
    return { error: "too_many_extensions" };
  }

  return { value: { name, extensions: normalized } };
}

function extractPrice(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const reseller = entry.price && entry.price.reseller;
  const product = entry.price && entry.price.product;
  const source = reseller && reseller.currency != null && reseller.price != null
    ? reseller
    : product && product.currency != null && product.price != null
      ? product
      : null;

  if (!source) {
    return null;
  }

  const amount = Number(source.price);
  const currency = String(source.currency || "").trim().toUpperCase();
  if (!Number.isFinite(amount) || !currency) {
    return null;
  }

  return { amount, currency };
}

function mapDomainResult(entry, requested) {
  const domain = String(
    (entry && entry.domain) ||
      (requested ? `${requested.name}.${requested.extension}` : "")
  ).toLowerCase();

  if (!entry || typeof entry !== "object" || !domain) {
    return {
      domain: domain || null,
      available: false,
      status: "unknown",
      price: null,
      isPremium: false,
      error: "malformed_result",
    };
  }

  const rawStatus = String(entry.status || "").trim().toLowerCase();
  const isPremium = Boolean(entry.is_premium);
  const price = extractPrice(entry);

  if (rawStatus === "free") {
    return {
      domain,
      available: true,
      status: "free",
      price,
      isPremium,
    };
  }

  if (rawStatus === "reserved" || rawStatus === "in use") {
    return {
      domain,
      available: false,
      status: rawStatus,
      price,
      isPremium,
    };
  }

  return {
    domain,
    available: false,
    status: rawStatus || "unknown",
    price,
    isPremium,
    error: "unknown_status",
  };
}

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function searchDomains(body, options = {}) {
  const env = options.env || process.env;
  const parsed = validateDomainSearch(body, env);
  if (parsed.error) {
    return { status: 400, body: { success: false, error: parsed.error } };
  }

  const client = options.client || createOpenproviderClient({ env, fetchImpl: options.fetchImpl });
  const config = client.readConfig();
  if (config.error) {
    return { status: 503, body: { success: false, error: config.error } };
  }

  const requests = parsed.value.extensions.map((extension) => ({
    name: parsed.value.name,
    extension,
  }));

  try {
    const upstream = [];
    for (const batch of chunk(requests, batchSize(env))) {
      const results = await client.checkDomains(batch);
      upstream.push(...results);
    }

    const byDomain = new Map();
    for (const entry of upstream) {
      if (entry && entry.domain) {
        byDomain.set(String(entry.domain).toLowerCase(), entry);
      }
    }

    const results = requests.map((requested) => {
      const key = `${requested.name}.${requested.extension}`.toLowerCase();
      const entry = byDomain.get(key);
      if (!entry) {
        return {
          domain: key,
          available: false,
          status: "unknown",
          price: null,
          isPremium: false,
          error: "missing_result",
        };
      }
      return mapDomainResult(entry, requested);
    });

    return { status: 200, body: { success: true, results } };
  } catch (error) {
    const code = error && error.code ? error.code : "openprovider_check_failed";
    console.error(`domain search failed: ${code}`);
    const status =
      code === "openprovider_timeout" || code === "openprovider_unreachable"
        ? 504
        : code === "openprovider_auth_failed" || code === "openprovider_access_denied"
          ? 502
          : 502;
    return { status, body: { success: false, error: code } };
  }
}

function createDomainsRouter(options = {}) {
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(options.rateLimitPerMinute) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "rate_limited" },
  });

  router.post("/search", limiter, async (req, res) => {
    const result = await searchDomains(req.body, options);
    res.status(result.status).json(result.body);
  });

  return router;
}

module.exports = {
  ALLOWED_EXTENSIONS,
  DEFAULT_EXTENSIONS,
  createDomainsRouter,
  extractPrice,
  mapDomainResult,
  normalizeExtension,
  normalizeName,
  searchDomains,
  validateDomainSearch,
};

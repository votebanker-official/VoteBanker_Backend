const express = require("express");
const rateLimit = require("express-rate-limit");

const { createOpenproviderClient, detectEgressIp } = require("./openprovider");

// Standard TLDs shown first (when available).
const STANDARD_EXTENSIONS = ["com", "in", "org", "co", "ai", "io", "net"];
// Additional popular TLDs checked after the standard set.
const EXTRA_EXTENSIONS = [
  "co.in",
  "info",
  "biz",
  "online",
  "site",
  "store",
  "xyz",
  "me",
  "app",
  "dev",
  "tech",
  "live",
  "world",
  "club",
  "shop",
  "blog",
];
const DEFAULT_EXTENSIONS = [...STANDARD_EXTENSIONS, ...EXTRA_EXTENSIONS];
const ALLOWED_EXTENSIONS = new Set(DEFAULT_EXTENSIONS);

const UNAVAILABLE_STATUSES = new Set([
  "active",
  "in use",
  "reserved",
  "unavailable",
  "taken",
  "registered",
]);

const MAX_NAME_LENGTH = 63;
const DEFAULT_MAX_EXTENSIONS = 30;
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

  // Openprovider account/reseller registration price (account currency).
  const reseller = entry.price && entry.price.reseller;
  // Supplier/product price (often USD in RCP).
  const product = entry.price && entry.price.product;
  // Premium create price when present.
  const premiumCreate =
    entry.premium && entry.premium.price && entry.premium.price.create != null
      ? entry.premium.price.create
      : null;

  if (reseller && reseller.currency != null && reseller.price != null) {
    const amount = Number(reseller.price);
    const currency = String(reseller.currency || "").trim().toUpperCase();
    if (Number.isFinite(amount) && currency) {
      return { amount, currency, source: "reseller" };
    }
  }

  if (entry.is_premium && premiumCreate != null && product && product.currency) {
    const amount = Number(premiumCreate);
    const currency = String(product.currency || "").trim().toUpperCase();
    if (Number.isFinite(amount) && currency) {
      return { amount, currency, source: "premium_create" };
    }
  }

  if (product && product.currency != null && product.price != null) {
    const amount = Number(product.price);
    const currency = String(product.currency || "").trim().toUpperCase();
    if (Number.isFinite(amount) && currency) {
      return { amount, currency, source: "product" };
    }
  }

  return null;
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
  const supplier =
    entry.price && entry.price.product && entry.price.product.price != null
      ? {
          amount: Number(entry.price.product.price),
          currency: String(entry.price.product.currency || "").trim().toUpperCase() || null,
        }
      : null;

  if (rawStatus === "free") {
    return {
      domain,
      available: true,
      status: "free",
      price,
      supplierPrice:
        supplier && Number.isFinite(supplier.amount) && supplier.currency
          ? supplier
          : null,
      isPremium,
    };
  }

  if (UNAVAILABLE_STATUSES.has(rawStatus)) {
    return {
      domain,
      available: false,
      // Normalize Openprovider "active" (registered) to a clear unavailable status.
      status: rawStatus === "active" ? "in use" : rawStatus,
      price,
      supplierPrice:
        supplier && Number.isFinite(supplier.amount) && supplier.currency
          ? supplier
          : null,
      isPremium,
    };
  }

  return {
    domain,
    available: false,
    status: rawStatus || "unknown",
    price,
    supplierPrice:
      supplier && Number.isFinite(supplier.amount) && supplier.currency
        ? supplier
        : null,
    isPremium,
    error: "unknown_status",
  };
}

function domainExtension(domain) {
  const parts = String(domain || "").toLowerCase().split(".");
  if (parts.length < 2) {
    return "";
  }
  return parts.slice(1).join(".");
}

function extensionRank(domain) {
  const extension = domainExtension(domain);
  const standardIndex = STANDARD_EXTENSIONS.indexOf(extension);
  if (standardIndex !== -1) {
    return standardIndex;
  }
  const extraIndex = EXTRA_EXTENSIONS.indexOf(extension);
  if (extraIndex !== -1) {
    return STANDARD_EXTENSIONS.length + extraIndex;
  }
  return STANDARD_EXTENSIONS.length + EXTRA_EXTENSIONS.length + 5;
}

function sortDomainResults(results) {
  return [...results].sort((a, b) => {
    // Standard available TLDs first, then other available TLDs.
    const rankDiff = extensionRank(a.domain) - extensionRank(b.domain);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    if (Boolean(a.isPremium) !== Boolean(b.isPremium)) {
      return a.isPremium ? 1 : -1;
    }
    return String(a.domain || "").localeCompare(String(b.domain || ""));
  });
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

    const mapped = requests.map((requested) => {
      const key = `${requested.name}.${requested.extension}`.toLowerCase();
      const entry = byDomain.get(key);
      if (!entry) {
        return {
          domain: key,
          available: false,
          status: "unknown",
          price: null,
          supplierPrice: null,
          isPremium: false,
          error: "missing_result",
        };
      }
      return mapDomainResult(entry, requested);
    });

    // Product rule: only show domains Openprovider confirmed as free/available.
    // Standard TLDs first, then other available TLDs.
    const results = sortDomainResults(mapped.filter((item) => item.available === true));

    return { status: 200, body: { success: true, results } };
  } catch (error) {
    const code = error && error.code ? error.code : "openprovider_check_failed";
    console.error(`domain search failed: ${code}`);
    const status =
      code === "openprovider_timeout" || code === "openprovider_unreachable"
        ? 504
        : 502;

    const body = { success: false, error: code };
    if (code === "openprovider_access_denied" || code === "openprovider_auth_failed") {
      const egressIp = await detectEgressIp(options.fetchImpl || fetch);
      if (egressIp) {
        body.serverIp = egressIp;
      }
      // Railway egress IPs rotate. Whitelisting one IP is not a stable fix.
      body.hint =
        "Clear Openprovider API whitelist AND blacklist completely (leave both empty). Do not paste a single Railway IP.";
    }
    return { status, body };
  }
}

async function domainDiagnostics(options = {}) {
  const env = options.env || process.env;
  const client = createOpenproviderClient({ env, fetchImpl: options.fetchImpl });
  const config = client.readConfig();
  const egressIp = await detectEgressIp(options.fetchImpl || fetch);

  if (config.error) {
    return {
      status: 200,
      body: {
        configured: false,
        error: config.error,
        serverIp: egressIp,
        loginIp: "0.0.0.0",
      },
    };
  }

  try {
    await client.login({ force: true });
    return {
      status: 200,
      body: {
        configured: true,
        loginOk: true,
        serverIp: egressIp,
        loginIp: "0.0.0.0",
        baseUrl: config.baseUrl,
      },
    };
  } catch (error) {
    return {
      status: 200,
      body: {
        configured: true,
        loginOk: false,
        error: error && error.code ? error.code : "openprovider_auth_failed",
        serverIp: egressIp,
        loginIp: "0.0.0.0",
        baseUrl: config.baseUrl,
      },
    };
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

  router.get("/diagnostics", limiter, async (_req, res) => {
    const result = await domainDiagnostics(options);
    res.status(result.status).json(result.body);
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
  EXTRA_EXTENSIONS,
  STANDARD_EXTENSIONS,
  createDomainsRouter,
  domainDiagnostics,
  extractPrice,
  mapDomainResult,
  normalizeExtension,
  normalizeName,
  searchDomains,
  sortDomainResults,
  validateDomainSearch,
};

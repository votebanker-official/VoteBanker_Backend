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
// Openprovider rejects more than ~15 domains per /domains/check call.
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_CHECK_CONCURRENCY = 4;
// 0 = no cap (use full Openprovider TLD catalog).
const DEFAULT_MAX_EXTENSIONS = 0;

// 1–63 chars, alphanumeric edges, hyphens allowed in the middle.
const LABEL_PATTERN = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/;
const EXTENSION_PATTERN = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)(?:\.(?:[a-z0-9]+(?:-[a-z0-9]+)*))*$/;

function maxExtensions(env = process.env) {
  const raw = env.OPENPROVIDER_MAX_EXTENSIONS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_MAX_EXTENSIONS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return DEFAULT_MAX_EXTENSIONS;
  }
  return value;
}

function batchSize(env = process.env) {
  const value = Number(env.OPENPROVIDER_BATCH_SIZE);
  // Openprovider returns 701 when the batch is too large (~20+).
  if (Number.isInteger(value) && value >= 1 && value <= 15) {
    return value;
  }
  return DEFAULT_BATCH_SIZE;
}

function checkConcurrency(env = process.env) {
  const value = Number(env.OPENPROVIDER_CHECK_CONCURRENCY);
  if (Number.isInteger(value) && value >= 1 && value <= 8) {
    return value;
  }
  return DEFAULT_CHECK_CONCURRENCY;
}

function normalizeName(raw) {
  let value = String(raw || "").trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "");
  value = value.replace(/^www\./, "");
  value = value.split("/")[0].split("?")[0].split("#")[0];
  value = value.replace(/\.+$/, "");

  // If the client pasted a full domain with a known extension, keep only the label.
  const known = [...STANDARD_EXTENSIONS, ...EXTRA_EXTENSIONS].sort((a, b) => b.length - a.length);
  for (const extension of known) {
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

  const wantsAllTlds =
    source.allTlds === true ||
    source.all_tlds === true ||
    source.extensions === undefined ||
    source.extensions === null;

  if (wantsAllTlds) {
    return { value: { name, useCatalog: true, extensions: null } };
  }

  if (!Array.isArray(source.extensions) || source.extensions.length === 0) {
    return { error: "invalid_extensions" };
  }

  const normalized = [];
  const seen = new Set();
  for (const item of source.extensions) {
    const extension = normalizeExtension(item);
    if (!extension || !EXTENSION_PATTERN.test(extension)) {
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
  const max = maxExtensions(env);
  if (max > 0 && normalized.length > max) {
    return { error: "too_many_extensions" };
  }

  return { value: { name, useCatalog: false, extensions: normalized } };
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

function sortDomainResults(results) {
  return [...results].sort((a, b) => {
    const aExt = domainExtension(a.domain);
    const bExt = domainExtension(b.domain);
    const aStandard = STANDARD_EXTENSIONS.indexOf(aExt);
    const bStandard = STANDARD_EXTENSIONS.indexOf(bExt);
    const aIsStandard = aStandard !== -1;
    const bIsStandard = bStandard !== -1;

    if (aIsStandard !== bIsStandard) {
      return aIsStandard ? -1 : 1;
    }
    if (aIsStandard && bIsStandard && aStandard !== bStandard) {
      return aStandard - bStandard;
    }
    if (Boolean(a.isPremium) !== Boolean(b.isPremium)) {
      return a.isPremium ? 1 : -1;
    }
    return aExt.localeCompare(bExt) || String(a.domain || "").localeCompare(String(b.domain || ""));
  });
}

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

function prioritizeExtensions(extensions) {
  const seen = new Set();
  const ordered = [];
  for (const extension of STANDARD_EXTENSIONS) {
    if (extensions.includes(extension) && !seen.has(extension)) {
      seen.add(extension);
      ordered.push(extension);
    }
  }
  const rest = extensions
    .filter((extension) => !seen.has(extension))
    .sort((a, b) => a.localeCompare(b));
  for (const extension of rest) {
    seen.add(extension);
    ordered.push(extension);
  }
  return ordered;
}

async function resolveExtensions(parsed, client, env) {
  if (!parsed.useCatalog) {
    return prioritizeExtensions(parsed.extensions);
  }

  const catalog = await client.listActiveTldNames();
  const merged = prioritizeExtensions([
    ...STANDARD_EXTENSIONS,
    ...catalog,
  ]);
  const max = maxExtensions(env);
  if (max > 0 && merged.length > max) {
    // Keep all standard TLDs, then fill with catalog order.
    const standard = merged.filter((item) => STANDARD_EXTENSIONS.includes(item));
    const rest = merged.filter((item) => !STANDARD_EXTENSIONS.includes(item));
    return [...standard, ...rest].slice(0, max);
  }
  return merged;
}

async function checkAllDomains(client, requests, env) {
  const batches = chunk(requests, batchSize(env));
  const concurrency = checkConcurrency(env);

  // Phase 1: availability only (faster / lighter than priced checks).
  const availabilityBatches = await mapPool(batches, concurrency, (batch) =>
    client.checkDomains(batch, { withPrice: false })
  );
  const availability = availabilityBatches.flat();

  const freeRequests = [];
  for (const entry of availability) {
    if (entry && String(entry.status || "").toLowerCase() === "free") {
      const domain = String(entry.domain || "").toLowerCase();
      const parts = domain.split(".");
      if (parts.length >= 2) {
        freeRequests.push({
          name: parts[0],
          extension: parts.slice(1).join("."),
        });
      }
    }
  }

  if (freeRequests.length === 0) {
    return [];
  }

  // Phase 2: priced checks only for free domains.
  const pricedBatches = await mapPool(chunk(freeRequests, batchSize(env)), concurrency, (batch) =>
    client.checkDomains(batch, { withPrice: true })
  );
  return pricedBatches.flat();
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

  try {
    const extensions = await resolveExtensions(parsed.value, client, env);
    const requests = extensions.map((extension) => ({
      name: parsed.value.name,
      extension,
    }));

    const upstream = await checkAllDomains(client, requests, env);
    const results = sortDomainResults(
      upstream
        .map((entry) => mapDomainResult(entry))
        .filter((item) => item.available === true)
    );

    return {
      status: 200,
      body: {
        success: true,
        checked: requests.length,
        results,
      },
    };
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

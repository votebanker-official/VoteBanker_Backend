const express = require("express");

const clients = require("../lib/clients");
const {
  connectionConfigured,
  decryptToken,
  finishConnect,
  publicConnection,
  revokeBestEffort,
  startConnect,
} = require("../social_connections");

const router = express.Router();

async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    const { data, error } = await clients.getSupabasePublic().auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "unauthorized" });
    req.user = data.user;
    next();
  } catch (err) {
    next(err);
  }
}

function admin() {
  return clients.getSupabaseAdmin();
}

async function listRows(userId) {
  const { data, error } = await admin()
    .from("social_account_connections")
    .select(
      "provider,account_id,account_name,account_username,metadata,status,access_token_enc"
    )
    .eq("profile_id", userId);
  if (error) {
    const missing = /social_account_connections|schema cache|PGRST205/i.test(error.message || "");
    const err = new Error(missing ? "storage_not_ready" : "load_failed");
    err.code = err.message;
    throw err;
  }
  return data || [];
}

router.get("/", requireUser, async (req, res, next) => {
  try {
    const rows = await listRows(req.user.id);
    res.json({
      connections: rows.map((row) => publicConnection(row)),
    });
  } catch (err) {
    if (err.code === "storage_not_ready") {
      return res.status(503).json({ error: "storage_not_ready" });
    }
    next(err);
  }
});

router.post("/:provider/start", requireUser, (req, res) => {
  try {
    const authorizeUrl = startConnect({
      provider: req.params.provider,
      userId: req.user.id,
      returnTo: req.body && req.body.return_to,
      req,
    });
    res.json({ authorizeUrl, configured: connectionConfigured(req.params.provider) });
  } catch (err) {
    const status =
      err.code === "not_found" ? 404 : err.code === "invalid_return" ? 400 : err.code === "not_configured" ? 503 : 500;
    if (status === 500) return res.status(500).json({ error: "server_error" });
    res.status(status).json({ error: err.code });
  }
});

router.delete("/:provider", requireUser, async (req, res, next) => {
  try {
    const rows = await listRows(req.user.id);
    const row = rows.find((item) => item.provider === req.params.provider);
    if (row && row.access_token_enc) {
      const token = decryptToken(row.access_token_enc);
      await revokeBestEffort(req.params.provider, token);
    }
    const { error } = await admin()
      .from("social_account_connections")
      .delete()
      .eq("profile_id", req.user.id)
      .eq("provider", req.params.provider);
    if (error) return res.status(503).json({ error: "storage_not_ready" });
    res.json({ disconnected: true, provider: req.params.provider });
  } catch (err) {
    if (err.code === "storage_not_ready") {
      return res.status(503).json({ error: "storage_not_ready" });
    }
    next(err);
  }
});

async function saveConnection(row) {
  const { error } = await admin()
    .from("social_account_connections")
    .upsert(row, { onConflict: "profile_id,provider" });
  if (error) {
    const err = new Error("storage_not_ready");
    err.code = "storage_not_ready";
    throw err;
  }
}

module.exports = {
  createSocialConnectionsRouter: () => router,
  saveConnection,
  finishConnect,
};

const express = require("express");

const { authenticate } = require("../admin/access");
const { createSupabaseRepository, csvFor } = require("../admin/repository");

const REPORTS = new Set(["overview", "clients", "revenue", "purchases", "engagement", "campaigns"]);

function createAdminRouter(options = {}) {
  const router = express.Router();
  const repo = options.repo || createSupabaseRepository();
  const resolveUser = options.authenticate || authenticate;

  router.use(async (req, res, next) => {
    try {
      const user = await resolveUser(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      const access = await repo.accessFor(user);
      if (!access.admin) return res.status(403).json({ error: "forbidden" });
      req.user = user;
      req.adminAccess = access;
      next();
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/me", (req, res) => {
    res.json({
      role: "admin",
      degraded: Boolean(req.adminAccess && req.adminAccess.degraded),
      profile: req.adminAccess && req.adminAccess.profile
        ? { id: req.adminAccess.profile.id, fullName: req.adminAccess.profile.full_name || "" }
        : null,
    });
  });

  router.get("/overview", async (req, res, next) => {
    try {
      res.json(await repo.overview(req.query.range));
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/clients", async (req, res, next) => {
    try {
      res.json(await repo.listClients(req.query));
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/clients/:id", async (req, res, next) => {
    try {
      const client = await repo.getClient(req.params.id);
      if (!client) return res.status(404).json({ error: "not_found" });
      res.json(client);
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/activity", async (req, res, next) => {
    try {
      res.json(await repo.listActivity(req.query));
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/purchases", async (req, res, next) => {
    try {
      res.json(await repo.listPurchases(req.query));
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/purchases.csv", async (req, res, next) => {
    try {
      await sendCsv(res, await repo.report("purchases", { ...req.query, page: 1, pageSize: 1000 }), "purchases.csv");
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/payments", async (req, res, next) => {
    try {
      const report = await repo.listPayments(req.query);
      res.json(report);
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/campaigns", async (req, res, next) => {
    try {
      res.json(await repo.listCampaigns(req.query));
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/users", async (req, res, next) => {
    try {
      res.json(await repo.listUsers(req.query));
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.patch("/users/:id", async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const user = await repo.updateUser(req.user, req.params.id, {
        app_role: body.app_role || body.role,
        account_status: body.account_status || body.status,
      });
      res.json({ user });
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/reports", async (req, res, next) => {
    try {
      const kind = REPORTS.has(req.query.kind) ? req.query.kind : "overview";
      res.json(await repo.report(kind, req.query));
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/reports.csv", async (req, res, next) => {
    try {
      const kind = REPORTS.has(req.query.kind) ? req.query.kind : "overview";
      await sendCsv(res, await repo.report(kind, req.query), `${kind}.csv`);
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  router.get("/audit", async (req, res, next) => {
    try {
      res.json(await repo.listAudit(req.query));
    } catch (err) {
      sendAdminError(res, err, next);
    }
  });

  return router;
}

function sendCsv(res, report, filename) {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csvFor(report));
}

function sendAdminError(res, err, next) {
  if (err.code === "forbidden") return res.status(403).json({ error: "forbidden" });
  if (err.code === "admin_not_ready") return res.status(503).json({ error: "admin_not_ready" });
  if (err.status) return res.status(err.status).json({ error: err.code || "request_failed" });
  return next(err);
}

module.exports = { createAdminRouter };

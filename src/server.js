require("dotenv").config();
const { installSystemCertificates } = require("./lib/system_certs");
const trustedRoots = installSystemCertificates();
if (trustedRoots) {
  console.log(`trusting ${trustedRoots} operating-system certificate roots`);
}
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const locationRoutes = require("./routes/locations");
const profileRoutes = require("./routes/profile");
const websiteRoutes = require("./routes/websites");

const { loadEnv } = require("./env");
const { createMerchandiseRouter } = require("./merchandise");
const { createSpeechesRouter } = require("./speeches");
const { createLettersRouter } = require("./letters");
const { createDomainsRouter } = require("./domains");
const { createVrmRouter } = require("./routes/vrm");
const { createSocialMediaRouter } = require("./routes/social_media");
const { createSocialConnectionsRouter } = require("./routes/social_connections");
const { createVolunteersRouter } = require("./volunteers");
const { createTeamMembersRouter } = require("./team_members");
const { createAdminRouter } = require("./routes/admin");
const { createBlueTikRouter } = require("./routes/blue_tik");
const { createCampaignMediaRouter } = require("./routes/campaign_media");

loadEnv();

const app = express();
const port = process.env.PORT || 5000;

// The backend runs behind one trusted reverse proxy in production.
app.set("trust proxy", 1);

app.use(
  helmet({
    // The Flutter web app calls this API from another local origin.
    // same-origin would hide every response, including the admin check.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
// Website drafts can include structured content; media base64 stays off the wire.
app.use(express.json({ limit: "1mb" }));

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function isLocalDevOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(origin || ""));
}

function isAllowedOrigin(origin) {
  // Non-browser clients (no Origin header).
  if (!origin) {
    return true;
  }
  // Empty CORS_ORIGINS = allow all (local default).
  if (allowedOrigins.length === 0) {
    return true;
  }
  if (allowedOrigins.includes(origin)) {
    return true;
  }
  // Flutter web / Chrome local debugging against a remote API.
  if (isLocalDevOrigin(origin)) {
    return true;
  }
  return false;
}

app.use((req, res, next) => {
  // Chrome blocks a localhost page from calling 127.0.0.1 unless this is set.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  next();
});

app.use(
  cors({
    origin: (origin, cb) => {
      // Never throw here: thrown errors skip CORS headers and break browser preflight.
      if (isAllowedOrigin(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
  })
);

app.use("/api", rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

app.get("/", (_req, res) => {
  res.json({
    service: "VOTE BANKER backend",
    status: "running",
    endpoints: [
      "GET /api/health",
      "POST /api/auth/otp/send",
      "POST /api/auth/otp/verify",
      "POST /api/auth/password-reset/request",
      "POST /api/auth/password-reset/complete",
      "GET /api/auth/oauth/:provider/start",
      "GET /api/auth/oauth/callback",
      "POST /api/auth/oauth/exchange",
      "GET|PUT /api/profile",
      "GET|PUT /api/websites/me",
      "POST /api/websites/generate",
      "POST /api/websites/me/publish",
      "GET /api/location/countries",
      "GET /api/location/states",
      "GET /api/location/districts",
      "GET /api/location/assembly-constituencies",
      "GET /api/merchandise/products",
      "GET|POST /api/merchandise/orders",
      "POST /api/speeches/generate",
      "POST /api/letters/generate",
      "POST /api/domains/search",
      "GET /api/domains/diagnostics",
      "GET /api/vrm/records",
      "POST /api/vrm/package-requests",
      "PATCH /api/vrm/records/:id/contacts",
      "GET /api/social-connections",
      "POST /api/social-connections/:provider/start",
      "DELETE /api/social-connections/:provider",
      "GET /api/social-media/contacts",
      "GET /api/social-media/integrations",
      "POST /api/social-media/posts",
      "POST /api/social-media/captions",
      "POST /api/vrm/import/preview-ocr",
      "POST /api/vrm/import/confirm",
      "GET /api/volunteers/stats",
      "GET /api/volunteers/overview",
      "GET|POST /api/volunteers/volunteers",
      "GET|PATCH|DELETE /api/volunteers/volunteers/:id",
      "GET|POST /api/volunteers/tasks",
      "PATCH /api/volunteers/tasks/:id",
      "GET|POST /api/volunteers/applications",
      "POST /api/volunteers/applications/:id/review",
      "GET /api/volunteers/teams",
      "GET|POST /api/team-members",
      "GET|PATCH|DELETE /api/team-members/:id",
      "GET /api/auth/me",
      "GET /api/admin/me",
      "GET /api/admin/overview",
      "GET /api/admin/clients",
      "GET /api/admin/profiles",
      "GET /api/admin/voter-lists",
      "POST /api/blue-tik/requests",
      "GET /api/admin/blue-tik",
      "GET /api/admin/purchases",
      "GET /api/admin/payments",
      "GET /api/campaign-media",
      "POST|DELETE /api/campaign-media/logo",
      "POST /api/campaign-media/photos",
      "DELETE /api/campaign-media/photos/:id",
    ],
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "VOTE BANKER backend",
  });
});

app.use("/api/auth", authRoutes);
app.get("/auth/callback", authRoutes.oauthCallback);
app.post(
  "/auth/callback",
  express.urlencoded({ extended: false, limit: "20kb" }),
  authRoutes.oauthCallback
);
app.use("/api/profile", profileRoutes);
app.use("/api/websites", websiteRoutes);
app.use("/api/location", locationRoutes);
app.use("/api/merchandise", createMerchandiseRouter());
app.use("/api/speeches", createSpeechesRouter());
app.use("/api/letters", createLettersRouter());
app.use("/api/domains", createDomainsRouter());
app.use("/api/vrm", createVrmRouter());
app.use("/api/social-connections", createSocialConnectionsRouter());
app.use("/api/social-media", createSocialMediaRouter());
app.use("/api/volunteers", createVolunteersRouter());
app.use("/api/team-members", createTeamMembersRouter());
app.use("/api/admin", createAdminRouter());
app.use("/api/blue-tik", createBlueTikRouter());
app.use("/api/campaign-media", createCampaignMediaRouter());

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("server_error", {
    message: err.message,
    code: err.code,
    detail: err.detail,
    hint: err.hint,
    stack: err.stack,
  });
  res.status(500).json({ error: "server_error" });
});

const server = app.listen(port, () => {
  console.log(`VOTE BANKER backend listening on port ${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use. Another process is listening on ${port}. Stop that process, then run npm run dev again.`,
    );
    process.exit(1);
  }
  console.error(error.message);
  process.exit(1);
});

function closeServer() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", closeServer);
process.once("SIGTERM", closeServer);

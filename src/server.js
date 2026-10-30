require("dotenv").config();

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
const { createVolunteersRouter } = require("./volunteers");

loadEnv();

const app = express();
const port = process.env.PORT || 5000;

// Railway sits behind a proxy; needed for correct client IPs in rate limiting.
app.set("trust proxy", 1);

app.use(helmet());
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
  // Flutter web / Chrome local debugging against Railway.
  if (isLocalDevOrigin(origin)) {
    return true;
  }
  return false;
}

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
      "PATCH /api/vrm/records/:id/contacts",
      "GET /api/social-media/contacts",
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
app.use("/api/profile", profileRoutes);
app.use("/api/websites", websiteRoutes);
app.use("/api/location", locationRoutes);
app.use("/api/merchandise", createMerchandiseRouter());
app.use("/api/speeches", createSpeechesRouter());
app.use("/api/letters", createLettersRouter());
app.use("/api/domains", createDomainsRouter());
app.use("/api/vrm", createVrmRouter());
app.use("/api/social-media", createSocialMediaRouter());
app.use("/api/volunteers", createVolunteersRouter());

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: "server_error" });
});

app.listen(port, () => {
  console.log(`VOTE BANKER backend listening on port ${port}`);
});

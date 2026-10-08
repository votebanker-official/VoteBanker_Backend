require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const locationRoutes = require("./routes/locations");
const profileRoutes = require("./routes/profile");

const { loadEnv } = require("./env");
const { createMerchandiseRouter } = require("./merchandise");
const { createSpeechesRouter } = require("./speeches");
const { createLettersRouter } = require("./letters");

loadEnv();

const app = express();
const port = process.env.PORT || 5000;

// Railway sits behind a proxy; needed for correct client IPs in rate limiting.
app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json({ limit: "100kb" }));

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow non-browser clients (no Origin header) and listed origins.
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error("Origin not allowed"));
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
      "GET|PUT /api/profile",
      "GET /api/location/countries",
      "GET /api/location/states",
      "GET /api/location/districts",
      "GET /api/location/assembly-constituencies",
      "GET /api/merchandise/products",
      "GET|POST /api/merchandise/orders",
      "POST /api/speeches/generate",
      "POST /api/letters/generate",
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
app.use("/api/location", locationRoutes);
app.use("/api/merchandise", createMerchandiseRouter());
app.use("/api/speeches", createSpeechesRouter());
app.use("/api/letters", createLettersRouter());

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err.message);
  if (err.message === "Origin not allowed") {
    return res.status(403).json({ error: "origin_not_allowed" });
  }
  res.status(500).json({ error: "server_error" });
});

app.listen(port, () => {
  console.log(`VOTE BANKER backend listening on port ${port}`);
});

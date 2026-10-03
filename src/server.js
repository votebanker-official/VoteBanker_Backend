const express = require("express");

const { loadEnv } = require("./env");
const { createMerchandiseRouter } = require("./merchandise");

loadEnv();

const app = express();
const port = process.env.PORT || 5000;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const permit = !origin || allowed.length === 0 || allowed.includes(origin);
  if (permit) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "VOTE BANKER backend",
  });
});

app.use("/api/merchandise", createMerchandiseRouter());

app.listen(port, () => {
  console.log(`VOTE BANKER backend listening on port ${port}`);
});

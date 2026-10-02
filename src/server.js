const express = require("express");

const app = express();
const port = process.env.PORT || 5000;

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "VOTE BANKER backend",
  });
});

app.listen(port, () => {
  console.log(`VOTE BANKER backend listening on port ${port}`);
});

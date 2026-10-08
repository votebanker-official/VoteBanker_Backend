const express = require("express");

const {
  countries,
  statesForCountry,
  districtsForState,
  assemblyConstituenciesForDistrict,
  districtById,
} = require("../locations");

const router = express.Router();

router.get("/countries", (_req, res) => {
  res.json({ data: countries() });
});

router.get("/states", (req, res) => {
  const data = statesForCountry(req.query.country);
  if (!data) return res.status(400).json({ error: "invalid_country" });
  res.json({ data });
});

router.get("/districts", (req, res) => {
  const data = districtsForState(req.query.state_id);
  if (!data) return res.status(400).json({ error: "invalid_state" });
  res.json({ data });
});

router.get("/assembly-constituencies", (req, res) => {
  const districtId = Number(req.query.district_id);
  const district = districtById.get(districtId);
  if (!Number.isInteger(districtId) || !district) {
    return res.status(400).json({ error: "invalid_district" });
  }
  if (
    req.query.state_id != null &&
    req.query.state_id !== "" &&
    Number(req.query.state_id) !== district.state_id
  ) {
    return res.status(400).json({ error: "district_state_mismatch" });
  }
  const result = assemblyConstituenciesForDistrict(districtId);
  res.status(result.status).json({ error: result.error, data: [] });
});

module.exports = router;

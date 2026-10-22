const express = require("express");

const {
  countries,
  statesForCountry,
  districtsForState,
  assemblyConstituenciesForDistrict,
  assemblyConstituenciesForNames,
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

function sendAssemblyResult(res, result) {
  if (result.error) {
    return res.status(result.status).json({ error: result.error, data: [] });
  }
  return res.json({ data: result.data });
}

router.get("/assembly-constituencies", (req, res) => {
  const stateName = req.query.state;
  const districtName = req.query.district;
  if (
    (typeof stateName === "string" && stateName.trim()) ||
    (typeof districtName === "string" && districtName.trim())
  ) {
    return sendAssemblyResult(res, assemblyConstituenciesForNames(stateName, districtName));
  }

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
  return sendAssemblyResult(res, assemblyConstituenciesForDistrict(districtId));
});

module.exports = router;
